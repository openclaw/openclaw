// ============================================================================
// Component Definition Types
// ============================================================================
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
    if (def.props) {
        for (const [key, value] of Object.entries(def.props)) {
            defaults[key] = value.default;
        }
    }
    return defaults;
}
// ============================================================================
// Component Definition Builder
// ============================================================================
// Helper builders for individual properties
class VariantPropertyBuilder {
    constructor(name, parent, _options, _defaultValue, _description) {
        this.name = name;
        this.parent = parent;
        this._options = _options;
        this._defaultValue = _defaultValue;
        this._description = _description;
    }
    options(opts) {
        return new VariantPropertyBuilder(this.name, this.parent, opts, undefined, this._description);
    }
    default(value) {
        if (!this._options) {
            throw new Error(`Variant ${this.name} requires options() to be called before default()`);
        }
        const newDef = {
            ...this.parent.definition,
            variants: {
                ...this.parent.definition.variants,
                [this.name]: {
                    options: this._options,
                    default: value,
                    description: this._description,
                },
            },
        };
        return new ComponentBuilder(newDef);
    }
    describe(desc) {
        return new VariantPropertyBuilder(this.name, this.parent, this._options, this._defaultValue, desc);
    }
}
class PropPropertyBuilder {
    constructor(name, parent, type, _defaultValue, _description) {
        this.name = name;
        this.parent = parent;
        this.type = type;
        this._defaultValue = _defaultValue;
        this._description = _description;
    }
    default(value) {
        const newDef = {
            ...this.parent.definition,
            props: {
                ...this.parent.definition.props,
                [this.name]: {
                    type: this.type,
                    default: value,
                    description: this._description,
                },
            },
        };
        return new ComponentBuilder(newDef);
    }
    describe(desc) {
        return new PropPropertyBuilder(this.name, this.parent, this.type, this._defaultValue, desc);
    }
}
class EnumPropertyBuilder {
    constructor(name, parent, _options, _defaultValue, _description) {
        this.name = name;
        this.parent = parent;
        this._options = _options;
        this._defaultValue = _defaultValue;
        this._description = _description;
    }
    options(opts) {
        return new EnumPropertyBuilder(this.name, this.parent, opts, undefined, this._description);
    }
    default(value) {
        if (!this._options) {
            throw new Error(`Enum ${this.name} requires options() to be called before default()`);
        }
        const newDef = {
            ...this.parent.definition,
            props: {
                ...this.parent.definition.props,
                [this.name]: {
                    type: "enum",
                    options: this._options,
                    default: value,
                    description: this._description,
                },
            },
        };
        return new ComponentBuilder(newDef);
    }
    describe(desc) {
        return new EnumPropertyBuilder(this.name, this.parent, this._options, this._defaultValue, desc);
    }
}
export class ComponentBuilder {
    constructor(definition = { variants: {}, props: {} }) {
        this.definition = definition;
    }
    variant(name) {
        return new VariantPropertyBuilder(name, this);
    }
    string(name) {
        return new PropPropertyBuilder(name, this, "string");
    }
    number(name) {
        return new PropPropertyBuilder(name, this, "number");
    }
    boolean(name) {
        return new PropPropertyBuilder(name, this, "boolean");
    }
    object(name) {
        return new PropPropertyBuilder(name, this, "object");
    }
    array(name) {
        return new PropPropertyBuilder(name, this, "array");
    }
    function(name) {
        return new PropPropertyBuilder(name, this, "function");
    }
    enum(name) {
        return new EnumPropertyBuilder(name, this);
    }
    build() {
        return this.definition;
    }
}
export function componentBuilder() {
    return new ComponentBuilder();
}
// ============================================================================
// Component Factory
// ============================================================================
import { cva } from "class-variance-authority";
import { fc } from "./mini.js";
// ============================================================================
// New Component Definition API
// ============================================================================
// Define a component - just returns what you give it but with proper typing
export function defineComponent(definition) {
    return definition;
}
// Define styles for a component - first param is for typing only
export function styleComponent(_definition, styles) {
    return styles;
}
// Define render function for a component - first param is for typing only
export function renderComponent(_definition, render) {
    return render;
}
// Create the actual component from definition, styles, and render
export function createComponent(definition, styles, render) {
    const variants = cva(styles.base || "", {
        variants: styles.variants,
        defaultVariants: getDefaultVariants(definition),
        compoundVariants: styles.compoundVariants,
    });
    const component = fc((props) => {
        // Apply default values
        const propsWithDefaults = {
            ...getDefaultProps(definition),
            ...props,
        };
        // Wrap variants to match our typed signature
        const typedVariants = (variantProps) => {
            return variants(variantProps);
        };
        return render(propsWithDefaults, typedVariants);
    });
    // Attach definition for introspection
    component.__def = definition;
    return component;
}
//# sourceMappingURL=props.js.map