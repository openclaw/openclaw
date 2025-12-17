import { ComponentLitBase, type ExtractProps, type ExtractPropsForClass } from "./component.js";
export declare const checkboxDefinition: Omit<{
    tag: string;
    variants: {
        size: {
            options: readonly ["sm", "md", "lg"];
            default: string;
            description: string;
        };
        variant: {
            options: readonly ["default", "primary", "destructive"];
            default: string;
            description: string;
        };
    };
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    } & {
        className: Extract<import("./component.js").PropDef<unknown>, {
            type: "classname";
        }>;
        children: Extract<import("./component.js").PropDef<unknown>, {
            type: "children";
        }>;
    } & Record<never, never>;
};
export declare const checkboxDefaultStyle: import("./component.js").SimpleStyles<Omit<{
    tag: string;
    variants: {
        size: {
            options: readonly ["sm", "md", "lg"];
            default: string;
            description: string;
        };
        variant: {
            options: readonly ["default", "primary", "destructive"];
            default: string;
            description: string;
        };
    };
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    } & {
        className: Extract<import("./component.js").PropDef<unknown>, {
            type: "classname";
        }>;
        children: Extract<import("./component.js").PropDef<unknown>, {
            type: "children";
        }>;
    } & Record<never, never>;
}>;
export declare const renderCheckbox: (props: ExtractProps<Omit<{
    tag: string;
    variants: {
        size: {
            options: readonly ["sm", "md", "lg"];
            default: string;
            description: string;
        };
        variant: {
            options: readonly ["default", "primary", "destructive"];
            default: string;
            description: string;
        };
    };
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    } & {
        className: Extract<import("./component.js").PropDef<unknown>, {
            type: "classname";
        }>;
        children: Extract<import("./component.js").PropDef<unknown>, {
            type: "children";
        }>;
    } & Record<never, never>;
}>, className: (overrides?: import("tailwind-merge").ClassNameValue) => string) => import("lit-html").TemplateResult;
export declare function createCheckbox(styles: typeof checkboxDefaultStyle): import("./mini.js").Component<ExtractProps<Omit<{
    tag: string;
    variants: {
        size: {
            options: readonly ["sm", "md", "lg"];
            default: string;
            description: string;
        };
        variant: {
            options: readonly ["default", "primary", "destructive"];
            default: string;
            description: string;
        };
    };
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    } & {
        className: Extract<import("./component.js").PropDef<unknown>, {
            type: "classname";
        }>;
        children: Extract<import("./component.js").PropDef<unknown>, {
            type: "children";
        }>;
    } & Record<never, never>;
}>>;
export declare const Checkbox: import("./mini.js").Component<ExtractProps<Omit<{
    tag: string;
    variants: {
        size: {
            options: readonly ["sm", "md", "lg"];
            default: string;
            description: string;
        };
        variant: {
            options: readonly ["default", "primary", "destructive"];
            default: string;
            description: string;
        };
    };
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        checked: {
            type: "boolean";
            default: false;
            description: string;
        };
        indeterminate: {
            type: "boolean";
            default: false;
            description: string;
        };
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        name: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        value: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        id: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        onChange: {
            type: "function";
            default: ((checked: boolean) => void) | undefined;
            description: string;
        };
    } & {
        className: Extract<import("./component.js").PropDef<unknown>, {
            type: "classname";
        }>;
        children: Extract<import("./component.js").PropDef<unknown>, {
            type: "children";
        }>;
    } & Record<never, never>;
}>>;
export type CheckboxProps = ExtractProps<typeof checkboxDefinition>;
export type CheckboxPropsForClass = ExtractPropsForClass<typeof checkboxDefinition>;
export type CheckboxStyles = typeof checkboxDefaultStyle;
export declare class MiniCheckbox extends ComponentLitBase<typeof checkboxDefinition, typeof checkboxDefaultStyle> implements CheckboxPropsForClass {
    size?: CheckboxProps["size"];
    variant?: CheckboxProps["variant"];
    checked: CheckboxProps["checked"];
    indeterminate: CheckboxProps["indeterminate"];
    disabled: CheckboxProps["disabled"];
    name: CheckboxProps["name"];
    value: CheckboxProps["value"];
    id: string;
    onChange: CheckboxProps["onChange"];
    protected definition: Omit<{
        tag: string;
        variants: {
            size: {
                options: readonly ["sm", "md", "lg"];
                default: string;
                description: string;
            };
            variant: {
                options: readonly ["default", "primary", "destructive"];
                default: string;
                description: string;
            };
        };
        props: {
            checked: {
                type: "boolean";
                default: false;
                description: string;
            };
            indeterminate: {
                type: "boolean";
                default: false;
                description: string;
            };
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            name: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            value: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            id: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            onChange: {
                type: "function";
                default: ((checked: boolean) => void) | undefined;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            checked: {
                type: "boolean";
                default: false;
                description: string;
            };
            indeterminate: {
                type: "boolean";
                default: false;
                description: string;
            };
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            name: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            value: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            id: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            onChange: {
                type: "function";
                default: ((checked: boolean) => void) | undefined;
                description: string;
            };
        } & {
            className: Extract<import("./component.js").PropDef<unknown>, {
                type: "classname";
            }>;
            children: Extract<import("./component.js").PropDef<unknown>, {
                type: "children";
            }>;
        } & Record<never, never>;
    };
    protected styles: import("./component.js").SimpleStyles<Omit<{
        tag: string;
        variants: {
            size: {
                options: readonly ["sm", "md", "lg"];
                default: string;
                description: string;
            };
            variant: {
                options: readonly ["default", "primary", "destructive"];
                default: string;
                description: string;
            };
        };
        props: {
            checked: {
                type: "boolean";
                default: false;
                description: string;
            };
            indeterminate: {
                type: "boolean";
                default: false;
                description: string;
            };
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            name: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            value: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            id: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            onChange: {
                type: "function";
                default: ((checked: boolean) => void) | undefined;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            checked: {
                type: "boolean";
                default: false;
                description: string;
            };
            indeterminate: {
                type: "boolean";
                default: false;
                description: string;
            };
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            name: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            value: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            id: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            onChange: {
                type: "function";
                default: ((checked: boolean) => void) | undefined;
                description: string;
            };
        } & {
            className: Extract<import("./component.js").PropDef<unknown>, {
                type: "classname";
            }>;
            children: Extract<import("./component.js").PropDef<unknown>, {
                type: "children";
            }>;
        } & Record<never, never>;
    }>;
    protected renderFn: (props: ExtractProps<Omit<{
        tag: string;
        variants: {
            size: {
                options: readonly ["sm", "md", "lg"];
                default: string;
                description: string;
            };
            variant: {
                options: readonly ["default", "primary", "destructive"];
                default: string;
                description: string;
            };
        };
        props: {
            checked: {
                type: "boolean";
                default: false;
                description: string;
            };
            indeterminate: {
                type: "boolean";
                default: false;
                description: string;
            };
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            name: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            value: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            id: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            onChange: {
                type: "function";
                default: ((checked: boolean) => void) | undefined;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            checked: {
                type: "boolean";
                default: false;
                description: string;
            };
            indeterminate: {
                type: "boolean";
                default: false;
                description: string;
            };
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            name: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            value: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            id: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            onChange: {
                type: "function";
                default: ((checked: boolean) => void) | undefined;
                description: string;
            };
        } & {
            className: Extract<import("./component.js").PropDef<unknown>, {
                type: "classname";
            }>;
            children: Extract<import("./component.js").PropDef<unknown>, {
                type: "children";
            }>;
        } & Record<never, never>;
    }>, className: (overrides?: import("tailwind-merge").ClassNameValue) => string) => import("lit-html").TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "mini-checkbox": MiniCheckbox;
    }
}
//# sourceMappingURL=Checkbox.cva.d.ts.map