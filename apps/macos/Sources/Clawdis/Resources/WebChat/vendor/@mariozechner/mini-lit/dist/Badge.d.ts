import { type BaseComponentProps, type TemplateResult } from "./mini.js";
export type BadgeVariant = "default" | "secondary" | "destructive" | "outline";
export interface BadgeProps extends BaseComponentProps {
    variant?: BadgeVariant;
}
export declare function Badge(props: BadgeProps): TemplateResult;
export declare function Badge(children: TemplateResult | string, variant?: BadgeVariant, className?: string): TemplateResult;
//# sourceMappingURL=Badge.d.ts.map