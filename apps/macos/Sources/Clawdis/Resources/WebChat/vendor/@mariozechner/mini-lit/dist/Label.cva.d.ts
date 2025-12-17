import { ComponentLitBase, type ExtractProps, type ExtractPropsForClass } from "./component.js";
export declare const labelDefinition: Omit<{
    tag: string;
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
            description: string;
        };
    };
}, "props"> & {
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
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
export declare const labelDefaultStyle: import("./component.js").SimpleStyles<Omit<{
    tag: string;
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
            description: string;
        };
    };
}, "props"> & {
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
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
export declare const renderLabel: (props: ExtractProps<Omit<{
    tag: string;
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
            description: string;
        };
    };
}, "props"> & {
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
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
export declare function createLabel(styles: typeof labelDefaultStyle): import("./mini.js").Component<ExtractProps<Omit<{
    tag: string;
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
            description: string;
        };
    };
}, "props"> & {
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
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
export declare const Label: import("./mini.js").Component<ExtractProps<Omit<{
    tag: string;
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
            description: string;
        };
    };
}, "props"> & {
    props: {
        for: {
            type: "string";
            default: string | undefined;
            description: string;
        };
        required: {
            type: "boolean";
            default: false;
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
export type LabelProps = ExtractProps<typeof labelDefinition>;
export type LabelPropsForClass = ExtractPropsForClass<typeof labelDefinition>;
export type LabelStyles = typeof labelDefaultStyle;
export declare class MiniLabel extends ComponentLitBase<typeof labelDefinition> implements LabelPropsForClass {
    for: LabelProps["for"];
    required: LabelProps["required"];
    protected definition: Omit<{
        tag: string;
        props: {
            for: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            required: {
                type: "boolean";
                default: false;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            for: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            required: {
                type: "boolean";
                default: false;
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
        props: {
            for: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            required: {
                type: "boolean";
                default: false;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            for: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            required: {
                type: "boolean";
                default: false;
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
        props: {
            for: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            required: {
                type: "boolean";
                default: false;
                description: string;
            };
        };
    }, "props"> & {
        props: {
            for: {
                type: "string";
                default: string | undefined;
                description: string;
            };
            required: {
                type: "boolean";
                default: false;
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
        "mini-label": MiniLabel;
    }
}
//# sourceMappingURL=Label.cva.d.ts.map