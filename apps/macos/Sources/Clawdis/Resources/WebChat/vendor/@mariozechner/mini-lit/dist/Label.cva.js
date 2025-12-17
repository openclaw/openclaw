var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { ComponentLitBase, createComponent, defineComponent, renderComponent, styleComponent, } from "./component.js";
// Step 1: Define the component structure
export const labelDefinition = defineComponent({
    tag: "mini-label",
    props: {
        for: {
            type: "string",
            default: undefined,
            description: "ID of the form element this label is for",
        },
        required: {
            type: "boolean",
            default: false,
            description: "Shows a required indicator",
        },
    },
});
// Step 2: Define styles
export const labelDefaultStyle = styleComponent(labelDefinition, {
    base: "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer",
});
// Step 3: Define render function
export const renderLabel = renderComponent(labelDefinition, labelDefaultStyle, (props, className) => {
    const { children, required } = props;
    const forAttr = props.for;
    return html `
      <label
         class=${className()}
         for=${ifDefined(forAttr)}
      >
         ${children}
         ${required ? html `<span class="text-destructive ml-1">*</span>` : ""}
      </label>
   `;
});
// Step 4: Create label factory
export function createLabel(styles) {
    return createComponent(labelDefinition, styles, renderLabel);
}
// Default functional label export
export const Label = createLabel(labelDefaultStyle);
// Concrete class-based label export
let MiniLabel = class MiniLabel extends ComponentLitBase {
    constructor() {
        super(...arguments);
        // Declare the component props with decorators
        this.for = labelDefinition.props.for.default;
        this.required = labelDefinition.props.required.default;
        // Provide definition, styles, and render function
        this.definition = labelDefinition;
        this.styles = labelDefaultStyle;
        this.renderFn = renderLabel;
    }
    connectedCallback() {
        super.connectedCallback();
        if (!this.style.display) {
            this.style.display = "inline-block";
        }
    }
};
__decorate([
    property({ type: String })
], MiniLabel.prototype, "for", void 0);
__decorate([
    property({ type: Boolean })
], MiniLabel.prototype, "required", void 0);
MiniLabel = __decorate([
    customElement(labelDefinition.tag)
], MiniLabel);
export { MiniLabel };
//# sourceMappingURL=Label.cva.js.map