import type { MarkdownIR } from "./ir.js";
import { renderMarkdownIRChunksWithinLimit } from "./render-aware-chunking.js";

export const href = "https://example.com";
export const identity = (text: string) => text;
export const style = (start: number, end: number, kind: MarkdownIR["styles"][number]["style"]) => ({
  start,
  end,
  style: kind,
});
export const link = (start: number, end: number, url = href) => ({ start, end, href: url });
export const plainIR = (
  text: string,
  styles: MarkdownIR["styles"] = [],
  links: MarkdownIR["links"] = [],
): MarkdownIR => ({ text, styles, links });
export const htmlTag = (
  start: number,
  end: number,
  raw: string,
  name: string,
  closing = false,
) => ({ start, end, raw, name, closing, selfClosing: false });
export const marker = (tag: string) => ({ open: `<${tag}>`, close: `</${tag}>` });
export const htmlLink = ({ start, end, href: url }: MarkdownIR["links"][number]) => ({
  start,
  end,
  open: `<a href="${url}">`,
  close: "</a>",
});
export const attributed = (text: string, ranges: [number, number, string][]) => ({
  text,
  ranges: ranges.map(([start, length, kind]) => ({ start, length, style: kind })),
});

export function renderChunks<T extends string | { text: string }>(
  ir: MarkdownIR,
  limit: number,
  renderChunk: (chunk: MarkdownIR) => T,
  assistantTranscriptRoleMessageBoundaries = false,
) {
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    renderChunk,
    assistantTranscriptRoleMessageBoundaries,
    measureRendered: (rendered) =>
      typeof rendered === "string" ? rendered.length : rendered.text.length,
  });
}
