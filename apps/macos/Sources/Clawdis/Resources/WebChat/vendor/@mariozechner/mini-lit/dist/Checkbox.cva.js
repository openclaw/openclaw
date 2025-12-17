var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { Check, Minus } from "lucide";
import { ComponentLitBase, createComponent, defineComponent, renderComponent, styleComponent, } from "./component.js";
import { icon } from "./icons.js";
// Step 1: Define the component structure
export const checkboxDefinition = defineComponent({
    tag: "mini-checkbox",
    variants: {
        size: {
            options: ["sm", "md", "lg"],
            default: "md",
            description: "Size of the checkbox",
        },
        variant: {
            options: ["default", "primary", "destructive"],
            default: "default",
            description: "Visual style of the checkbox",
        },
    },
    props: {
        checked: {
            type: "boolean",
            default: false,
            description: "Whether the checkbox is checked",
        },
        indeterminate: {
            type: "boolean",
            default: false,
            description: "Whether the checkbox is in indeterminate state",
        },
        disabled: {
            type: "boolean",
            default: false,
            description: "Whether the checkbox is disabled",
        },
        name: {
            type: "string",
            default: undefined,
            description: "Name attribute for form submission",
        },
        value: {
            type: "string",
            default: undefined,
            description: "Value attribute for form submission",
        },
        id: {
            type: "string",
            default: undefined,
            description: "ID attribute for the checkbox",
        },
        onChange: {
            type: "function",
            default: undefined,
            description: "Change event handler",
        },
    },
});
// Step 2: Define styles - single element component now
export const checkboxDefaultStyle = styleComponent(checkboxDefinition, {
    base: "peer shrink-0 appearance-none rounded border border-input bg-background shadow-xs ring-offset-background transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground hover:border-muted-foreground/50",
    variants: {
        size: {
            sm: "h-3.5 w-3.5",
            md: "h-4 w-4",
            lg: "h-5 w-5",
        },
        variant: {
            default: "data-[state=checked]:bg-primary data-[state=checked]:border-primary",
            primary: "data-[state=checked]:bg-primary data-[state=checked]:border-primary",
            destructive: "data-[state=checked]:bg-destructive data-[state=checked]:border-destructive data-[state=checked]:text-destructive-foreground",
        },
    },
});
// Step 3: Define render function - now receives className function for single-element component
export const renderCheckbox = renderComponent(checkboxDefinition, checkboxDefaultStyle, (props, className) => {
    const { size, checked, indeterminate, disabled, name, value, id, onChange } = props;
    const handleChange = (e) => {
        const input = e.target;
        onChange?.(input.checked);
    };
    // Icon size based on checkbox size
    const iconSize = size === "sm" ? "xs" : size === "lg" ? "sm" : "xs";
    return html `
      <div class="relative inline-flex">
         <input
            type="checkbox"
            id=${ifDefined(id ?? undefined)}
            name=${ifDefined(name ?? undefined)}
            value=${ifDefined(value ?? undefined)}
            .checked=${checked || false}
            ?disabled=${disabled}
            @change=${handleChange}
            data-state="${checked ? "checked" : "unchecked"}"
            class="${className()}"
         />
         ${checked || indeterminate
        ? html `
               <span class="absolute inset-0 flex items-center justify-center text-current pointer-events-none">
                  ${indeterminate ? icon(Minus, iconSize) : icon(Check, iconSize)}
               </span>
            `
        : null}
      </div>
   `;
});
// Step 4: Create checkbox factory
export function createCheckbox(styles) {
    return createComponent(checkboxDefinition, styles, renderCheckbox);
}
// Default functional checkbox export
export const Checkbox = createCheckbox(checkboxDefaultStyle);
// Concrete class-based checkbox export
let MiniCheckbox = class MiniCheckbox extends ComponentLitBase {
    constructor() {
        super(...arguments);
        // Declare the component props with decorators
        this.checked = checkboxDefinition.props.checked.default;
        this.indeterminate = checkboxDefinition.props.indeterminate.default;
        this.disabled = checkboxDefinition.props.disabled.default;
        this.name = checkboxDefinition.props.name.default;
        this.value = checkboxDefinition.props.value.default;
        this.id = checkboxDefinition.props.id.default ?? "";
        this.onChange = checkboxDefinition.props.onChange.default;
        // Provide definition, styles, and render function
        this.definition = checkboxDefinition;
        this.styles = checkboxDefaultStyle;
        this.renderFn = renderCheckbox;
    }
};
__decorate([
    property({ type: String })
], MiniCheckbox.prototype, "size", void 0);
__decorate([
    property({ type: String })
], MiniCheckbox.prototype, "variant", void 0);
__decorate([
    property({ type: Boolean })
], MiniCheckbox.prototype, "checked", void 0);
__decorate([
    property({ type: Boolean })
], MiniCheckbox.prototype, "indeterminate", void 0);
__decorate([
    property({ type: Boolean })
], MiniCheckbox.prototype, "disabled", void 0);
__decorate([
    property({ type: String })
], MiniCheckbox.prototype, "name", void 0);
__decorate([
    property({ type: String })
], MiniCheckbox.prototype, "value", void 0);
__decorate([
    property({ type: String })
], MiniCheckbox.prototype, "id", void 0);
__decorate([
    property({ attribute: false })
], MiniCheckbox.prototype, "onChange", void 0);
MiniCheckbox = __decorate([
    customElement(checkboxDefinition.tag)
], MiniCheckbox);
export { MiniCheckbox };
//# sourceMappingURL=Checkbox.cva.js.map