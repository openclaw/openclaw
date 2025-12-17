var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { LitElement, html, css, unsafeCSS } from 'lit';
import { customElement, property } from 'lit/decorators.js';
// ============================================================================
// Option 1: Inline all of Tailwind (TERRIBLE IDEA)
// ============================================================================
// @ts-expect-error
import tailwindCSS from '../dist/tailwind.css?inline'; // Hypothetical
let BadButton1 = class BadButton1 extends LitElement {
    constructor() {
        super(...arguments);
        this.variant = 'default';
    }
    render() {
        // Now you can use Tailwind classes
        return html `<button class="px-4 py-2 bg-blue-500">Click</button>`;
    }
};
BadButton1.styles = css `
    /* This would be MASSIVE - entire Tailwind in EVERY component */
    ${unsafeCSS(tailwindCSS)}
  `;
__decorate([
    property()
], BadButton1.prototype, "variant", void 0);
BadButton1 = __decorate([
    customElement('bad-button-1')
], BadButton1);
export { BadButton1 };
// Problem: Each component instance contains ALL of Tailwind (~40kb+ minified)
// 10 components = 400kb+ of duplicate CSS!
// ============================================================================
// Option 2: Constructable Stylesheets (Better but still problematic)
// ============================================================================
// Create one stylesheet for all components
const sharedSheet = new CSSStyleSheet();
sharedSheet.replaceSync(tailwindCSS); // Still need all of Tailwind
let BadButton2 = class BadButton2 extends LitElement {
    connectedCallback() {
        super.connectedCallback();
        // Adopt shared stylesheet
        this.shadowRoot.adoptedStyleSheets = [sharedSheet];
    }
    render() {
        return html `<button class="px-4 py-2 bg-blue-500">Click</button>`;
    }
};
BadButton2.styles = css `
    /* Component-specific styles */
    :host {
      display: inline-block;
    }
  `;
BadButton2 = __decorate([
    customElement('bad-button-2')
], BadButton2);
export { BadButton2 };
// Problem: Still shipping all of Tailwind, just not duplicating it
// But you lose Tailwind's purging benefits - can't tree-shake unused styles
// ============================================================================
// Option 3: CSS-in-JS Style (Compile Tailwind classes to CSS)
// ============================================================================
import { tv } from 'tailwind-variants';
// This would need a build step to convert Tailwind classes to actual CSS
const buttonStyles = tv({
    base: "px-4 py-2 rounded",
    variants: {
        variant: {
            primary: "bg-blue-500 text-white",
            secondary: "bg-gray-500 text-white"
        }
    }
});
let CompiledButton = class CompiledButton extends LitElement {
    constructor() {
        super(...arguments);
        this.variant = 'primary';
    }
    render() {
        return html `
      <button class="base variant-${this.variant}">
        <slot></slot>
      </button>
    `;
    }
};
// Build tool would need to extract and convert to real CSS
CompiledButton.styles = css `
    .base {
      padding: 1rem 0.5rem; /* px-4 py-2 compiled */
      border-radius: 0.25rem; /* rounded compiled */
    }
    .variant-primary {
      background-color: rgb(59 130 246); /* bg-blue-500 compiled */
      color: white;
    }
  `;
__decorate([
    property()
], CompiledButton.prototype, "variant", void 0);
CompiledButton = __decorate([
    customElement('compiled-button')
], CompiledButton);
export { CompiledButton };
// Problem: Loses Tailwind's utility-first benefits, needs complex build tooling
// ============================================================================
// Option 4: CSS Custom Properties Bridge (Clever but limited)
// ============================================================================
let BridgeButton = class BridgeButton extends LitElement {
    render() {
        return html `<button><slot></slot></button>`;
    }
};
BridgeButton.styles = css `
    :host {
      display: inline-block;
    }
    button {
      /* Use CSS custom properties that are set in light DOM */
      background-color: var(--btn-bg, #3b82f6);
      color: var(--btn-color, white);
      padding: var(--btn-padding, 0.5rem 1rem);
      border-radius: var(--btn-radius, 0.25rem);
    }
  `;
