import { LitElement, type TemplateResult } from "lit";
export declare class ModeToggle extends LitElement {
    modes: string[];
    selectedIndex: number;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    private setMode;
    render(): TemplateResult;
}
declare global {
    interface HTMLElementTagNameMap {
        "mode-toggle": ModeToggle;
    }
}
//# sourceMappingURL=ModeToggle.d.ts.map