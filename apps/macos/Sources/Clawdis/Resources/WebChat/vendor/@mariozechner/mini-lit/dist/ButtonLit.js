var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { customElement } from "lit/decorators.js";
import { defaultStyle, definition, renderButton } from "./Button.cva.js";
import { LitComponentBase } from "./LitComponentBase.js";
/**
 * Button component as a Lit element.
 * The generic parameter provides full type safety for all props.
 */
let MiniButton = class MiniButton extends LitComponentBase {
    constructor() {
        super(...arguments);
        // Provide the definition
        this.definition = definition;
        // Provide the styles
        this.styles = defaultStyle;
        // Provide the render function
        this.renderFn = renderButton;
    }
    // Optional: Override specific methods if needed
    connectedCallback() {
        super.connectedCallback();
        console.log("Button connected with props:", this.collectProps());
    }
    // Optional: Add component-specific methods
    reset() {
        this.disabled = false;
        this.loading = false;
        this.variant = "default";
        this.size = "default";
    }
};
// Set up Lit properties
MiniButton.properties = LitComponentBase.createProperties(definition);
MiniButton = __decorate([
    customElement("mini-button")
], MiniButton);
export { MiniButton };
// Usage example:
// const button = new MiniButton();
// button.variant = "destructive"; // fully typed!
// button.size = "lg"; // fully typed!
// button.disabled = true; // fully typed!
//# sourceMappingURL=ButtonLit.js.map