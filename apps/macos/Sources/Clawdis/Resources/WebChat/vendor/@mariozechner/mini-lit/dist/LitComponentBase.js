import { cva } from "class-variance-authority";
import { LitElement } from "lit";
import { getDefaultProps, getDefaultVariants } from "./props.js";
/**
 * Generic base class for Lit components using the component definition system
 */
export class LitComponentBase extends LitElement {
    // No shadow DOM - use light DOM by default
    createRenderRoot() {
        return this;
    }
    /**
     * Get the CVA variants function
     */
    get variants() {
        if (!this._variants) {
            this._variants = cva(this.styles.base || "", {
                variants: this.styles.variants,
                defaultVariants: getDefaultVariants(this.definition),
                compoundVariants: this.styles.compoundVariants,
            });
        }
        return this._variants;
    }
    /**
     * Generate Lit reactive properties from definition
     */
    static createProperties(definition) {
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
        // Apply default values
        // Note: definition is abstract, so this will be called after subclass constructor
        // where definition is set
        requestAnimationFrame(() => {
            if (this.definition) {
                const defaults = getDefaultProps(this.definition);
                Object.entries(defaults).forEach(([key, value]) => {
                    if (this[key] === undefined) {
                        this[key] = value;
                    }
                });
            }
        });
    }
    /**
     * Collect all current props into a typed object
     */
    collectProps() {
        const props = {};
        // Collect variant values
        if (this.definition?.variants) {
            for (const key of Object.keys(this.definition.variants)) {
                props[key] = this[key];
            }
        }
        // Collect regular props
        if (this.definition?.props) {
            for (const key of Object.keys(this.definition.props)) {
                props[key] = this[key];
            }
        }
        props.className = this.className;
        return props;
    }
    /**
     * Create typed variants function for rendering
     */
    createVariantsFunction() {
        return (variantProps) => {
            return this.variants(variantProps);
        };
    }
    /**
     * Default Lit render method
     */
    render() {
        const props = this.collectProps();
        const variantsFn = this.createVariantsFunction();
        return this.renderFn(props, variantsFn);
    }
}
//# sourceMappingURL=LitComponentBase.js.map