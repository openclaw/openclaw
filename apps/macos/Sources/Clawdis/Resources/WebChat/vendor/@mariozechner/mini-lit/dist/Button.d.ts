import { type BaseComponentProps } from "./mini.js";
export type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg" | "icon";
export interface ButtonProps extends BaseComponentProps {
    variant?: ButtonVariant;
    size?: ButtonSize;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    loading?: boolean;
    onClick?: (e: Event) => void;
    title?: string;
}
export declare const Button: import("./mini.js").Component<ButtonProps>;
//# sourceMappingURL=Button.d.ts.map