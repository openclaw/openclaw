import { LitElement } from "lit";
import "./CopyButton.js";
export declare class CodeBlock extends LitElement {
    code: string;
    language: string;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    connectedCallback(): void;
    private getDecodedCode;
    render(): import("lit-html").TemplateResult<1>;
}
//# sourceMappingURL=CodeBlock.d.ts.map