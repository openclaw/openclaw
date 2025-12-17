var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var PromptDialog_1;
import { html } from "lit";
import { customElement } from "lit/decorators/custom-element.js";
import { property } from "lit/decorators/property.js";
import { state } from "lit/decorators/state.js";
import { createRef } from "lit/directives/ref.js";
import { Button } from "./Button.js";
import { DialogContent, DialogFooter, DialogHeader } from "./Dialog.js";
import { DialogBase } from "./DialogBase.js";
import { Input } from "./Input.js";
import { i18n } from "./i18n.js";
let PromptDialog = PromptDialog_1 = class PromptDialog extends DialogBase {
    constructor() {
        super(...arguments);
        this.headerTitle = "";
        this.message = "";
        this.defaultValue = "";
        this.isPassword = false;
        this.inputValue = "";
        this.inputRef = createRef();
        this.modalWidth = "min(400px, 90vw)";
        this.modalHeight = "auto";
    }
    static async ask(title, message, defaultValue = "", isPassword = false) {
        const dialog = new PromptDialog_1();
        dialog.headerTitle = title;
        dialog.message = message;
        dialog.defaultValue = defaultValue;
        dialog.isPassword = isPassword;
        dialog.inputValue = defaultValue;
        return new Promise((resolve) => {
            dialog.resolvePromise = resolve;
            dialog.open();
        });
    }
    firstUpdated(_changedProperties) {
        super.firstUpdated(_changedProperties);
        this.inputRef.value?.focus();
    }
    handleConfirm() {
        this.resolvePromise?.(this.inputValue);
        this.close();
    }
    handleCancel() {
        this.resolvePromise?.(undefined);
        this.close();
    }
    renderContent() {
        return DialogContent({
            children: html `
				${DialogHeader({
                title: this.headerTitle || i18n("Input Required"),
                description: this.message,
            })}
				${Input({
                type: this.isPassword ? "password" : "text",
                value: this.inputValue,
                className: "w-full",
                inputRef: this.inputRef,
                onInput: (e) => {
                    this.inputValue = e.target.value;
                },
                onKeyDown: (e) => {
                    if (e.key === "Enter")
                        this.handleConfirm();
                    if (e.key === "Escape")
                        this.handleCancel();
                },
            })}
				${DialogFooter({
                children: html `
						${Button({
                    variant: "outline",
                    onClick: () => this.handleCancel(),
                    children: i18n("Cancel"),
                })}
						${Button({
                    variant: "default",
                    onClick: () => this.handleConfirm(),
                    children: i18n("Confirm"),
                })}
					`,
            })}
			`,
        });
    }
};
__decorate([
    property()
], PromptDialog.prototype, "headerTitle", void 0);
__decorate([
    property()
], PromptDialog.prototype, "message", void 0);
__decorate([
    property()
], PromptDialog.prototype, "defaultValue", void 0);
__decorate([
    property()
], PromptDialog.prototype, "isPassword", void 0);
__decorate([
    state()
], PromptDialog.prototype, "inputValue", void 0);
PromptDialog = PromptDialog_1 = __decorate([
    customElement("prompt-dialog")
], PromptDialog);
export { PromptDialog };
export default PromptDialog;
//# sourceMappingURL=PromptDialog.js.map