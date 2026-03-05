/**
 * Detect if text contains Markdown elements (code blocks, tables, headings, bold, links).
 */
export function containsMarkdown(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text) ||
    /^#{1,6}\s/m.test(text) || /\*\*.+?\*\*/.test(text) || /\[.+?\]\(.+?\)/.test(text);
}
