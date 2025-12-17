import { type BaseComponentProps, type TemplateResult } from "./mini.js";
export type AlertVariant = "default" | "destructive";
export interface AlertProps extends BaseComponentProps {
    variant?: AlertVariant;
}
export declare function Alert(props: AlertProps): TemplateResult;
export declare function Alert(children: TemplateResult | string, variant?: AlertVariant, className?: string): TemplateResult;
export declare function AlertTitle(props: BaseComponentProps): TemplateResult;
export declare function AlertTitle(children: TemplateResult | string, className?: string): TemplateResult;
export declare function AlertDescription(props: BaseComponentProps): TemplateResult;
export declare function AlertDescription(children: TemplateResult | string, className?: string): TemplateResult;
//# sourceMappingURL=Alert.d.ts.map