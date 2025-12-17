import { type ComponentPropsWithoutChildren, type TemplateResult } from "./mini.js";
interface CheckboxProps extends ComponentPropsWithoutChildren {
    checked?: boolean;
    indeterminate?: boolean;
    disabled?: boolean;
    label?: TemplateResult | string;
    name?: string;
    value?: string;
    id?: string;
    onChange?: (checked: boolean) => void;
}
export declare function Checkbox(props: CheckboxProps): TemplateResult;
export declare function Checkbox(checked?: boolean, onChange?: (checked: boolean) => void, label?: TemplateResult | string, disabled?: boolean, className?: string): TemplateResult;
export {};
//# sourceMappingURL=Checkbox.d.ts.map