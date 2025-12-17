import { LitElement, type TemplateResult } from "lit";
export declare abstract class DialogBase extends LitElement {
    protected modalWidth: string;
    protected modalHeight: string;
    private boundHandleKeyDown?;
    private previousFocus?;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    open(): void;
    close(): void;
    protected abstract renderContent(): TemplateResult;
    render(): TemplateResult;
}
//# sourceMappingURL=DialogBase.d.ts.map