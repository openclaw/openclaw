var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Code, Eye } from "lucide";
import { i18n } from "./i18n.js";
import { icon } from "./icons.js";
let PreviewCodeToggle = class PreviewCodeToggle extends LitElement {
    constructor() {
        super(...arguments);
        this.mode = "preview";
    }
    createRenderRoot() {
        return this; // light DOM for shared styles
    }
    setMode(mode) {
        if (this.mode !== mode) {
            this.mode = mode;
            this.dispatchEvent(new CustomEvent("mode-change", { detail: this.mode, bubbles: true }));
        }
    }
    render() {
        const isPreview = this.mode === "preview";
        return html `
         <div class="inline-flex items-center h-7 rounded-md overflow-hidden border border-border bg-muted/60">
            <button
               class="px-2 h-full flex items-center ${isPreview ? "bg-card text-foreground" : "text-muted-foreground hover:text-accent-foreground"}"
               @click=${() => this.setMode("preview")}
               title="${i18n("Preview")}"
            >
               ${icon(Eye, "sm")}
            </button>
            <button
               class="px-2 h-full flex items-center ${!isPreview ? "bg-card text-foreground" : "text-muted-foreground hover:text-accent-foreground"}"
               @click=${() => this.setMode("code")}
               title="${i18n("Code")}"
            >
               ${icon(Code, "sm")}
            </button>
         </div>
      `;
    }
};
__decorate([
    property({ reflect: false })
], PreviewCodeToggle.prototype, "mode", void 0);
PreviewCodeToggle = __decorate([
    customElement("preview-code-toggle")
], PreviewCodeToggle);
export { PreviewCodeToggle };
//# sourceMappingURL=PreviewCodeToggle.js.map