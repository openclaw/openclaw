import { LitElement } from "lit";
import { Dialog } from "./Dialog.js";
export class DialogBase extends LitElement {
    constructor() {
        super(...arguments);
        // Modal configuration - can be overridden by subclasses
        this.modalWidth = "min(600px, 90vw)";
        this.modalHeight = "min(600px, 80vh)";
    }
    createRenderRoot() {
        return this;
    }
    open() {
        // Store the currently focused element
        this.previousFocus = document.activeElement;
        document.body.appendChild(this);
        this.boundHandleKeyDown = (e) => {
            if (e.key === "Escape") {
                this.close();
            }
        };
        window.addEventListener("keydown", this.boundHandleKeyDown);
    }
    close() {
        if (this.boundHandleKeyDown) {
            window.removeEventListener("keydown", this.boundHandleKeyDown);
        }
        this.remove();
        // Restore focus to the previously focused element
        if (this.previousFocus?.focus) {
            // Use requestAnimationFrame to ensure the dialog is fully removed first
            requestAnimationFrame(() => {
                this.previousFocus?.focus();
            });
        }
    }
    render() {
        return Dialog({
            isOpen: true,
            onClose: () => this.close(),
            width: this.modalWidth,
            height: this.modalHeight,
            backdropClassName: "bg-black/50 backdrop-blur-sm",
            children: this.renderContent(),
        });
    }
}
//# sourceMappingURL=DialogBase.js.map