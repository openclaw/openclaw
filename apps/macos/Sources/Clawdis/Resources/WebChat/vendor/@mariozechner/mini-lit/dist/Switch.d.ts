import { type ComponentPropsWithoutChildren, type TemplateResult } from "./mini.js";
interface SwitchProps extends ComponentPropsWithoutChildren {
    checked?: boolean;
    disabled?: boolean;
    label?: TemplateResult | string;
    name?: string;
    id?: string;
    onChange?: (checked: boolean) => void;
}
export declare function Switch(props: SwitchProps): TemplateResult;
export declare function Switch(checked?: boolean, onChange?: (checked: boolean) => void, label?: TemplateResult | string, disabled?: boolean, className?: string): TemplateResult;
export {};
//# sourceMappingURL=Switch.d.ts.map