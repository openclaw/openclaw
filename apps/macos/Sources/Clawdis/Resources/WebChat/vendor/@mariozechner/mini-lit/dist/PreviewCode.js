var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Button } from "./Button.js";
import { Card, CardContent } from "./Card.js";
let PreviewCode = class PreviewCode extends LitElement {
    constructor() {
        super(...arguments);
        this.preview = "";
        this.code = "";
        this.language = "typescript";
        this.className = "";
        this.showCode = false;
        this.toggleView = () => {
            this.showCode = !this.showCode;
        };
    }
    createRenderRoot() {
        return this; // Use light DOM for global styles
    }
    render() {
        return html `
         <div class="${this.className}">
            <!-- Toggle buttons -->
            <div class="flex gap-2 mb-4">
               ${Button({
            variant: this.showCode ? "ghost" : "default",
            size: "sm",
            onClick: () => {
                this.showCode = false;
            },
            children: "Preview",
        })}
               ${Button({
            variant: this.showCode ? "default" : "ghost",
            size: "sm",
            onClick: () => {
                this.showCode = true;
            },
            children: "Code",
        })}
            </div>

            <!-- Content -->
            ${Card({
            children: CardContent({
                children: this.showCode
                    ? html `<code-block language="${this.language}" code="${btoa(this.code)}"></code-block>`
                    : this.preview,
            }),
        })}
         </div>
      `;
    }
};
__decorate([
    property({ type: Object })
], PreviewCode.prototype, "preview", void 0);
__decorate([
    property({ type: String })
], PreviewCode.prototype, "code", void 0);
__decorate([
    property({ type: String })
], PreviewCode.prototype, "language", void 0);
__decorate([
    property({ type: String, attribute: "class-name" })
], PreviewCode.prototype, "className", void 0);
__decorate([
    state()
], PreviewCode.prototype, "showCode", void 0);
PreviewCode = __decorate([
    customElement("preview-code")
], PreviewCode);
export { PreviewCode };
//# sourceMappingURL=PreviewCode.js.map