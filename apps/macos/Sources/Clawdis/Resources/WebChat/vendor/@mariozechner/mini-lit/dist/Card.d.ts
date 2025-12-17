import { type BaseComponentProps, type TemplateResult } from "./mini.js";
export interface CardProps extends BaseComponentProps {
    hoverable?: boolean;
}
export declare function Card(props: CardProps): TemplateResult;
export declare function Card(children: TemplateResult | string, hoverable?: boolean, className?: string): TemplateResult;
export declare function CardHeader(props: BaseComponentProps): TemplateResult;
export declare function CardHeader(children: TemplateResult | string, className?: string): TemplateResult;
export declare function CardAction(props: BaseComponentProps): TemplateResult;
export declare function CardAction(children: TemplateResult | string, className?: string): TemplateResult;
export declare function CardTitle(props: BaseComponentProps): TemplateResult;
export declare function CardTitle(children: TemplateResult | string, className?: string): TemplateResult;
export declare function CardDescription(props: BaseComponentProps): TemplateResult;
export declare function CardDescription(children: TemplateResult | string, className?: string): TemplateResult;
export declare function CardContent(props: BaseComponentProps): TemplateResult;
export declare function CardContent(children: TemplateResult | string, className?: string): TemplateResult;
export declare function CardFooter(props: BaseComponentProps): TemplateResult;
export declare function CardFooter(children: TemplateResult | string, className?: string): TemplateResult;
//# sourceMappingURL=Card.d.ts.map