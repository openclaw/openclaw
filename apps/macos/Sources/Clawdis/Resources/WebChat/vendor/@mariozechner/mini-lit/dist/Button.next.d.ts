import { LitElement, type TemplateResult } from 'lit';
import { type VariantProps } from 'tailwind-variants';
export declare function description(text: string): (target: any, propertyKey: string) => void;
export declare function control(type: 'select' | 'toggle' | 'text', options?: readonly string[]): (target: any, propertyKey: string) => void;
export declare const buttonStyles: import("tailwind-variants").TVReturnType<{
    variant: {
        default: string;
        destructive: string;
        outline: string;
        secondary: string;
        ghost: string;
        link: string;
    };
    size: {
        default: string;
        sm: string;
        lg: string;
        icon: string;
    };
}, undefined, "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50", {
    variant: {
        default: string;
        destructive: string;
        outline: string;
        secondary: string;
        ghost: string;
        link: string;
    };
    size: {
        default: string;
        sm: string;
        lg: string;
        icon: string;
    };
}, undefined, import("tailwind-variants").TVReturnType<{
    variant: {
        default: string;
        destructive: string;
        outline: string;
        secondary: string;
        ghost: string;
        link: string;
    };
    size: {
        default: string;
        sm: string;
        lg: string;
        icon: string;
    };
}, undefined, "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50", unknown, unknown, undefined>>;
export type ButtonStyles = typeof buttonStyles;
export type ButtonVariants = VariantProps<ButtonStyles>;
export declare class MiniButton extends LitElement {
    static defaultStyles: import("tailwind-variants").TVReturnType<{
        variant: {
            default: string;
            destructive: string;
            outline: string;
            secondary: string;
            ghost: string;
            link: string;
        };
        size: {
            default: string;
            sm: string;
            lg: string;
            icon: string;
        };
    }, undefined, "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50", {
        variant: {
            default: string;
            destructive: string;
            outline: string;
            secondary: string;
            ghost: string;
            link: string;
        };
        size: {
            default: string;
            sm: string;
            lg: string;
            icon: string;
        };
    }, undefined, import("tailwind-variants").TVReturnType<{
        variant: {
            default: string;
            destructive: string;
            outline: string;
            secondary: string;
            ghost: string;
            link: string;
        };
        size: {
            default: string;
            sm: string;
            lg: string;
            icon: string;
        };
    }, undefined, "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50", unknown, unknown, undefined>>;
    static getMetadata(): any;
    variant: ButtonVariants['variant'];
    size: ButtonVariants['size'];
    disabled: boolean;
    loading: boolean;
    onClick?: (e: MouseEvent) => void;
    styles: typeof buttonStyles;
    static template(props: Partial<MiniButton>, styles?: typeof buttonStyles): TemplateResult;
    createRenderRoot(): this;
    connectedCallback(): void;
    render(): TemplateResult;
}
export type ButtonProps = Partial<Omit<MiniButton, keyof LitElement | 'styles'>>;
declare global {
    interface HTMLElementTagNameMap {
        'mini-button': MiniButton;
    }
}
//# sourceMappingURL=Button.next.d.ts.map