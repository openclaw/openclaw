/**
 * Type declarations for lit-plugin VSCode autocomplete support
 *
 * This allows the lit-plugin to provide intellisense for our components
 * when used in html template literals.
 */
declare global {
    /**
     * Register your components here for VSCode autocomplete:
     *
     * @example
     * ```typescript
     * declare global {
     *   interface HTMLElementTagNameMap {
     *     "Button": ButtonComponent;
     *     "Card": CardComponent;
     *   }
     * }
     * ```
     */
    interface HTMLElementTagNameMap {
    }
    /**
     * Register component props for better type checking
     */
    interface HTMLElementEventMap {
    }
}
export {};
//# sourceMappingURL=lit-plugin-types.d.ts.map