import { LitElement } from "lit";
import type { ComponentDefinition, ExtractProps, ExtractStyles, RenderFunction } from "./props.js";
export interface LitComponentClass<Props> {
   new (): LitElement & Props;
   readonly properties: any;
   prototype: LitElement & Props;
}
export declare function createLitComponent<T extends ComponentDefinition>(
   definition: T,
   styles: ExtractStyles<T>,
   renderFn: RenderFunction<ExtractProps<T>, ExtractStyles<T>>,
): LitComponentClass<ExtractProps<T>>;
//# sourceMappingURL=createLitComponent.d.ts.map
