import { LitElement, type TemplateResult } from "lit";
import { type ClassValue } from "tailwind-variants";
export type VariantDef<T extends readonly string[]> = {
    options: T;
    default: T[number];
    description?: string;
};
export type PropDef<T> = {
    type: "string";
    default: string | undefined;
    description?: string;
} | {
    type: "number";
    default: number | undefined;
    description?: string;
} | {
    type: "boolean";
    default: boolean | undefined;
    description?: string;
} | {
    type: "object";
    default: T;
    description?: string;
} | {
    type: "array";
    default: T[] | undefined;
    description?: string;
} | {
    type: "function";
    default: T | undefined;
    description?: string;
} | {
    type: "enum";
    default: T;
    options: readonly T[];
    description?: string;
} | {
    type: "classname";
    default: string | undefined;
    description?: string;
} | {
    type: "children";
    default: ComponentChild | undefined;
    description?: string;
};
type PropDictionary = Record<string, PropDef<unknown>>;
export type ComponentChild = TemplateResult | string | number | Node | Node[];
type BasePropDefinitions = {
    className: Extract<PropDef<unknown>, {
        type: "classname";
    }>;
    children: Extract<PropDef<unknown>, {
        type: "children";
    }>;
};
type WithBaseProps<P extends PropDictionary | undefined> = (P extends PropDictionary ? {
    [K in keyof P]: P[K];
} : Record<string, never>) & BasePropDefinitions;
type PropValue<P> = P extends {
    type: "boolean";
} ? boolean | undefined : P extends {
    type: "string";
} ? string | undefined : P extends {
    type: "number";
} ? number | undefined : P extends {
    type: "classname";
} ? string | undefined : P extends {
    type: "children";
} ? ComponentChild | undefined : P extends {
    type: "enum";
    options: readonly (infer O)[];
} ? O : P extends {
    default: infer D;
} ? D : never;
export type ComponentDefinition = {
    tag: string;
    slots?: readonly string[];
    variants?: {
        [key: string]: VariantDef<readonly string[]>;
    };
    props?: PropDictionary;
};
type SlotClassNameProps<T extends ComponentDefinition> = T["slots"] extends readonly string[] ? {
    [K in T["slots"][number] as K extends "base" ? never : `${K}ClassName`]: {
        type: "classname";
        default: undefined;
        description: string;
    };
} : Record<never, never>;
export type ExtractVariants<T extends ComponentDefinition> = T["variants"] extends infer V ? V extends {
    [K in keyof V]: VariantDef<readonly string[]>;
} ? {
    [K in keyof V]?: V[K] extends {
        options: readonly (infer O)[];
    } ? O : never;
} : Record<string, never> : Record<string, never>;
type NormalizedPropDefinitions<T extends ComponentDefinition> = WithBaseProps<T["props"]> & SlotClassNameProps<T>;
export type ExtractRegularProps<T extends ComponentDefinition> = {
    [K in keyof NormalizedPropDefinitions<T>]?: PropValue<NormalizedPropDefinitions<T>[K]>;
};
export type BaseComponentProps = {
    className?: string;
    children?: ComponentChild;
};
export type ExtractProps<T extends ComponentDefinition> = ExtractVariants<T> & ExtractRegularProps<T>;
type ConflictingHTMLElementProps = "accessKey" | "className" | "contentEditable" | "dir" | "draggable" | "hidden" | "id" | "lang" | "slot" | "spellCheck" | "style" | "tabIndex" | "title" | "translate";
type ClassPropKeys<T extends ComponentDefinition> = Exclude<keyof NormalizedPropDefinitions<T>, "children" | ConflictingHTMLElementProps>;
type DefinitionPropValues<T extends ComponentDefinition> = {
    [K in keyof NormalizedPropDefinitions<T>]: PropValue<NormalizedPropDefinitions<T>[K]>;
};
type RequiredDefinitionProps<T extends ComponentDefinition> = Pick<DefinitionPropValues<T>, ClassPropKeys<T>>;
export type ExtractPropsForClass<T extends ComponentDefinition> = ExtractVariants<T> & RequiredDefinitionProps<T>;
type MapVariantToTV<V extends VariantDef<readonly string[]>> = V extends {
    options: readonly (infer O)[];
} ? Record<O extends string ? O : never, string> : never;
type MapVariantsToTV<T extends ComponentDefinition> = T["variants"] extends infer V ? V extends {
    [K in keyof V]: VariantDef<readonly string[]>;
} ? {
    [K in keyof V]: MapVariantToTV<V[K]>;
} : Record<string, never> : Record<string, never>;
export type SimpleStyles<T extends ComponentDefinition> = {
    base?: string;
    variants?: MapVariantsToTV<T>;
    defaultVariants?: ExtractVariants<T>;
    compoundVariants?: Array<Partial<ExtractVariants<T>> & {
        class?: string;
        className?: string;
    }>;
};
export type SlotStyles<T extends ComponentDefinition, Slots extends Record<string, string>> = {
    slots: Slots;
    variants?: {
        [K in keyof MapVariantsToTV<T>]: {
            [V in keyof MapVariantsToTV<T>[K]]: Partial<Slots> | string;
        };
    };
    defaultVariants?: ExtractVariants<T>;
    compoundVariants?: Array<Partial<ExtractVariants<T>> & {
        class?: Partial<Slots> | string;
        className?: never;
    }>;
};
export type ComponentStyles<T extends ComponentDefinition> = SimpleStyles<T> | SlotStyles<T, Record<string, string>>;
export type ExtractStyles<T extends ComponentDefinition> = SimpleStyles<T>;
export declare function getDefaultVariants<T extends ComponentDefinition>(def: T): ExtractVariants<T>;
export declare function getDefaultProps<T extends ComponentDefinition>(def: T): ExtractProps<T>;
type TVSlotResult<S> = S extends {
    slots: infer Slots;
} ? {
    [K in keyof Slots]: (props?: {
        class?: ClassValue;
        className?: ClassValue;
    }) => string;
} : never;
export type VariantPropsFromStyles<S> = S extends SimpleStyles<ComponentDefinition> ? {
    [K in keyof NonNullable<S["variants"]>]?: keyof NonNullable<S["variants"]>[K];
} & {
    className?: string;
    class?: string;
} : never;
export type RenderFunction<Props, Styles> = Styles extends {
    slots: Record<string, string>;
} ? (props: Props, slots: TVSlotResult<Styles>) => TemplateResult : (props: Props, className: (overrides?: ClassValue) => string) => TemplateResult;
type ComponentWithBaseProps<T extends ComponentDefinition> = Omit<T, "props"> & {
    props: NormalizedPropDefinitions<T>;
};
export declare function defineComponent<T extends ComponentDefinition>(definition: T): ComponentWithBaseProps<T>;
export declare function styleComponent<T extends ComponentDefinition>(definition: T, styles: SimpleStyles<T>): SimpleStyles<T>;
export declare function styleComponent<T extends ComponentDefinition, S extends Record<string, string>>(definition: T, styles: SlotStyles<T, S>): SlotStyles<T, S>;
export declare function renderComponent<T extends ComponentDefinition, S extends ComponentStyles<T>>(_definition: T, _styles: S, render: RenderFunction<ExtractProps<T>, S>): RenderFunction<ExtractProps<T>, S>;
export declare function createComponent<T extends ComponentDefinition, S extends ComponentStyles<T>>(definition: T, styles: S, render: RenderFunction<ExtractProps<T>, S>): import("./mini.js").Component<ExtractProps<T>>;
/**
 * Base class for Lit components using the definition system
 */
export declare abstract class ComponentLitBase<T extends ComponentDefinition, S extends ComponentStyles<T> = ComponentStyles<T>> extends LitElement {
    protected abstract definition: T;
    protected abstract styles: S;
    protected abstract renderFn: RenderFunction<ExtractProps<T>, S>;
    private _tvInstance?;
    private _children?;
    createRenderRoot(): this;
    protected get tvInstance(): (props?: Record<string, unknown>) => string | Record<string, (props?: {
        class?: ClassValue;
    }) => string>;
    connectedCallback(): void;
    render(): TemplateResult;
}
export type { Ref, TemplateResult } from "./mini.js";
export { createRef, html, nothing, ref } from "./mini.js";
//# sourceMappingURL=component.d.ts.map