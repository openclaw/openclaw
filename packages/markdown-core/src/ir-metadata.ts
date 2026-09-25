import type { HtmlTagToken } from "./html-tags.js";
import type { MarkdownIR } from "./ir.js";

export const RAW_HTML_TOKEN_TYPE = "markdown_core_html";

export type MarkdownHtmlMetadata = {
  /** Complete authored HTML tags in UTF-16 offsets; omitted from serialized IR. */
  htmlTags?: HtmlTagToken[];
};

export function defineMetadata<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): void;
export function defineMetadata(
  target: object,
  key: "htmlTags",
  value: HtmlTagToken[] | undefined,
): void;
export function defineMetadata(target: object, key: PropertyKey, value: unknown): void {
  if (value !== undefined) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  }
}

function htmlTags(source: object | undefined): HtmlTagToken[] | undefined {
  // SAFETY: This owner writes the metadata; upstream Token lacks the declared IR field.
  return (source as MarkdownHtmlMetadata | undefined)?.htmlTags;
}

/** A fragment cannot inherit a whole tag's meaning; spreads omit these parser-owned facts. */
export function copyHtmlTags<T extends object>(
  source: object,
  target: T,
  start = 0,
  end = Number.POSITIVE_INFINITY,
): T {
  const tags: HtmlTagToken[] = [];
  for (const tag of htmlTags(source) ?? []) {
    if (tag.start >= start && tag.end <= end) {
      tags.push({ ...tag, start: tag.start - start, end: tag.end - start });
    }
  }
  if (tags.length) {
    defineMetadata(target, "htmlTags", tags);
  }
  return target;
}

/** Keep separate tag facts and fresh offsets so appending cannot mutate the source. */
export function appendHtmlTags(target: object, source: object | undefined, offset: number): void {
  const incoming = htmlTags(source);
  if (!incoming?.length) {
    return;
  }
  const tags = htmlTags(target) ?? [];
  for (const tag of incoming) {
    tags.push({ ...tag, start: offset + tag.start, end: offset + tag.end });
  }
  defineMetadata(target, "htmlTags", tags);
}

export type MarkdownListItemMarker = {
  kind: "bullet" | "ordered";
  listMarker?: { start: number; end: number };
  task?: true;
  taskMarker?: { start: number; end: number };
  /** Parser-owned identity and rendered span for block-native list emitters. */
  listId?: number;
  parentListId?: number;
  depth?: number;
  start?: number;
  end?: number;
};

export type MarkdownListItemMetadata = {
  /** Rendered content owned by this item after its native marker. */
  contentStart?: number;
  contentEnd?: number;
  /** True when the source marker line itself contains no item content. */
  markerOnly?: true;
  /** Original Markdown source ownership, attached without changing legacy serialization. */
  sourceMarker?: { start: number; end: number };
  sourceContent?: { start: number; end: number };
  sourceIndent?: number;
  sourceStartLine?: number;
  sourceEndLine?: number;
};

export type MarkdownListItemWithMetadata = MarkdownListItemMarker & MarkdownListItemMetadata;

export type MarkdownBlockSpan = {
  kind: "blockquote" | "code_block" | "heading" | "thematic_break";
  start: number;
  end: number;
  /** Parser-owned container nesting depth, starting at one. */
  depth: number;
  blockquoteDepth?: number;
  codeOrigin?: "fenced" | "indented";
  codeClosed?: boolean;
  headingLevel?: number;
  headingOrigin?: "atx" | "setext";
  language?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
};

export type MarkdownIRWithMetadata = MarkdownIR & {
  /** Parser-owned block metadata, attached without changing legacy serialization. */
  blocks?: MarkdownBlockSpan[];
};

export function attachListItemMetadata(
  item: MarkdownListItemMarker,
  metadata: MarkdownListItemMetadata,
): MarkdownListItemWithMetadata {
  const itemWithMetadata: MarkdownListItemWithMetadata = item;
  for (const key of [
    "contentStart",
    "contentEnd",
    "markerOnly",
    "sourceMarker",
    "sourceContent",
    "sourceIndent",
    "sourceStartLine",
    "sourceEndLine",
  ] as const) {
    defineMetadata(itemWithMetadata, key, metadata[key]);
  }
  return itemWithMetadata;
}

export function attachBlockMetadata(ir: MarkdownIR, blocks: MarkdownBlockSpan[]): MarkdownIR {
  if (blocks.length > 0) {
    const metadataIR: MarkdownIRWithMetadata = ir;
    defineMetadata(metadataIR, "blocks", blocks);
  }
  return ir;
}

export function sliceListMarker(
  marker: { start: number; end: number },
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  const sliceStart = Math.max(marker.start, start);
  const sliceEnd = Math.min(marker.end, end);
  return sliceEnd > sliceStart ? { start: sliceStart - start, end: sliceEnd - start } : undefined;
}
