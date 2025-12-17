var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var MiniButton_1;
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { tv } from 'tailwind-variants';
import { icon } from './icons.js';
import { Loader2 } from 'lucide';
// ============================================================================
// Metadata Decorators
// ============================================================================
// Store component metadata
const componentMetadata = new WeakMap();
export function description(text) {
    return (target, propertyKey) => {
        const metadata = componentMetadata.get(target.constructor) || {};
        metadata[propertyKey] = { ...metadata[propertyKey], description: text };
        componentMetadata.set(target.constructor, metadata);
    };
}
export function control(type, options) {
    return (target, propertyKey) => {
        const metadata = componentMetadata.get(target.constructor) || {};
        metadata[propertyKey] = { ...metadata[propertyKey], control: type, options };
        componentMetadata.set(target.constructor, metadata);
    };
}
// ============================================================================
// Button Styles
// ============================================================================
export const buttonStyles = tv({
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
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
// ============================================================================
// Button Component
// ============================================================================
let MiniButton = MiniButton_1 = class MiniButton extends LitElement {
    constructor() {
        super(...arguments);
        // Variant props with metadata
        this.variant = 'default';
        this.size = 'default';
        // Regular props
        this.disabled = false;
        this.loading = false;
        // Allow style override
        this.styles = MiniButton_1.defaultStyles;
    }
    // Get metadata for documentation/playground
    static getMetadata() {
        return componentMetadata.get(this);
    }
    // Static template function for reuse
    static template(props, styles = MiniButton_1.defaultStyles) {
        const { variant, size, disabled, loading, onClick, className, children } = props;
        const classString = styles({
            variant,
            size,
            class: className,
        });
        return html `
      <button
        class=${classString}
        ?disabled=${disabled || loading}
        @click=${onClick}
      >
        ${loading
            ? html `<span class="animate-spin">${icon(Loader2, size === 'icon' || size === 'sm' ? 'sm' : 'md')}</span>`
            : ''}
        ${children || html `<slot></slot>`}
      </button>
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
        // Pass 'this' which has all the properties
        return MiniButton_1.template(this, this.styles);
    }
};
// Store default styles as static
MiniButton.defaultStyles = buttonStyles;
__decorate([
    property({ type: String }),
    description("Visual style of the button"),
    control('select', ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'])
], MiniButton.prototype, "variant", void 0);
__decorate([
    property({ type: String }),
    description("Size of the button"),
    control('select', ['default', 'sm', 'lg', 'icon'])
], MiniButton.prototype, "size", void 0);
__decorate([
    property({ type: Boolean }),
    description("Disables the button when true"),
    control('toggle')
], MiniButton.prototype, "disabled", void 0);
__decorate([
    property({ type: Boolean }),
    description("Shows loading spinner when true"),
    control('toggle')
], MiniButton.prototype, "loading", void 0);
__decorate([
    property({ attribute: false }),
    description("Click event handler")
], MiniButton.prototype, "onClick", void 0);
__decorate([
    property({ attribute: false })
], MiniButton.prototype, "styles", void 0);
MiniButton = MiniButton_1 = __decorate([
    customElement('mini-button')
], MiniButton);
export { MiniButton };
//# sourceMappingURL=Button.next.js.map