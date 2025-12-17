import { ComponentLitBase, type ExtractProps, type ExtractPropsForClass } from "./component.js";
export declare const buttonDefinition: Omit<{
    tag: string;
    variants: {
        variant: {
            options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
            default: string;
            description: string;
        };
        size: {
            options: readonly ["default", "sm", "lg", "icon"];
            default: string;
            description: string;
        };
    };
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
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
export declare const buttonDefaultStyle: import("./component.js").SimpleStyles<Omit<{
    tag: string;
    variants: {
        variant: {
            options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
            default: string;
            description: string;
        };
        size: {
            options: readonly ["default", "sm", "lg", "icon"];
            default: string;
            description: string;
        };
    };
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
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
export declare const renderButton: (props: ExtractProps<Omit<{
    tag: string;
    variants: {
        variant: {
            options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
            default: string;
            description: string;
        };
        size: {
            options: readonly ["default", "sm", "lg", "icon"];
            default: string;
            description: string;
        };
    };
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
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
export declare function createButton(styles: typeof buttonDefaultStyle): import("./mini.js").Component<ExtractProps<Omit<{
    tag: string;
    variants: {
        variant: {
            options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
            default: string;
            description: string;
        };
        size: {
            options: readonly ["default", "sm", "lg", "icon"];
            default: string;
            description: string;
        };
    };
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
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
export declare const Button: import("./mini.js").Component<ExtractProps<Omit<{
    tag: string;
    variants: {
        variant: {
            options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
            default: string;
            description: string;
        };
        size: {
            options: readonly ["default", "sm", "lg", "icon"];
            default: string;
            description: string;
        };
    };
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
            description: string;
        };
    };
}, "props"> & {
    props: {
        disabled: {
            type: "boolean";
            default: false;
            description: string;
        };
        loading: {
            type: "boolean";
            default: false;
            description: string;
        };
        onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
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
export type ButtonProps = ExtractProps<typeof buttonDefinition>;
export type ButtonPropsForClass = ExtractPropsForClass<typeof buttonDefinition>;
export type ButtonStyles = typeof buttonDefaultStyle;
export declare class MiniButton extends ComponentLitBase<typeof buttonDefinition> implements ButtonPropsForClass {
    variant?: ButtonProps["variant"];
    size?: ButtonProps["size"];
    disabled: ButtonProps["disabled"];
    loading: ButtonProps["loading"];
    onClick: ButtonProps["onClick"];
    protected definition: Omit<{
        tag: string;
        variants: {
            variant: {
                options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
                default: string;
                description: string;
            };
            size: {
                options: readonly ["default", "sm", "lg", "icon"];
                default: string;
                description: string;
            };
        };
        props: {
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            loading: {
                type: "boolean";
                default: false;
                description: string;
            };
            onClick: {
                type: "function";
                default: ((e: MouseEvent) => void) | undefined;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            loading: {
                type: "boolean";
                default: false;
                description: string;
            };
            onClick: {
                type: "function";
                default: ((e: MouseEvent) => void) | undefined;
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
            variant: {
                options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
                default: string;
                description: string;
            };
            size: {
                options: readonly ["default", "sm", "lg", "icon"];
                default: string;
                description: string;
            };
        };
        props: {
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            loading: {
                type: "boolean";
                default: false;
                description: string;
            };
            onClick: {
                type: "function";
                default: ((e: MouseEvent) => void) | undefined;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            loading: {
                type: "boolean";
                default: false;
                description: string;
            };
            onClick: {
                type: "function";
                default: ((e: MouseEvent) => void) | undefined;
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
            variant: {
                options: readonly ["default", "destructive", "outline", "secondary", "ghost", "link"];
                default: string;
                description: string;
            };
            size: {
                options: readonly ["default", "sm", "lg", "icon"];
                default: string;
                description: string;
            };
        };
        props: {
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            loading: {
                type: "boolean";
                default: false;
                description: string;
            };
            onClick: {
                type: "function";
                default: ((e: MouseEvent) => void) | undefined;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            disabled: {
                type: "boolean";
                default: false;
                description: string;
            };
            loading: {
                type: "boolean";
                default: false;
                description: string;
            };
            onClick: {
                type: "function";
                default: ((e: MouseEvent) => void) | undefined;
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
    connectedCallback(): void;
}
declare global {
    interface HTMLElementTagNameMap {
        "mini-button": MiniButton;
    }
}
//# sourceMappingURL=Button.cva.d.ts.map