import { type BaseComponentProps, type TemplateResult } from "./mini.js";
interface LabelProps extends BaseComponentProps {
    htmlFor?: string;
    required?: boolean;
}
export declare function Label(props: LabelProps): TemplateResult;
export declare function Label(children: TemplateResult | string, htmlFor?: string, required?: boolean, className?: string): TemplateResult;
export {};
//# sourceMappingURL=Label.d.ts.map