import { LitElement, type TemplateResult } from 'lit';
import { type VariantProps } from 'tailwind-variants';
export declare const checkboxStyles: import("tailwind-variants").TVReturnType<{
    size: {
        sm: string;
        md: string;
        lg: string;
    };
    variant: {
        default: string;
        primary: string;
        destructive: string;
    };
}, undefined, "peer shrink-0 appearance-none rounded border border-input bg-background shadow-xs ring-offset-background transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground hover:border-muted-foreground/50", {
    size: {
        sm: string;
        md: string;
        lg: string;
    };
    variant: {
        default: string;
        primary: string;
        destructive: string;
    };
}, undefined, import("tailwind-variants").TVReturnType<{
    size: {
        sm: string;
        md: string;
        lg: string;
    };
    variant: {
        default: string;
        primary: string;
        destructive: string;
    };
}, undefined, "peer shrink-0 appearance-none rounded border border-input bg-background shadow-xs ring-offset-background transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground hover:border-muted-foreground/50", unknown, unknown, undefined>>;
export type CheckboxStyles = typeof checkboxStyles;
export type CheckboxVariants = VariantProps<CheckboxStyles>;
export declare class MiniCheckbox extends LitElement {
    static defaultStyles: import("tailwind-variants").TVReturnType<{
        size: {
            sm: string;
            md: string;
            lg: string;
        };
        variant: {
            default: string;
            primary: string;
            destructive: string;
        };
    }, undefined, "peer shrink-0 appearance-none rounded border border-input bg-background shadow-xs ring-offset-background transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground hover:border-muted-foreground/50", {
        size: {
            sm: string;
            md: string;
            lg: string;
        };
        variant: {
            default: string;
            primary: string;
            destructive: string;
        };
    }, undefined, import("tailwind-variants").TVReturnType<{
        size: {
            sm: string;
            md: string;
            lg: string;
        };
        variant: {
            default: string;
            primary: string;
            destructive: string;
        };
    }, undefined, "peer shrink-0 appearance-none rounded border border-input bg-background shadow-xs ring-offset-background transition-all outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-primary-foreground hover:border-muted-foreground/50", unknown, unknown, undefined>>;
    size: CheckboxVariants['size'];
    variant: CheckboxVariants['variant'];
    checked: boolean;
    indeterminate: boolean;
    disabled: boolean;
    name?: string;
    value?: string;
    id?: string;
    onChange?: (checked: boolean) => void;
    styles: typeof checkboxStyles;
    className?: string;
    static template(props: Partial<MiniCheckbox>, styles?: typeof checkboxStyles): TemplateResult;
    createRenderRoot(): this;
    connectedCallback(): void;
    private handleChange;
    render(): TemplateResult;
}
export declare const labelStyles: import("tailwind-variants").TVReturnType<{} | {} | {}, undefined, "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer", {} | {}, undefined, import("tailwind-variants").TVReturnType<unknown, undefined, "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer", unknown, unknown, undefined>>;
export declare class MiniLabel extends LitElement {
    static defaultStyles: import("tailwind-variants").TVReturnType<{} | {} | {}, undefined, "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer", {} | {}, undefined, import("tailwind-variants").TVReturnType<unknown, undefined, "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer", unknown, unknown, undefined>>;
    for?: string;
    required: boolean;
    styles: typeof labelStyles;
    className?: string;
    static template(props: Partial<MiniLabel>, styles?: typeof labelStyles): TemplateResult;
    createRenderRoot(): this;
    render(): TemplateResult;
}
export type CheckboxProps = Partial<Omit<MiniCheckbox, keyof LitElement | 'styles'>>;
export type LabelProps = Partial<Omit<MiniLabel, keyof LitElement | 'styles'>>;
declare global {
    interface HTMLElementTagNameMap {
        'mini-checkbox': MiniCheckbox;
        'mini-label': MiniLabel;
    }
}
//# sourceMappingURL=Checkbox.next.d.ts.map