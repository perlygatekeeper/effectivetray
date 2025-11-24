// <copyright file="damage-application.mjs" company="alterNERDtive">
// Copyright 2025 alterNERDtive.
//
// This file is part of the Effective Tray NG Foundry module.
//
// The Effective Tray NG Foundry module is free software: you can distribute
// it and/or modify it under the terms of the GNU General Public License as
// published by the Free Software Foundation, either version 3 of the License,
// or (at your option) any later version.
//
// The EffectiveTray NG Foundry module is distributed in the hope that it will
// be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with
// the EffectiveTray NG Foundry module.  If not, see
// &lt;https://www.gnu.org/licenses/&gt;.
// </copyright>

import { MODULE, SOCKET_ID } from "./const.mjs";
import { EffectiveTray } from "./effective-tray.mjs";

/* -------------------------------------------- */
/*  Damage Application Extension (from dnd5e)   */
/*  Refer to dnd5e for full documentation       */
/* -------------------------------------------- */

const MULTIPLIERS = [[-1, "-1"], [0, "0"], [.25, "¼"], [.5, "½"], [1, "1"], [2, "2"]];

export default class EffectiveDamageApplication {

  static init() {
    /**
     * Add the damage tray for players.
     * @param {ChatMessage5e} message The message on which the tray resides.
     * @param {HTMLElement} html      HTML contents of the message.
     */
    Hooks.on("dnd5e.renderChatMessage", (message, html) => {
      if (!message.isContentVisible || game.user.isGM) return;
      const rolls = message.rolls.filter(r => r instanceof CONFIG.Dice.DamageRoll);
      if (!rolls.length) return;
      const damageApplication = document.createElement("damage-application");
      if (game.settings.get("dnd5e", "autoCollapseChatTrays") !== "always") {
        damageApplication.setAttribute("open", "");
      }
      damageApplication.damages = dnd5e.dice.aggregateDamageRolls(rolls, { respectProperties: true }).map(roll => ({
        value: roll.total,
        type: roll.options.type,
        properties: new Set(roll.options.properties ?? [])
      }));
      html.querySelector(".message-content").appendChild(damageApplication);
    });

    libWrapper.register("effectivetray-ng", "dnd5e.applications.components.DamageApplicationElement.prototype.buildTargetListEntry", function({ uuid, name }) {
      // Override checking isOwner
      const actor = fromUuidSync(uuid);
      if (!game.settings.get(MODULE, "damageTarget") && !actor?.isOwner) return;

      // Calculate damage to apply
      const targetOptions = this.getTargetOptions(uuid);
      const { temp, total, active } = this.calculateDamage(actor, targetOptions);

      const types = [];
      for (const [change, values] of Object.entries(active)) {
        if ( foundry.utils.getType(values) !== "Set" ) continue;
        for (const type of values) {
          const config = CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type];
          if (!config) continue;
          const data = { type, change, icon: config.icon };
          types.push(data);
        }
      }
      const changeSources = types.reduce((acc, config) => acc + this.getChangeSourceOptions(config, targetOptions), "");

      const li = document.createElement("li");
      li.classList.add("target");
      li.dataset.targetUuid = uuid;
      li.innerHTML = `
        <img class="gold-icon">
        <div class="name-stacked">
          <span class="title"></span>
          <span class="subtitle">${changeSources}</span>
        </div>
        <div class="calculated damage">
          ${total}
        </div>
        <div class="calculated temp" data-tooltip="DND5E.HitPointsTemp">
          ${temp}
        </div>
        <menu class="damage-multipliers unlist"></menu>
      `;
      Object.assign(li.querySelector(".gold-icon"), { alt: name, src: actor.img });
      li.querySelector(".name-stacked .title").append(name);

      const menu = li.querySelector("menu");
      for (const [value, display] of MULTIPLIERS) {
        const entry = document.createElement("li");
        entry.innerHTML = `
          <button class="multiplier-button" type="button" value="${value}">
            <span>${display}</span>
          </button>
        `;
        menu.append(entry);
      }

      this.refreshListEntry(actor, li, targetOptions);
      li.addEventListener("click", this._onChangeOptions.bind(this));

      return li;
    }, libWrapper.OVERRIDE);

    libWrapper.register("effectivetray-ng", "dnd5e.applications.components.DamageApplicationElement.prototype.connectedCallback", function(wrapped){
      wrapped();

      // Override to hide target selection if there are no targets
      if (!game.settings.get(MODULE, "damageTarget")) {
        const targets = this.chatMessage.getFlag("dnd5e", "targets");
        const ownership = EffectiveTray.ownershipCheck(targets);
        if (!ownership) this.targetSourceControl.hidden = true;
      };
    }, libWrapper.WRAPPER);

    libWrapper.register("effectivetray-ng", "dnd5e.applications.components.DamageApplicationElement.prototype._onApplyDamage", async function(...args) {
      event.preventDefault();
      for ( const target of this.targetList.querySelectorAll("[data-target-uuid]") ) {
        const id = target.dataset.targetUuid;
        const token = fromUuidSync(id);
        const options = this.getTargetOptions(id);
        if (token?.isOwner) {
          await token?.applyDamage(this.damages, { ...options, isDelta: true });
        }
        else {
          // Override to convert damage properties to an Array for socket emission
          if (!game.settings.get(MODULE, 'damageTarget')) return;
          if (!game.users.activeGM) return ui.notifications.warn(game.i18n.localize("EFFECTIVETRAY.NOTIFICATION.NoActiveGMDamage"));
          const damage = [];
          foundry.utils.deepClone(this.damages).forEach(d => {
            foundry.utils.mergeObject(d, { properties: Array.from(d.properties) });
            damage.push(d);
          });
          const opts = foundry.utils.deepClone(options);
          if (opts?.downgrade) foundry.utils.mergeObject(opts, { downgrade: Array.from(opts.downgrade) });
          if (opts?.ignore?.immunity) foundry.utils.mergeObject(opts, { "ignore.immunity": Array.from(opts.ignore.immunity) });
          if (opts?.ignore?.resistance) foundry.utils.mergeObject(opts, { "ignore.resistance": Array.from(opts.ignore.resistance) });
          if (opts?.ignore?.vulnerability) foundry.utils.mergeObject(opts, { "ignore.vulnerability": Array.from(opts.ignore.vulnerability) });
          if (opts?.ignore?.modification) foundry.utils.mergeObject(opts, { "ignore.modification": Array.from(opts.ignore.modification) });
          await game.socket.emit(SOCKET_ID, { type: "damage", data: { id, opts, damage } });
        }
      }
      if ( game.settings.get("dnd5e", "autoCollapseChatTrays") !== "manual" ) {
        this.open = false;
      }
    }, libWrapper.OVERRIDE);
  }
}
