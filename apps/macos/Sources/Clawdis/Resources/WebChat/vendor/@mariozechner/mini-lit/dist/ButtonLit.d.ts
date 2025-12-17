import { definition } from "./Button.cva.js";
import { LitComponentBase } from "./LitComponentBase.js";
/**
 * Button component as a Lit element.
 * The generic parameter provides full type safety for all props.
 */
export declare class MiniButton extends LitComponentBase<typeof definition> {
   protected definition: {
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
            default: boolean;
            description: string;
         };
         loading: {
            type: "boolean";
            default: boolean;
            description: string;
         };
         children: {
            type: "object";
            default: (import("lit-html").TemplateResult | string | number) | undefined;
            description: string;
         };
         onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
            description: string;
         };
      };
   };
   protected styles: import("./props.js").ExtractStyles<{
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
            default: boolean;
            description: string;
         };
         loading: {
            type: "boolean";
            default: boolean;
            description: string;
         };
         children: {
            type: "object";
            default: (import("lit-html").TemplateResult | string | number) | undefined;
            description: string;
         };
         onClick: {
            type: "function";
            default: ((e: MouseEvent) => void) | undefined;
            description: string;
         };
      };
   }>;
   protected renderFn: import("./props.js").RenderFunction<
      import("./props.js").ExtractProps<{
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
               default: boolean;
               description: string;
            };
            loading: {
               type: "boolean";
               default: boolean;
               description: string;
            };
            children: {
               type: "object";
               default: (import("lit-html").TemplateResult | string | number) | undefined;
               description: string;
            };
            onClick: {
               type: "function";
               default: ((e: MouseEvent) => void) | undefined;
               description: string;
            };
         };
      }>,
      import("./props.js").ExtractStyles<{
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
               default: boolean;
               description: string;
            };
            loading: {
               type: "boolean";
               default: boolean;
               description: string;
            };
            children: {
               type: "object";
               default: (import("lit-html").TemplateResult | string | number) | undefined;
               description: string;
            };
            onClick: {
               type: "function";
               default: ((e: MouseEvent) => void) | undefined;
               description: string;
            };
         };
      }>
   >;
   static properties: any;
   connectedCallback(): void;
   reset(): void;
}
//# sourceMappingURL=ButtonLit.d.ts.map
