import { type ComponentPropsWithoutChildren, type TemplateResult } from "./mini.js";
interface ProgressProps extends ComponentPropsWithoutChildren {
    value?: number;
    max?: number;
    indicatorClassName?: string;
}
export declare function Progress(props: ProgressProps): TemplateResult;
export declare function Progress(value?: number, max?: number, className?: string): TemplateResult;
export {};
//# sourceMappingURL=Progress.d.ts.map