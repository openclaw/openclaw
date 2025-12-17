var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { i18n } from "./i18n.js";
let ModeToggle = class ModeToggle extends LitElement {
    constructor() {
        super(...arguments);
        this.modes = [i18n("Mode 1"), i18n("Mode 2")];
        this.selectedIndex = 0;
    }
    createRenderRoot() {
        return this; // light DOM for shared styles
    }
    setMode(index) {
        if (this.selectedIndex !== index && index >= 0 && index < this.modes.length) {
            this.selectedIndex = index;
            this.dispatchEvent(new CustomEvent("mode-change", {
                detail: { index, mode: this.modes[index] },
                bubbles: true,
            }));
        }
    }
    render() {
        if (this.modes.length < 2)
            return html ``;
        return html `
         <div class="inline-flex items-center h-7 rounded-md overflow-hidden border border-border bg-muted/60">
            ${this.modes.map((mode, index) => html `
                  <button
                     class="px-3 h-full flex items-center text-sm font-medium transition-colors
								${index === this.selectedIndex
            ? "bg-card text-foreground shadow-sm"
            : "text-muted-foreground hover:text-accent-foreground"}"
                     @click=${() => this.setMode(index)}
                     title="${mode}"
                  >
                     ${mode}
                  </button>
               `)}
         </div>
      `;
    }
};
__decorate([
    property({ type: Array })
], ModeToggle.prototype, "modes", void 0);
__decorate([
    property({ type: Number })
], ModeToggle.prototype, "selectedIndex", void 0);
ModeToggle = __decorate([
    customElement("mode-toggle")
], ModeToggle);
export { ModeToggle };
//# sourceMappingURL=ModeToggle.js.map