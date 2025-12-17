/**
 * Directive interface for mini-lit
 * Directives return objects with this shape to get special handling
 */
export interface Directive {
    _$miniDirective$: true;
    node: Node;
    mount: () => void;
    unmount?: () => void;
}
/**
 * Type guard to check if a value is a directive
 */
export declare function isDirective(value: any): value is Directive;
/**
 * Helper to create a directive
 */
export declare function directive(node: Node, mount: () => void, unmount?: () => void): Directive;
//# sourceMappingURL=directive.d.ts.map