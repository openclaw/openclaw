var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Globe } from "lucide";
import { Button } from "./Button.js";
import { getCurrentLanguage, setLanguage } from "./i18n.js";
import { icon } from "./icons.js";
let LanguageSelector = class LanguageSelector extends LitElement {
    constructor() {
        super(...arguments);
        this.currentLanguage = getCurrentLanguage();
        this.isOpen = false;
        this.languages = [
            { code: "en", label: "EN" },
            { code: "de", label: "DE" },
        ];
        this.handleClickOutside = (e) => {
            if (!this.contains(e.target)) {
                this.isOpen = false;
            }
        };
    }
    selectLanguage(code) {
        if (code !== this.currentLanguage) {
            setLanguage(code);
        }
        this.isOpen = false;
    }
    toggleDropdown() {
        this.isOpen = !this.isOpen;
    }
    connectedCallback() {
        super.connectedCallback();
        document.addEventListener("click", this.handleClickOutside);
    }
    disconnectedCallback() {
        document.removeEventListener("click", this.handleClickOutside);
        super.disconnectedCallback();
    }
    createRenderRoot() {
        return this;
    }
    render() {
        return html `
         <div class="relative">
            ${Button({
            variant: "ghost",
            size: "sm",
            onClick: () => this.toggleDropdown(),
            className: "gap-1.5",
            children: html `
                  ${icon(Globe, "sm")}
                  <span class="text-xs font-medium">${this.currentLanguage.toUpperCase()}</span>
               `,
        })}
            ${this.isOpen
            ? html `
                    <div
                       class="absolute right-0 mt-1 py-1 bg-popover border border-border rounded-md shadow-lg min-w-[80px] z-50"
                    >
                       ${this.languages.map((lang) => html `
                             <button
                                class="w-full px-3 py-1.5 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors
												${lang.code === this.currentLanguage ? "bg-accent/50 text-accent-foreground font-medium" : ""}"
                                @click=${() => this.selectLanguage(lang.code)}
                             >
                                ${lang.label}
                             </button>
                          `)}
                    </div>
                 `
            : ""}
         </div>
      `;
    }
};
__decorate([
    state()
], LanguageSelector.prototype, "currentLanguage", void 0);
__decorate([
    state()
], LanguageSelector.prototype, "isOpen", void 0);
LanguageSelector = __decorate([
    customElement("language-selector")
], LanguageSelector);
export { LanguageSelector };
//# sourceMappingURL=LanguageSelector.js.map