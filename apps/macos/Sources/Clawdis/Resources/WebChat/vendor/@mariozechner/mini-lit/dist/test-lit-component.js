var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { customElement } from "lit/decorators.js";
import { defaultStyle, definition, renderButton } from "./Button.cva.js";
import { createLitComponent } from "./createLitComponent.js";
// Create the Lit component class
const ButtonClass = createLitComponent(definition, defaultStyle, renderButton);
// Register as custom element
let MiniButton = class MiniButton extends ButtonClass {
};
MiniButton = __decorate([
    customElement("mini-button-lit")
], MiniButton);
export { MiniButton };
// Test type inference
const button = new MiniButton();
// These should all be typed correctly
button.variant = "destructive";
button.size = "lg";
button.disabled = true;
button.loading = false;
button.className = "extra-class";
// Test that properties is accessible
console.log(MiniButton.properties);
//# sourceMappingURL=test-lit-component.js.map