BridgeButton = __decorate([
    customElement('bridge-button')
], BridgeButton);
export { BridgeButton };
// In light DOM, you'd use Tailwind to set the custom properties
// <bridge-button style="--btn-bg: theme('colors.blue.500')">
// Problem: Limited, verbose, loses most Tailwind benefits
// ============================================================================
// Option 5: Just Use Light DOM (RECOMMENDED)
// ============================================================================
let LightButton = class LightButton extends LitElement {
    constructor() {
        super(...arguments);
        this.variant = 'primary';
    }
    // No shadow DOM!
    createRenderRoot() {
        return this;
    }
    render() {
        // Tailwind classes work because we're in light DOM
        const classes = this.variant === 'primary'
            ? 'px-4 py-2 bg-blue-500 text-white rounded'
            : 'px-4 py-2 bg-gray-500 text-white rounded';
        return html `<button class=${classes}><slot></slot></button>`;
    }
};
__decorate([
    property()
], LightButton.prototype, "variant", void 0);
LightButton = __decorate([
    customElement('light-button')
], LightButton);
export { LightButton };
// ============================================================================
// Option 6: Hybrid Approach (Shadow DOM for structure, Light DOM for styling)
// ============================================================================
let HybridButton = class HybridButton extends LitElement {
    constructor() {
        super(...arguments);
        this.class = '';
    }
    render() {
        return html `
      <div class="wrapper">
        <!-- This slot will project light DOM content that has Tailwind styles -->
        <slot></slot>
      </div>
    `;
    }
};
HybridButton.styles = css `
    :host {
      display: inline-block;
    }
    /* Only structural styles in shadow DOM */
    .wrapper {
      position: relative;
    }
  `;
__decorate([
    property()
], HybridButton.prototype, "class", void 0);
HybridButton = __decorate([
    customElement('hybrid-button')
], HybridButton);
export { HybridButton };
// Usage:
// <hybrid-button>
//   <button class="px-4 py-2 bg-blue-500">Click</button>
// </hybrid-button>
// ============================================================================
// Why Light DOM is Actually Good for Component Libraries
// ============================================================================
/**
 * Benefits of Light DOM for mini-lit:
 *
 * 1. **Tailwind Just Works**: No build complexity, no duplication
 * 2. **User Customization**: Users can override styles with their own classes
 * 3. **Theme Integration**: Inherits from parent CSS naturally
 * 4. **Smaller Bundle**: Tailwind is loaded once globally
 * 5. **Framework Friendly**: Easier to integrate with React, Vue, etc.
 *
 * Downsides:
 * 1. **No Style Encapsulation**: Styles can leak in/out
 * 2. **Name Conflicts**: Class names might conflict
 * 3. **Less "Pure"**: Not following web component best practices
 *
 * But for a UI library meant to be styled and themed, Light DOM makes sense!
 */
// ============================================================================
// The Real Solution: Embrace Light DOM
// ============================================================================
/**
 * mini-lit's approach is actually correct:
 *
 * 1. Use Light DOM for styleable components
 * 2. Use tailwind-variants for style management
 * 3. Let users override with their own Tailwind classes
 * 4. Components are really just "enhanced HTML elements"
 *
 * This is similar to how Shoelace.style works - they use Light DOM
 * for the parts that need styling and Shadow DOM only for truly
 * encapsulated pieces.
 */
let MiniButtonIdeal = class MiniButtonIdeal extends LitElement {
    constructor() {
        super(...arguments);
        this.variant = 'primary';
        this.className = '';
    }
    createRenderRoot() {
        return this; // Light DOM is the right choice!
    }
    render() {
        const baseClasses = 'px-4 py-2 rounded transition-colors';
        const variantClasses = {
            primary: 'bg-blue-500 text-white hover:bg-blue-600',
            secondary: 'bg-gray-500 text-white hover:bg-gray-600'
        };
        const classes = `${baseClasses} ${variantClasses[this.variant]} ${this.className}`;
        return html `
      <button class=${classes}>
        <slot></slot>
      </button>
    `;
    }
};
__decorate([
    property()
], MiniButtonIdeal.prototype, "variant", void 0);
__decorate([
    property()
], MiniButtonIdeal.prototype, "className", void 0);
MiniButtonIdeal = __decorate([
    customElement('mini-button-ideal')
], MiniButtonIdeal);
export { MiniButtonIdeal };
// Users can override:
// <mini-button-ideal variant="primary" className="!bg-red-500">
//   Emergency Button
// </mini-button-ideal>
//# sourceMappingURL=shadow-dom-example.js.map