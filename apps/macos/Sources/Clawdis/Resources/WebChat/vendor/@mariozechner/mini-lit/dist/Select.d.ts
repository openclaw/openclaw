import { type TemplateResult } from "lit";
export interface SelectOption {
    value: string;
    label: string;
    icon?: TemplateResult | string;
    disabled?: boolean;
}
export interface SelectGroup {
    label?: string;
    options: SelectOption[];
}
export interface SelectProps {
    value?: string;
    placeholder?: string;
    options: SelectOption[] | SelectGroup[];
    onChange: (value: string) => void;
    disabled?: boolean;
    className?: string;
    width?: string | undefined;
    size?: "sm" | "md" | "lg";
    variant?: "default" | "ghost" | "outline";
    fitContent?: boolean;
}
export declare function Select(props: SelectProps): TemplateResult;
//# sourceMappingURL=Select.d.ts.map