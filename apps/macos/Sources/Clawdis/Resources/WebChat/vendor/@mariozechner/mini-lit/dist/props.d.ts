export type VariantDef<T extends readonly string[]> = {
   options: T;
   default: T[number];
   description?: string;
};
export type PropDef<T> =
   | {
        type: "string" | "number" | "boolean" | "object" | "array" | "function";
        default: T;
        description?: string;
     }
   | {
        type: "enum";
        default: T;
        options: readonly T[];
        description?: string;
     };
export type ComponentDefinition = {
   variants?: {
      [key: string]: VariantDef<readonly string[]>;
   };
   props?: {
      [key: string]: PropDef<any>;
   };
};
export type ExtractVariants<T extends ComponentDefinition> = T["variants"] extends infer V
   ? V extends {
        [K in keyof V]: VariantDef<any>;
     }
      ? {
           [K in keyof V]?: V[K] extends {
              options: readonly (infer O)[];
           }
              ? O
              : never;
        }
      : {}
   : {};
export type ExtractRegularProps<T extends ComponentDefinition> = T["props"] extends infer P
   ? P extends {
        [K in keyof P]: PropDef<any>;
     }
      ? {
           [K in keyof P]?: P[K] extends {
              default: infer D;
           }
              ? D
              : never;
        }
      : {}
   : {};
export type BaseComponentProps = {
   className?: string;
};
export type ExtractProps<T extends ComponentDefinition> = ExtractVariants<T> &
   ExtractRegularProps<T> &
   BaseComponentProps;
export type ExtractPropsForClass<T extends ComponentDefinition> = Omit<ExtractProps<T>, "children" | "className">;
type StylesToConfigSchema<S> = S extends {
   variants: infer V;
}
   ? V
   : never;
type ClassProp =
   | {
        class: string;
        className?: never;
     }
   | {
        class?: never;
        className: string;
     }
   | {
        class?: never;
        className?: never;
     };
export type CompoundVariant<Styles> = {
   [K in keyof StylesToConfigSchema<Styles>]?: StylesToConfigSchema<Styles>[K] extends Record<string, any>
      ? keyof StylesToConfigSchema<Styles>[K] | undefined
      : never;
} & ClassProp;
export type ExtractStyles<T extends ComponentDefinition> = {
   base?: string;
   variants: T["variants"] extends infer V
      ? V extends {
           [K in keyof V]: VariantDef<any>;
        }
         ? {
              [K in keyof V]: V[K] extends {
                 options: readonly (infer O)[];
              }
                 ? Record<O extends string ? O : never, string>
                 : never;
           }
         : {}
      : {};
   compoundVariants?: CompoundVariant<ExtractStyles<T>>[];
};
export declare function getDefaultVariants<T extends ComponentDefinition>(def: T): ExtractVariants<T>;
export declare function getDefaultProps<T extends ComponentDefinition>(def: T): ExtractProps<T>;
declare class VariantPropertyBuilder<
   K extends string,
   O extends readonly string[],
   ParentDef extends ComponentDefinition,
> {
   private name;
   private parent;
   private _options?;
   private _defaultValue?;
   private _description?;
   constructor(
      name: K,
      parent: ComponentBuilder<ParentDef>,
      _options?: O | undefined,
      _defaultValue?: O[number] | undefined,
      _description?: string | undefined,
   );
   options<NewO extends readonly string[]>(opts: NewO): VariantPropertyBuilder<K, NewO, ParentDef>;
   default<V extends O[number]>(
      value: V,
   ): ComponentBuilder<{
      variants: ParentDef["variants"] & {
         [key in K]: VariantDef<O>;
      };
      props: ParentDef["props"];
   }>;
   describe(desc: string): VariantPropertyBuilder<K, O, ParentDef>;
}
declare class PropPropertyBuilder<K extends string, T, ParentDef extends ComponentDefinition> {
   private name;
   private parent;
   private type;
   private _defaultValue?;
   private _description?;
   constructor(
      name: K,
      parent: ComponentBuilder<ParentDef>,
      type: "string" | "number" | "boolean" | "object" | "array" | "function",
      _defaultValue?: T | undefined,
      _description?: string | undefined,
   );
   default(value: T): ComponentBuilder<{
      variants: ParentDef["variants"];
      props: ParentDef["props"] & {
         [key in K]: PropDef<T>;
      };
   }>;
   describe(desc: string): PropPropertyBuilder<K, T, ParentDef>;
}
declare class EnumPropertyBuilder<K extends string, T extends string, ParentDef extends ComponentDefinition> {
   private name;
   private parent;
   private _options?;
   private _defaultValue?;
   private _description?;
   constructor(
      name: K,
      parent: ComponentBuilder<ParentDef>,
      _options?: readonly T[] | undefined,
      _defaultValue?: T | undefined,
      _description?: string | undefined,
   );
   options<NewT extends string>(opts: readonly NewT[]): EnumPropertyBuilder<K, NewT, ParentDef>;
   default<V extends T>(
      value: V,
   ): ComponentBuilder<{
      variants: ParentDef["variants"];
      props: ParentDef["props"] & {
         [key in K]: PropDef<T>;
      };
   }>;
   describe(desc: string): EnumPropertyBuilder<K, T, ParentDef>;
}
export declare class ComponentBuilder<
   Def extends ComponentDefinition = {
      variants: {};
      props: {};
   },
> {
   definition: Def;
   constructor(definition?: Def);
   variant<K extends string>(name: K): VariantPropertyBuilder<K, never, Def>;
   string<K extends string>(name: K): PropPropertyBuilder<K, string, Def>;
   number<K extends string>(name: K): PropPropertyBuilder<K, number, Def>;
   boolean<K extends string>(name: K): PropPropertyBuilder<K, boolean, Def>;
   object<T>(name: string): PropPropertyBuilder<string, T, Def>;
   array<T>(name: string): PropPropertyBuilder<string, T[], Def>;
   function<T extends (...args: any[]) => any>(name: string): PropPropertyBuilder<string, T | undefined, Def>;
   enum<K extends string>(name: K): EnumPropertyBuilder<K, string, Def>;
   build(): Def;
}
export declare function componentBuilder(): ComponentBuilder<{
   variants: {};
   props: {};
}>;
import type { TemplateResult } from "lit";
export type VariantPropsFromStyles<S extends ExtractStyles<any>> = {
   [K in keyof S["variants"]]?: keyof S["variants"][K];
} & {
   className?: string;
   class?: string;
};
export type RenderFunction<Props, Styles extends ExtractStyles<any>> = (
   props: Props,
   variants: (props?: VariantPropsFromStyles<Styles>) => string,
) => TemplateResult;
export declare function defineComponent<T extends ComponentDefinition>(definition: T): T;
export declare function styleComponent<T extends ComponentDefinition>(
   _definition: T,
   styles: ExtractStyles<T>,
): ExtractStyles<T>;
export declare function renderComponent<T extends ComponentDefinition>(
   _definition: T,
   render: RenderFunction<ExtractProps<T>, ExtractStyles<T>>,
): RenderFunction<ExtractProps<T>, ExtractStyles<T>>;
export declare function createComponent<T extends ComponentDefinition>(
   definition: T,
   styles: ExtractStyles<T>,
   render: RenderFunction<ExtractProps<T>, ExtractStyles<T>>,
): import("./mini.js").Component<ExtractProps<T>>;
//# sourceMappingURL=props.d.ts.map
