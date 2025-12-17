import { type BaseComponentProps, type TemplateResult } from "./mini.js";
interface TextareaProps extends BaseComponentProps {
    id?: string;
    value?: string;
    placeholder?: string;
    label?: string;
    error?: string;
    disabled?: boolean;
    required?: boolean;
    name?: string;
    rows?: number;
    cols?: number;
    maxLength?: number;
    resize?: "none" | "both" | "horizontal" | "vertical";
    onInput?: (e: Event) => void;
    onChange?: (e: Event) => void;
}
export declare function Textarea(props: TextareaProps): TemplateResult;
export declare function Textarea(value?: string, placeholder?: string, onInput?: (e: Event) => void, rows?: number, className?: string): TemplateResult;
export {};
//# sourceMappingURL=Textarea.d.ts.map