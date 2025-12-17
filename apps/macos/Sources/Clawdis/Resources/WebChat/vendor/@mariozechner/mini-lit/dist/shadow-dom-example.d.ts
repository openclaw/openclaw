import { LitElement } from 'lit';
export declare class BadButton1 extends LitElement {
    static styles: import("lit").CSSResult;
    variant: string;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class BadButton2 extends LitElement {
    static styles: import("lit").CSSResult;
    connectedCallback(): void;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class CompiledButton extends LitElement {
    static styles: import("lit").CSSResult;
    variant: 'primary' | 'secondary';
    render(): import("lit-html").TemplateResult<1>;
}
export declare class BridgeButton extends LitElement {
    static styles: import("lit").CSSResult;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class LightButton extends LitElement {
    variant: string;
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class HybridButton extends LitElement {
    static styles: import("lit").CSSResult;
    class: string;
    render(): import("lit-html").TemplateResult<1>;
}
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
export declare class MiniButtonIdeal extends LitElement {
    variant: string;
    className: string;
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
}
//# sourceMappingURL=shadow-dom-example.d.ts.map