import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
});

md.enable("strikethrough");

const { escapeHtml } = md.utils;

md.renderer.rules.image = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");

md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");
md.renderer.rules.html_inline = (tokens, idx) => escapeHtml(tokens[idx]?.content ?? "");

/**
 * Extract LaTeX blocks before markdown rendering to preserve them.
 * After rendering, convert to Matrix `data-mx-maths` format.
 *
 * Detects:
 * - Display math: `$$content$$` → `<div data-mx-maths="content"><code>content</code></div>`
 * - Inline math: `$content$` (single `$`) → `<span data-mx-maths="content"><code>content</code></span>`
 * - LaTeX environments: `\[content\]` (display), `\(content\)` (inline)
 */
function extractAndProtectLatex(markdown: string): {
  markdown: string;
  latexBlocks: Map<string, { type: "display" | "inline"; content: string; raw: string }>;
} {
  const latexBlocks = new Map<string, { type: "display" | "inline"; content: string; raw: string }>();
  let latexIndex = 0;

  let result = markdown;

  // First, protect backtick-quoted regions to avoid extracting LaTeX from code.
  // Handle fenced code blocks first, then inline code.
  const codePlaceholders = new Map<string, string>();
  let codeIndex = 0;
  
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    const key = `{CODE-BLOCK-${codeIndex++}}`;
    codePlaceholders.set(key, match);
    return key;
  });
  
  result = result.replace(/`[^`]+`/g, (match) => {
    const key = `{CODE-BLOCK-${codeIndex++}}`;
    codePlaceholders.set(key, match);
    return key;
  });

  // Extract display math: `$$...$$` (greedy, non-nested)
  result = result.replace(/\$\$((?:[^\$]|\$(?!\$))+)\$\$/g, (match, content) => {
    const key = `{MATHS-DISPLAY-${latexIndex++}}`;
    latexBlocks.set(key, { type: "display", content: content.trim(), raw: match });
    return key;
  });

  // Extract LaTeX display environment: `\[...\]`
  result = result.replace(/\\\[([^\[\]]*)\\\]/g, (match, content) => {
    const key = `{MATHS-DISPLAY-${latexIndex++}}`;
    latexBlocks.set(key, { type: "display", content: content.trim(), raw: match });
    return key;
  });

  // Extract inline math: `$...$` (single $, but not part of $$)
  result = result.replace(/(?<!\$)\$(?!\$)([^\$]+)\$(?!\$)/g, (match, content) => {
    const key = `{MATHS-INLINE-${latexIndex++}}`;
    latexBlocks.set(key, { type: "inline", content: content.trim(), raw: match });
    return key;
  });

  // Extract LaTeX inline environment: `\(...\)`
  result = result.replace(/\\\(([^\(\)]*)\\\)/g, (match, content) => {
    const key = `{MATHS-INLINE-${latexIndex++}}`;
    latexBlocks.set(key, { type: "inline", content: content.trim(), raw: match });
    return key;
  });

  // Restore code regions using split/join to avoid '$' special character handling in replace()
  for (const [key, html] of codePlaceholders.entries()) {
    result = result.split(key).join(html);
  }

  return { markdown: result, latexBlocks };
}

/**
 * Restore LaTeX blocks as `data-mx-maths` HTML.
 * Skip restoration inside <code> tags to preserve literal LaTeX in code blocks.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreLatexAsMatrixMaths(
  html: string,
  latexBlocks: Map<string, { type: "display" | "inline"; content: string; raw: string }>,
): string {
  // Temporarily protect code blocks from replacement.
  // Any math placeholders inside code should be restored to their original literal text.
  const codePlaceholders = new Map<string, string>();
  let codeIndex = 0;

  let result = html.replace(/<code[^>]*>[\s\S]*?<\/code>/gs, (match) => {
    const key = `{CODE-PROTECT-${codeIndex++}}`;
    let literalCode = match;
    for (const [mathKey, block] of latexBlocks.entries()) {
      // Use split/join to avoid '$' special character handling in replace()
      literalCode = literalCode.split(mathKey).join(escapeHtml(block.raw));
    }
    codePlaceholders.set(key, literalCode);
    return key;
  });

  // Restore LaTeX blocks.
  // Display math uses block form when it is the entire paragraph; otherwise fall back to inline span.
  for (const [key, block] of latexBlocks.entries()) {
    const escaped = escapeHtml(block.content);
    const inlineMathsHtml = `<span data-mx-maths="${escaped}"><code>${escaped}</code></span>`;

    if (block.type === "display") {
      const displayMathsHtml = `<div data-mx-maths="${escaped}"><code>${escaped}</code></div>`;
      const paragraphOnly = new RegExp(`<p>\\s*${escapeRegex(key)}\\s*<\\/p>`, "g");
      result = result.replace(paragraphOnly, displayMathsHtml);
      // Use split/join for the remaining occurrences
      result = result.split(key).join(inlineMathsHtml);
      continue;
    }

    result = result.split(key).join(inlineMathsHtml);
  }

  // Restore code blocks
  for (const [key, restoredHtml] of codePlaceholders.entries()) {
    result = result.split(key).join(restoredHtml);
  }

  return result;
}

export function markdownToMatrixHtml(markdown: string): string {
  const { markdown: protectedMarkdown, latexBlocks } = extractAndProtectLatex(markdown ?? "");
  const rendered = md.render(protectedMarkdown);
  const withMaths = restoreLatexAsMatrixMaths(rendered, latexBlocks);
  return withMaths.trimEnd();
}
