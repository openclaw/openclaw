import { LitElement } from "lit";
export declare class MarkdownBlock extends LitElement {
    content: string;
    isThinking: boolean;
    escapeHtml: boolean;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    connectedCallback(): void;
    render(): import("lit-html").TemplateResult<1>;
}
//# sourceMappingURL=MarkdownBlock.d.ts.map