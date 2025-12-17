var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Loader2 } from "lucide";
import { ComponentLitBase, createComponent, defineComponent, renderComponent, styleComponent, } from "./component.js";
import { icon } from "./icons.js";
// Step 1: Define the component structure
export const buttonDefinition = defineComponent({
    tag: "mini-button",
    variants: {
        variant: {
            options: ["default", "destructive", "outline", "secondary", "ghost", "link"],
            default: "default",
            description: "Visual style of the button",
        },
        size: {
            options: ["default", "sm", "lg", "icon"],
            default: "default",
            description: "Size of the button",
        },
    },
    props: {
        disabled: {
            type: "boolean",
            default: false,
            description: "Disables the button when true",
        },
        loading: {
            type: "boolean",
            default: false,
            description: "Shows loading spinner when true",
        },
        onClick: {
            type: "function",
            default: undefined,
            description: "Click event handler",
        },
    },
});
// Step 2: Define styles - definition passed for type inference only
export const buttonDefaultStyle = styleComponent(buttonDefinition, {
    base: "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    variants: {
        variant: {
            default: "bg-primary text-primary-foreground hover:bg-primary/90",
            destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
            secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
            ghost: "hover:bg-accent hover:text-accent-foreground",
            link: "text-primary underline-offset-4 hover:underline",
        },
        size: {
            default: "h-10 px-4 py-2",
            sm: "h-9 rounded-md px-3",
            lg: "h-11 rounded-md px-8",
            icon: "h-10 w-10",
        },
    },
    compoundVariants: [
        {
            variant: "ghost",
            size: "icon",
            className: "hover:bg-accent/50",
        },
        {
            variant: "link",
            size: "sm",
            className: "h-auto px-0 py-0",
        },
    ],
});
// Step 3: Define render function - now receives className function for single-element component
export const renderButton = renderComponent(buttonDefinition, buttonDefaultStyle, (props, className) => {
    const { size, disabled, loading, onClick, children } = props;
    return html `
      <button
        class=${className()}
        ?disabled=${disabled || loading}
        @click=${onClick}
      >
        ${loading
        ? html `<span class="animate-spin">${icon(Loader2, size === "icon" || size === "sm" ? "sm" : "md")}</span>`
        : ""}
        ${children}
      </button>
    `;
});
// Step 4: Create button factory
export function createButton(styles) {
    return createComponent(buttonDefinition, styles, renderButton);
}
// Default functional button export
export const Button = createButton(buttonDefaultStyle);
// Concerete class-based button export
let MiniButton = class MiniButton extends ComponentLitBase {
    constructor() {
        super(...arguments);
        this.disabled = buttonDefinition.props.disabled.default;
        this.loading = buttonDefinition.props.loading.default;
        this.onClick = buttonDefinition.props.onClick.default;
        // Provide definition, styles, and render function
        this.definition = buttonDefinition;
        this.styles = buttonDefaultStyle;
        this.renderFn = renderButton;
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
], MiniButton.prototype, "variant", void 0);
__decorate([
    property({ type: String })
], MiniButton.prototype, "size", void 0);
__decorate([
    property({ type: Boolean })
], MiniButton.prototype, "disabled", void 0);
__decorate([
    property({ type: Boolean })
], MiniButton.prototype, "loading", void 0);
__decorate([
    property({ attribute: false })
], MiniButton.prototype, "onClick", void 0);
MiniButton = __decorate([
    customElement(buttonDefinition.tag)
], MiniButton);
export { MiniButton };
//# sourceMappingURL=Button.cva.js.map