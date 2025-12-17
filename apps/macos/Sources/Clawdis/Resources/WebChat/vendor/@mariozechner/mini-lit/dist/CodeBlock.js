var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import html from "highlight.js/lib/languages/xml"; // HTML uses xml
import { LitElement, html as litHtml } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { i18n } from "./i18n.js";
import "./CopyButton.js";
// Register only the languages we need
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("html", html);
hljs.registerLanguage("xml", html); // Also register as xml
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sql", sql);
let CodeBlock = class CodeBlock extends LitElement {
    constructor() {
        super(...arguments);
        this.code = "";
        this.language = "";
    }
    createRenderRoot() {
        return this;
    }
    connectedCallback() {
        super.connectedCallback();
        // Make sure the custom element displays as a block element
        this.style.display = "block";
    }
    getDecodedCode() {
        try {
            // Decode from base64
            return decodeURIComponent(escape(atob(this.code)));
        }
        catch {
            // Fallback if not encoded
            return this.code;
        }
    }
    render() {
        const decodedCode = this.getDecodedCode();
        // Highlight the code
        const highlighted = this.language && hljs.getLanguage(this.language)
            ? hljs.highlight(decodedCode, { language: this.language }).value
            : hljs.highlightAuto(decodedCode).value;
        // Format language name for display
        const displayLanguage = this.language || "plaintext";
        return litHtml `
			<div class="border border-border rounded-lg overflow-hidden">
				<!-- Title bar -->
				<div class="flex items-center justify-between px-3 py-1">
					<span class="text-xs text-muted-foreground font-mono">${displayLanguage}</span>
					<copy-button class="[&>button]:!bg-transparent [&>button]:hover:!bg-accent" .text=${decodedCode} title="${i18n("Copy code")}" .showText=${true}></copy-button>
				</div>
				<!-- Code content -->
				<div class="overflow-auto max-h-96">
					<pre
						class="!bg-transparent !border-0 !rounded-none m-0 px-4 pb-4 text-xs text-foreground font-mono"
					><code class="hljs language-${this.language || "plaintext"}">${unsafeHTML(highlighted)}</code></pre>
				</div>
			</div>
		`;
    }
};
__decorate([
    property()
], CodeBlock.prototype, "code", void 0);
__decorate([
    property()
], CodeBlock.prototype, "language", void 0);
CodeBlock = __decorate([
    customElement("code-block")
], CodeBlock);
export { CodeBlock };
//# sourceMappingURL=CodeBlock.js.map