var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { MiniButton } from './index.next.js';
// ============================================================================
// Example 1: Using Web Components Directly (Most Common)
// ============================================================================
let MyApp = class MyApp extends LitElement {
    constructor() {
        super(...arguments);
        this.accepted = false;
        this.loading = false;
    }
    createRenderRoot() {
        return this; // Light DOM for Tailwind
    }
    render() {
        return html `
      <div class="p-8 space-y-4">
        <!-- Web components work great with reactive state -->
        <div class="flex items-center gap-3">
          <mini-checkbox
            id="terms"
            .checked=${this.accepted}
            @change=${(e) => {
            this.accepted = e.target.checked;
        }}
          ></mini-checkbox>
          <mini-label for="terms">Accept terms and conditions</mini-label>
        </div>

        <mini-button
          ?disabled=${!this.accepted}
          ?loading=${this.loading}
          @click=${() => this.handleSubmit()}
        >
          Submit
        </mini-button>
      </div>
    `;
    }
    handleSubmit() {
        this.loading = true;
        // ... do something
    }
};
__decorate([
    state()
], MyApp.prototype, "accepted", void 0);
__decorate([
    state()
], MyApp.prototype, "loading", void 0);
MyApp = __decorate([
    customElement('my-app')
], MyApp);
export { MyApp };
// ============================================================================
// Example 2: Using Static Templates in Custom Components
// ============================================================================
let MyCustomButton = class MyCustomButton extends LitElement {
    constructor() {
        super(...arguments);
        this.count = 0;
    }
    createRenderRoot() {
        return this; // Light DOM
    }
    render() {
        // Use the static template when building your own components
        return html `
      <div class="my-wrapper">
        ${MiniButton.template({
            children: `Clicked ${this.count} times`,
            onClick: () => this.count++,
            variant: 'primary',
        })}
      </div>
    `;
    }
};
__decorate([
    state()
], MyCustomButton.prototype, "count", void 0);
MyCustomButton = __decorate([
    customElement('my-custom-button')
], MyCustomButton);
export { MyCustomButton };
// ============================================================================
// Example 3: Custom Styles
// ============================================================================
import { tv } from 'tailwind-variants';
// Create your own button styles
const myButtonStyles = tv({
    base: "px-6 py-3 rounded-full font-bold transition-all",
    variants: {
        variant: {
            default: "bg-blue-500 text-white hover:bg-blue-600",
            destructive: "bg-red-500 text-white hover:bg-red-600",
            outline: "border-2 border-gray-300 hover:border-gray-400",
            secondary: "bg-gray-200 hover:bg-gray-300",
            ghost: "hover:bg-gray-100",
            link: "underline hover:no-underline",
        },
        size: {
            default: "text-base",
            sm: "text-sm",
            lg: "text-lg",
            icon: "p-3",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});
let MyStyledApp = class MyStyledApp extends LitElement {
    createRenderRoot() {
        return this; // Light DOM
    }
    render() {
        return html `
      <!-- Use custom styles on individual components -->
      <mini-button
        .styles=${myButtonStyles}
        variant="destructive"
      >
        Custom Styled Button
      </mini-button>

      <!-- Or use the template with custom styles -->
      ${MiniButton.template({ children: "Template with custom styles" }, myButtonStyles)}
    `;
    }
};
MyStyledApp = __decorate([
    customElement('my-styled-app')
], MyStyledApp);
export { MyStyledApp };
// ============================================================================
// Example 4: Documentation Generation
// ============================================================================
export function generateDocs(Component) {
    const metadata = Component.getMetadata();
    // Use reflection to get all @property decorated fields
    const properties = [];
    for (const [key, meta] of Object.entries(metadata || {})) {
        properties.push({
            name: key,
            description: meta.description,
            control: meta.control,
            options: meta.options,
            // Get type and default from the actual component instance
            type: typeof Component.prototype[key],
            default: Component.prototype[key],
        });
    }
    return properties;
}
export function renderToString(Component, props) {
    // Templates are just template literals, can be rendered server-side
    const template = Component.template(props);
    // Render to string (you'd need a server-side renderer)
    // This is pseudo-code, actual implementation would need more work
    return template.strings.join('');
}
// ============================================================================
// Example 6: Global Style Override
// ============================================================================
// Override default styles globally
MiniButton.defaultStyles = myButtonStyles;
// Now all buttons use the new styles by default
let MyGlobalStyledApp = class MyGlobalStyledApp extends LitElement {
    createRenderRoot() {
        return this; // Light DOM
    }
    render() {
        return html `
      <!-- Uses the globally overridden styles -->
      <mini-button>Globally Styled</mini-button>
    `;
    }
};
MyGlobalStyledApp = __decorate([
    customElement('my-global-styled-app')
], MyGlobalStyledApp);
export { MyGlobalStyledApp };
//# sourceMappingURL=usage-example.next.js.map