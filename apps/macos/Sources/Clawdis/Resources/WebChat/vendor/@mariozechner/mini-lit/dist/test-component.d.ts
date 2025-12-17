import { type ExtractProps } from "./props.js";
export declare const Card: import("./mini.js").Component<
   ExtractProps<{
      readonly variant: {
         readonly type: "variant";
         readonly options: readonly ["default", "bordered", "elevated"];
         readonly default: "default";
         readonly description: "Card style variant";
      };
      readonly padding: {
         readonly type: "variant";
         readonly options: readonly ["none", "sm", "md", "lg"];
         readonly default: "md";
         readonly description: "Padding size";
      };
      readonly title: {
         readonly type: "value";
         readonly default: string;
         readonly description: "Card title";
      };
      readonly children: {
         readonly type: "value";
         readonly default: any;
         readonly description: "Card content";
      };
      readonly onClick: {
         readonly type: "function";
         readonly default: ((e: MouseEvent) => void) | undefined;
         readonly description: "Click handler";
      };
   }>
>;
//# sourceMappingURL=test-component.d.ts.map
