var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Check, Copy } from "lucide";
import { Button } from "./Button.js";
import { i18n } from "./i18n.js";
import { icon } from "./icons.js";
let CopyButton = class CopyButton extends LitElement {
    constructor() {
        super(...arguments);
        this.text = "";
        this.title = i18n("Copy");
        this.showText = false;
        this.copied = false;
    }
    createRenderRoot() {
        return this; // light DOM
    }
    async handleCopy() {
        try {
            await navigator.clipboard.writeText(this.text);
            this.copied = true;
            setTimeout(() => {
                this.copied = false;
            }, 2000);
        }
        catch (err) {
            console.error("Failed to copy:", err);
        }
    }
    render() {
        return Button({
            variant: "ghost",
            size: "sm",
            onClick: () => this.handleCopy(),
            title: this.title,
            children: html `
            ${this.copied ? icon(Check, "sm") : icon(Copy, "sm")}
            ${this.copied && this.showText ? html `<span>${i18n("Copied!")}</span>` : ""}
         `,
        });
    }
};
__decorate([
    property()
], CopyButton.prototype, "text", void 0);
__decorate([
    property()
], CopyButton.prototype, "title", void 0);
__decorate([
    property({ type: Boolean, attribute: "show-text" })
], CopyButton.prototype, "showText", void 0);
__decorate([
    state()
], CopyButton.prototype, "copied", void 0);
CopyButton = __decorate([
    customElement("copy-button")
], CopyButton);
export { CopyButton };
//# sourceMappingURL=CopyButton.js.map