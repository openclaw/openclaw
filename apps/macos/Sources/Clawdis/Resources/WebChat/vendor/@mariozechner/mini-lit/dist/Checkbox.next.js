var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var MiniCheckbox_1, MiniLabel_1;
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { tv } from 'tailwind-variants';
import { Check, Minus } from 'lucide';
import { icon } from './icons.js';
import { description, control } from './Button.next.js'; // Reuse decorators
// ============================================================================
// Checkbox Styles
// ============================================================================
export const checkboxStyles = tv({
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
    defaultVariants: {
        size: "md",
        variant: "default",
    },
});
// ============================================================================
// Checkbox Component
// ============================================================================
let MiniCheckbox = MiniCheckbox_1 = class MiniCheckbox extends LitElement {
    constructor() {
        super(...arguments);
        // Variants
        this.size = 'md';
        this.variant = 'default';
        // State
        this.checked = false;
        this.indeterminate = false;
        this.disabled = false;
        // Style override
        this.styles = MiniCheckbox_1.defaultStyles;
        // Handle change events to update internal state
        this.handleChange = (checked) => {
            this.checked = checked;
            this.onChange?.(checked);
        };
    }
    // Static template for reuse
    static template(props, styles = MiniCheckbox_1.defaultStyles) {
        const { size, variant, checked, indeterminate, disabled, name, value, id, onChange, className } = props;
        const classString = styles({
            size,
            variant,
            class: className,
        });
        const handleChange = (e) => {
            const input = e.target;
            onChange?.(input.checked);
        };
        const iconSize = size === 'sm' ? 'xs' : size === 'lg' ? 'sm' : 'xs';
        return html `
      <div class="relative inline-flex">
        <input
          type="checkbox"
          id=${ifDefined(id)}
          name=${ifDefined(name)}
          value=${ifDefined(value)}
          .checked=${checked || false}
          ?disabled=${disabled}
          @change=${handleChange}
          data-state="${checked ? 'checked' : 'unchecked'}"
          class=${classString}
        />
        ${(checked || indeterminate)
            ? html `
            <span class="absolute inset-0 flex items-center justify-center text-current pointer-events-none">
              ${indeterminate ? icon(Minus, iconSize) : icon(Check, iconSize)}
            </span>
          `
            : null}
      </div>
    `;
    }
    createRenderRoot() {
        return this; // Light DOM
    }
    connectedCallback() {
        super.connectedCallback();
        if (!this.style.display) {
            this.style.display = 'inline-block';
        }
    }
    render() {
        // Pass modified props with our internal handler
        return MiniCheckbox_1.template({ ...this, onChange: this.handleChange }, this.styles);
    }
};
MiniCheckbox.defaultStyles = checkboxStyles;
__decorate([
    property({ type: String }),
    description("Size of the checkbox"),
    control('select', ['sm', 'md', 'lg'])
], MiniCheckbox.prototype, "size", void 0);
__decorate([
    property({ type: String }),
    description("Visual style of the checkbox"),
    control('select', ['default', 'primary', 'destructive'])
], MiniCheckbox.prototype, "variant", void 0);
__decorate([
    property({ type: Boolean }),
    description("Whether the checkbox is checked"),
    control('toggle')
], MiniCheckbox.prototype, "checked", void 0);
__decorate([
    property({ type: Boolean }),
    description("Whether the checkbox is in indeterminate state"),
    control('toggle')
], MiniCheckbox.prototype, "indeterminate", void 0);
__decorate([
    property({ type: Boolean }),
    description("Whether the checkbox is disabled"),
    control('toggle')
], MiniCheckbox.prototype, "disabled", void 0);
__decorate([
    property({ type: String }),
    description("Name attribute for form submission")
], MiniCheckbox.prototype, "name", void 0);
__decorate([
    property({ type: String }),
    description("Value attribute for form submission")
], MiniCheckbox.prototype, "value", void 0);
__decorate([
    property({ type: String }),
    description("ID attribute for the checkbox")
], MiniCheckbox.prototype, "id", void 0);
__decorate([
    property({ attribute: false }),
    description("Change event handler")
], MiniCheckbox.prototype, "onChange", void 0);
__decorate([
    property({ attribute: false })
], MiniCheckbox.prototype, "styles", void 0);
__decorate([
    property({ type: String })
], MiniCheckbox.prototype, "className", void 0);
MiniCheckbox = MiniCheckbox_1 = __decorate([
    customElement('mini-checkbox')
], MiniCheckbox);
export { MiniCheckbox };
// ============================================================================
// Label Component (Separate, works with any form control)
// ============================================================================
export const labelStyles = tv({
    base: "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer",
});
let MiniLabel = MiniLabel_1 = class MiniLabel extends LitElement {
    constructor() {
        super(...arguments);
        this.required = false;
        this.styles = MiniLabel_1.defaultStyles;
    }
    static template(props, styles = MiniLabel_1.defaultStyles) {
        const { for: forProp, required, className } = props;
        const classString = styles({ class: className });
        return html `
      <label class=${classString} for=${ifDefined(forProp)}>
        <slot></slot>
        ${required ? html `<span class="text-destructive ml-1">*</span>` : ''}
      </label>
    `;
    }
    createRenderRoot() {
        return this; // Light DOM
    }
    render() {
        return MiniLabel_1.template(this, this.styles);
    }
};
MiniLabel.defaultStyles = labelStyles;
__decorate([
    property({ type: String }),
    description("ID of the form element this label is for")
], MiniLabel.prototype, "for", void 0);
__decorate([
    property({ type: Boolean }),
    description("Shows a required indicator"),
    control('toggle')
], MiniLabel.prototype, "required", void 0);
__decorate([
    property({ attribute: false })
], MiniLabel.prototype, "styles", void 0);
__decorate([
    property({ type: String })
], MiniLabel.prototype, "className", void 0);
MiniLabel = MiniLabel_1 = __decorate([
    customElement('mini-label')
], MiniLabel);
export { MiniLabel };
//# sourceMappingURL=Checkbox.next.js.map