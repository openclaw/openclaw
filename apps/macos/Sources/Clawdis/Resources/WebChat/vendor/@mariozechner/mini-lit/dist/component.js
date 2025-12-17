import { LitElement } from "lit";
import { tv } from "tailwind-variants";
const basePropDefinitions = {
    children: {
        type: "children",
        default: undefined,
        description: "Component content",
    },
    className: {
        type: "classname",
        default: undefined,
        description: "Additional CSS classes to apply",
    },
};
function mergeBaseProps(props) {
    const userProps = (props ?? {});
    const className = userProps.className && userProps.className.type === "classname"
        ? userProps.className
        : basePropDefinitions.className;
    const children = userProps.children && userProps.children.type === "children" ? userProps.children : basePropDefinitions.children;
    return {
        ...userProps,
        className,
        children,
    };
}
// ============================================================================
// Helper Functions
// ============================================================================
// Extract default variant values from definition
export function getDefaultVariants(def) {
    const defaults = {};
    if (def.variants) {
        for (const [key, value] of Object.entries(def.variants)) {
            defaults[key] = value.default;
        }
    }
    return defaults;
}
// Extract all default values from definition (for spreading as default props)
export function getDefaultProps(def) {
    const defaults = {};
    // Add variant defaults
    if (def.variants) {
        for (const [key, value] of Object.entries(def.variants)) {
            defaults[key] = value.default;
        }
    }
    // Add prop defaults
    const propDefinitions = mergeBaseProps(def.props);
    for (const [key, value] of Object.entries(propDefinitions)) {
        defaults[key] = value.default;
    }
    return defaults;
}
// ============================================================================
// Component Factory
// ============================================================================
import { fc } from "./mini.js";
export function defineComponent(definition) {
    const props = { ...(definition.props || {}) };
    // If slots are defined, auto-generate className props for them
    if (definition.slots) {
        for (const slotName of definition.slots) {
            if (slotName !== "base") {
                const propName = `${slotName}ClassName`;
                if (!props[propName]) {
                    props[propName] = {
                        type: "classname",
                        default: undefined,
                        description: `Additional CSS classes for the ${slotName} element`,
                    };
                }
            }
        }
    }
    const propsWithBase = mergeBaseProps(props);
    return {
        ...definition,
        props: propsWithBase,
    };
}
export function styleComponent(_definition, styles) {
    // Just return the styles - defineComponent already handles prop generation
    return styles;
}
// Helper function that just returns the render function but helps with type inference
export function renderComponent(_definition, _styles, render) {
    return render;
}
// Helper to extract variant props from component props
function extractVariantProps(props, definition) {
    const variantProps = {};
    if (definition.variants) {
        for (const key of Object.keys(definition.variants)) {
            if (key in props) {
                variantProps[key] = props[key];
            }
        }
    }
    return variantProps;
}
// Type guard to check if styles have slots
function hasSlots(styles) {
    return "slots" in styles;
}
// Create the actual component from definition, styles, and render
export function createComponent(definition, styles, render) {
    const tvConfig = {
        ...styles,
        defaultVariants: styles.defaultVariants || getDefaultVariants(definition),
    };
    const tvInstance = tv(tvConfig);
    const component = fc((props) => {
        // Apply default values
        const propsWithDefaults = {
            ...getDefaultProps(definition),
            ...props,
        };
        if (hasSlots(styles)) {
            // Multi-element component: pass slots object
            const variantProps = extractVariantProps(propsWithDefaults, definition);
            const slots = tvInstance({ ...variantProps });
            // Create slot functions that accept className overrides
            const slotFunctions = {};
            for (const [slotName, slotFn] of Object.entries(slots)) {
                slotFunctions[slotName] = (overrides) => {
                    // Get the slot-specific className prop if it exists
                    const slotClassNameProp = slotName === "base"
                        ? propsWithDefaults.className
                        : propsWithDefaults[`${slotName}ClassName`];
                    // Combine variant classes with user overrides
                    const classOverride = overrides?.class || overrides?.className || slotClassNameProp;
                    return slotFn({ class: classOverride });
                };
            }
            const typedRender = render;
            return typedRender(propsWithDefaults, slotFunctions);
        }
        else {
            // Single-element component: pass className function
            const className = (overrides) => {
                const variantProps = extractVariantProps(propsWithDefaults, definition);
                const userClassName = overrides || propsWithDefaults.className;
                return String(tvInstance({ ...variantProps, class: userClassName }));
            };
            const typedRender = render;
            return typedRender(propsWithDefaults, className);
        }
    });
    // Attach definition for introspection
    component.__def = definition;
    return component;
}
// ============================================================================
// Lit Component Base Class
// ============================================================================
/**
 * Base class for Lit components using the definition system
 */
export class ComponentLitBase extends LitElement {
    createRenderRoot() {
        return this; // Light DOM
    }
    get tvInstance() {
        if (!this._tvInstance) {
            const tvConfig = {
                ...this.styles,
                defaultVariants: this.styles.defaultVariants || getDefaultVariants(this.definition),
            };
            this._tvInstance = tv(tvConfig);
        }
        return this._tvInstance;
    }
    connectedCallback() {
        super.connectedCallback();
        // Apply defaults
        const defaults = getDefaultProps(this.definition);
        Object.entries(defaults).forEach(([key, value]) => {
            if (this[key] === undefined) {
                this[key] = value;
            }
        });
    }
    render() {
        // Capture children on first render if not already captured
        if (!this._children && this.childNodes.length > 0) {
            // Store the actual DOM nodes - Lit can handle them directly
            this._children = Array.from(this.childNodes);
        }
        const props = {};
        // Collect all props
        if (this.definition?.variants) {
            for (const key of Object.keys(this.definition.variants)) {
                props[key] = this[key];
            }
        }
        if (this.definition?.props) {
            for (const key of Object.keys(this.definition.props)) {
                if (key === "children") {
                    props[key] = this._children || Array.from(this.childNodes);
                }
                else {
                    props[key] = this[key];
                }
            }
        }
        props.className = this.className;
        if (hasSlots(this.styles)) {
            // Multi-element component: create slots object
            const variantProps = extractVariantProps(props, this.definition);
            const slotsResult = this.tvInstance({ ...variantProps });
            const slots = (typeof slotsResult === "function" ? {} : slotsResult);
            // Create slot functions that accept className overrides
            const slotFunctions = {};
            for (const [slotName, slotFn] of Object.entries(slots)) {
                slotFunctions[slotName] = (overrides) => {
                    // Get the slot-specific className prop if it exists
                    const slotClassNameProp = slotName === "base" ? props.className : props[`${slotName}ClassName`];
                    // Combine variant classes with user overrides
                    const classOverride = overrides?.class || overrides?.className || slotClassNameProp;
                    return slotFn({ class: classOverride });
                };
            }
            const typedRender = this.renderFn;
            return typedRender(props, slotFunctions);
        }
        else {
            // Single-element component: create className function
            const className = (overrides) => {
                const variantProps = extractVariantProps(props, this.definition);
                const userClassName = overrides || props.className;
                return String(this.tvInstance({ ...variantProps, class: userClassName }));
            };
            const typedRender = this.renderFn;
            return typedRender(props, className);
        }
    }
}
export { createRef, html, nothing, ref } from "./mini.js";
//# sourceMappingURL=component.js.map