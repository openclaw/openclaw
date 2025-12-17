import { type Ref } from "lit/directives/ref.js";
import { type BaseComponentProps } from "./mini.js";
export type InputType = "text" | "email" | "password" | "number" | "url" | "tel" | "search" | "date";
export type InputSize = "sm" | "md" | "lg";
export interface InputProps extends BaseComponentProps {
    id?: string;
    type?: InputType;
    size?: InputSize;
    value?: string;
    placeholder?: string;
    label?: string;
    error?: string;
    disabled?: boolean;
    readonly?: boolean;
    required?: boolean;
    name?: string;
    autocomplete?: string;
    min?: number;
    max?: number;
    step?: number;
    inputRef?: Ref<HTMLInputElement>;
    onInput?: (e: Event) => void;
    onChange?: (e: Event) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
    onKeyUp?: (e: KeyboardEvent) => void;
}
export declare const Input: import("./mini.js").Component<InputProps>;
//# sourceMappingURL=Input.d.ts.map