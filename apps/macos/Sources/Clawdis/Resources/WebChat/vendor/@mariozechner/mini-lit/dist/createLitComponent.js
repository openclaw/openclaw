import { cva } from "class-variance-authority";
import { LitElement } from "lit";
import { getDefaultProps, getDefaultVariants } from "./props.js";
export function createLitComponent(definition, styles, renderFn) {
    const variants = cva(styles.base || "", {
        variants: styles.variants,
        defaultVariants: getDefaultVariants(definition),
        compoundVariants: styles.compoundVariants,
    });
    // Create a base class
    class Component extends LitElement {
        // No shadow DOM - use light DOM
        createRenderRoot() {
            return this;
        }
        // Generate reactive properties from definition
        static get properties() {
            const props = {};
            // Add variants
            if (definition.variants) {
                for (const key of Object.keys(definition.variants)) {
                    props[key] = { type: String };
                }
            }
            // Add regular props
            if (definition.props) {
                for (const [key, def] of Object.entries(definition.props)) {
                    const type = def.type === "boolean"
                        ? Boolean
                        : def.type === "number"
                            ? Number
                            : def.type === "string" || def.type === "enum"
                                ? String
                                : Object;
                    props[key] = { type };
                }
            }
            props.className = { type: String };
            return props;
        }
        constructor() {
            super();
            // Apply defaults
            const defaults = getDefaultProps(definition);
            Object.assign(this, defaults);
        }
        render() {
            // Collect all props into a typed object
            const props = {};
            // Collect variant values
            if (definition.variants) {
                for (const key of Object.keys(definition.variants)) {
                    props[key] = this[key];
                }
            }
            // Collect regular props
            if (definition.props) {
                for (const key of Object.keys(definition.props)) {
                    props[key] = this[key];
                }
            }
            props.className = this.className;
            // Create typed variants function
            const typedVariants = (variantProps) => {
                return variants(variantProps);
            };
            return renderFn(props, typedVariants);
        }
    }
    // Cast to the properly typed interface
    return Component;
}
//# sourceMappingURL=createLitComponent.js.map