/**
 * Type guard to check if a value is a directive
 */
export function isDirective(value) {
    return value && value._$miniDirective$ === true;
}
/**
 * Helper to create a directive
 */
export function directive(node, mount, unmount) {
    return {
        _$miniDirective$: true,
        node,
        mount,
        unmount,
    };
}
//# sourceMappingURL=directive.js.map