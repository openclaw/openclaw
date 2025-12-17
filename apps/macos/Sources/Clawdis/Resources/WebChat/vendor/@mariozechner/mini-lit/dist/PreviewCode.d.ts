import { LitElement, type TemplateResult } from "lit";
export declare class PreviewCode extends LitElement {
    preview: TemplateResult | string;
    code: string;
    language: string;
    className: string;
    private showCode;
    protected createRenderRoot(): this;
    toggleView: () => void;
    render(): TemplateResult<1>;
}
//# sourceMappingURL=PreviewCode.d.ts.map