import { type ComponentPropsWithoutChildren, type TemplateResult } from "./mini.js";
export type SeparatorOrientation = "horizontal" | "vertical";
interface SeparatorProps extends ComponentPropsWithoutChildren {
    orientation?: SeparatorOrientation;
    decorative?: boolean;
}
export declare function Separator(props: SeparatorProps): TemplateResult;
export declare function Separator(orientation?: SeparatorOrientation, className?: string): TemplateResult;
export {};
//# sourceMappingURL=Separator.d.ts.map