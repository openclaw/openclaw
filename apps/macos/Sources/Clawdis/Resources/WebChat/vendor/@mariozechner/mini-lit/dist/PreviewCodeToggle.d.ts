import { LitElement, type TemplateResult } from "lit";
type Mode = "preview" | "code";
export declare class PreviewCodeToggle extends LitElement {
    mode: Mode;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    private setMode;
    render(): TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "preview-code-toggle": PreviewCodeToggle;
    }
}
export {};
//# sourceMappingURL=PreviewCodeToggle.d.ts.map