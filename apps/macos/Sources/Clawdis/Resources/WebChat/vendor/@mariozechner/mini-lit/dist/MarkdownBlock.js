var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import katex from "katex";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
let MarkdownBlock = class MarkdownBlock extends LitElement {
    constructor() {
        super(...arguments);
        this.content = "";
        this.isThinking = false;
        this.escapeHtml = true;
    }
    createRenderRoot() {
        return this;
    }
    connectedCallback() {
        super.connectedCallback();
        // Add styles for markdown content
        this.classList.add("markdown-content");
        this.style.display = "block";
    }
    render() {
        if (!this.content) {
            return html ``;
        }
        let preservedContent = this.content;
        if (this.escapeHtml) {
            // First, preserve code blocks by replacing them with placeholders
            const codeBlocks = [];
            preservedContent = this.content.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
                const index = codeBlocks.length;
                codeBlocks.push(match);
                return `__CODE_BLOCK_${index}__`;
            });
            // Escape HTML tags but preserve markdown syntax
            // This regex matches HTML tags but not markdown blockquotes (> at line start)
            preservedContent = preservedContent
                // Replace opening tags like <script>, <div>, etc.
                .replace(/<(\w+)([^>]*)>/g, "&lt;$1$2&gt;")
                // Replace closing tags like </script>, </div>, etc.
                .replace(/<\/(\w+)>/g, "&lt;/$1&gt;")
                // Replace self-closing tags like <img />, <br/>
                .replace(/<(\w+)([^>]*)\s*\/>/g, "&lt;$1$2/&gt;")
                // Replace any remaining < that might be part of HTML
                .replace(/<(?![^\s])/g, "&lt;");
            // Restore code blocks
            codeBlocks.forEach((block, index) => {
                preservedContent = preservedContent.replace(`__CODE_BLOCK_${index}__`, block);
            });
        }
        const katexMode = "html"; // Use both HTML and MathML output
        // Configure marked with math extensions
        marked.use({
            extensions: [
                // Inline math with $...$
                {
                    name: "inlineMathDollar",
                    level: "inline",
                    start(src) {
                        return src.indexOf("$");
                    },
                    tokenizer(src) {
                        const match = /^\$([^$\n]+?)\$/s.exec(src);
                        if (match) {
                            return {
                                type: "inlineMathDollar",
                                raw: match[0],
                                text: match[1].trim(),
                            };
                        }
                        return undefined;
                    },
                    renderer(token) {
                        try {
                            return katex.renderToString(token.text, {
                                throwOnError: false,
                                displayMode: false,
                                output: katexMode,
                            });
                        }
                        catch (e) {
                            console.error("KaTeX error:", e);
                            return `<span class="text-red-500 font-mono">$${token.text}$</span>`;
                        }
                    },
                },
                // Block math with $$...$$
                {
                    name: "blockMathDollar",
                    level: "block",
                    start(src) {
                        return src.indexOf("$$");
                    },
                    tokenizer(src) {
                        const match = /^\$\$([^$]+?)\$\$/s.exec(src);
                        if (match) {
                            return {
                                type: "blockMathDollar",
                                raw: match[0],
                                text: match[1].trim(),
                            };
                        }
                        return undefined;
                    },
                    renderer(token) {
                        try {
                            return `<div class="my-4">${katex.renderToString(token.text, {
                                throwOnError: false,
                                displayMode: true,
                                output: katexMode,
                            })}</div>`;
                        }
                        catch (e) {
                            console.error("KaTeX error:", e);
                            return `<div class="my-4 text-red-500 font-mono">$$${token.text}$$</div>`;
                        }
                    },
                },
                // Inline math with \(...\)
                {
                    name: "inlineMathLatex",
                    level: "inline",
                    start(src) {
                        return src.indexOf("\\(");
                    },
                    tokenizer(src) {
                        const match = /^\\\((.+?)\\\)/s.exec(src);
                        if (match) {
                            return {
                                type: "inlineMathLatex",
                                raw: match[0],
                                text: match[1].trim(),
                            };
                        }
                        return undefined;
                    },
                    renderer(token) {
                        try {
                            return katex.renderToString(token.text, {
                                throwOnError: false,
                                displayMode: false,
                                output: katexMode,
                            });
                        }
                        catch (e) {
                            console.error("KaTeX error:", e);
                            return `<span class="text-red-500 font-mono">\\(${token.text}\\)</span>`;
                        }
                    },
                },
                // Block math with \[...\]
                {
                    name: "blockMathLatex",
                    level: "block",
                    start(src) {
                        return src.indexOf("\\[");
                    },
                    tokenizer(src) {
                        const match = /^\\\[(.+?)\\\]/s.exec(src);
                        if (match) {
                            return {
                                type: "blockMathLatex",
                                raw: match[0],
                                text: match[1].trim(),
                            };
                        }
                        return undefined;
                    },
                    renderer(token) {
                        try {
                            return `<div class="my-4">${katex.renderToString(token.text, {
                                throwOnError: false,
                                displayMode: true,
                                output: katexMode,
                            })}</div>`;
                        }
                        catch (e) {
                            console.error("KaTeX error:", e);
                            return `<div class="my-4 text-red-500 font-mono">\\[${token.text}\\]</div>`;
                        }
                    },
                },
            ],
        });
        // Configure renderer to open links in new tabs and wrap tables
        const renderer = new marked.Renderer();
        const originalLink = renderer.link;
        renderer.link = function (token) {
            const link = originalLink.call(this, token);
            return link.replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
        };
        // Wrap tables in a container to handle overflow
        const originalTable = renderer.table;
        renderer.table = function (token) {
            const table = originalTable.call(this, token);
            // Wrap in a div with overflow handling
            return `<div class="overflow-x-auto my-2 border border-border rounded">${table}</div>`;
        };
        // Parse the markdown content with our configured marked
        const parsedContent = marked.parse(preservedContent, {
            async: false,
            renderer: renderer,
        });
        // Replace code blocks with our custom code-block component
        let highlightedContent = parsedContent.replace(/<pre><code class="language-(\w+)">([\s\S]+?)<\/code><\/pre>/g, (_match, lang, code) => {
            // Unescape all HTML entities
            const unescaped = code
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&#x27;/g, "'")
                .replace(/&amp;/g, "&"); // Must be last to avoid double-unescaping
            // Pass the raw unescaped code to CodeBlock - it will handle highlighting
            const base64Code = btoa(unescape(encodeURIComponent(unescaped)));
            return `<div class="mt-2"><code-block language="${lang}" code="${base64Code}"></code-block></div>`;
        });
        // Also handle code blocks without language specification
        highlightedContent = highlightedContent.replace(/<pre><code>([\s\S]+?)<\/code><\/pre>/g, (_match, code) => {
            // Unescape all HTML entities
            const unescaped = code
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&#x27;/g, "'")
                .replace(/&amp;/g, "&"); // Must be last to avoid double-unescaping
            // Use "text" as default language for proper styling
            const base64Code = btoa(unescape(encodeURIComponent(unescaped)));
            return `<div class="mt-2"><code-block language="text" code="${base64Code}"></code-block></div>`;
        });
        const containerClasses = this.isThinking
            ? "text-muted-foreground italic max-w-none break-words overflow-wrap-anywhere text-sm [&>*:last-child]:!mb-0"
            : "text-foreground max-w-none break-words overflow-wrap-anywhere [&>*:last-child]:!mb-0";
        return html ` <div class="${containerClasses}">${unsafeHTML(highlightedContent)}</div> `;
    }
};
__decorate([
    property()
], MarkdownBlock.prototype, "content", void 0);
__decorate([
    property()
], MarkdownBlock.prototype, "isThinking", void 0);
__decorate([
    property()
], MarkdownBlock.prototype, "escapeHtml", void 0);
MarkdownBlock = __decorate([
    customElement("markdown-block")
], MarkdownBlock);
export { MarkdownBlock };
//# sourceMappingURL=MarkdownBlock.js.map