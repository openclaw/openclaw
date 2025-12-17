import { LitElement } from "lit";
import type {
   ComponentDefinition,
   ExtractProps,
   ExtractStyles,
   RenderFunction,
   VariantPropsFromStyles,
} from "./props.js";
/**
 * Generic base class for Lit components using the component definition system
 */
export declare abstract class LitComponentBase<T extends ComponentDefinition> extends LitElement {
   [key: string]: any;
   createRenderRoot(): this;
   /**
    * Subclasses must provide the component definition
    */
   protected abstract definition: T;
   /**
    * Subclasses must provide the styles
    */
   protected abstract styles: ExtractStyles<T>;
   /**
    * Subclasses must provide the render function
    */
   protected abstract renderFn: RenderFunction<ExtractProps<T>, ExtractStyles<T>>;
   /**
    * CVA variants instance - lazily initialized
    */
   private _variants?;
   /**
    * Get the CVA variants function
    */
   protected get variants(): (props?: import("class-variance-authority/types").ClassProp | undefined) => string;
   /**
    * Generate Lit reactive properties from definition
    */
   static createProperties(definition: ComponentDefinition): any;
   constructor();
   /**
    * Collect all current props into a typed object
    */
   protected collectProps(): ExtractProps<T>;
   /**
    * Create typed variants function for rendering
    */
   protected createVariantsFunction(): (variantProps?: VariantPropsFromStyles<ExtractStyles<T>>) => string;
   /**
    * Default Lit render method
    */
   render(): import("lit-html").TemplateResult;
}
//# sourceMappingURL=LitComponentBase.d.ts.map
