// Semantic Markdown source maps for rich rendering and chunking.
import { expectDefined } from "@openclaw/normalization-core";
import { fromMarkdown, type Extension, type Handle } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
const DISABLE_HTML_MARKDOWN = {
  disable: { null: ["htmlFlow", "htmlText"] },
};

type PositionedNode = {
  type?: string;
  value?: string;
  identifier?: string;
  position?: {
    start?: { offset?: number; line?: number };
    end?: { offset?: number; line?: number };
  };
  children?: PositionedNode[];
};

type MarkdownCodeRegion = {
  start: number;
  end: number;
  block: boolean;
  source?: MarkdownInlineSource;
  indentedSource?: MarkdownIndentedSource;
};

type MarkdownInlineSource = {
  prefix: { start: number; end: number; text: string; ownerStart: number };
  value: string;
  offsets: number[];
};

export type MarkdownIndentedSource = {
  value: string;
  offsets: number[];
  /** Source framing before the first content token, including its owning containers. */
  context: string;
  ownerStart: number;
  nested: boolean;
};

type MarkdownOwnershipOptions = {
  includeSource?: boolean;
  includeIndentedSource?: boolean;
  includeText?: boolean;
  syntax?: "commonmark" | "gfm";
};

function appendMarkdownSource(
  source: Pick<MarkdownInlineSource, "value" | "offsets">,
  start: number,
  token: Parameters<Handle>[0],
  value: string,
): void {
  // A tab partly consumed by a container contributes virtual spaces to its first source unit.
  const extra = value.length - (token.end.offset - token.start.offset);
  for (let cursor = start + source.offsets.length; cursor < token.end.offset; cursor += 1) {
    const consumed = cursor - token.start.offset;
    source.offsets.push(source.value.length + (consumed > 0 ? consumed + extra : 0));
  }
  source.value += value;
}

function captureInlineSources(text: string, sources: Map<number, MarkdownInlineSource>): Extension {
  const observe: Handle = function (token) {
    const start = this.stack.findLast((entry) => entry.type === "inlineCode")?.position?.start
      .offset;
    if (start === undefined) {
      return;
    }
    let source = sources.get(start);
    if (!source) {
      const inlineBlock = this.stack.findLast(
        (entry) => entry.type === "paragraph" || entry.type === "heading",
      );
      const begin = inlineBlock?.children[0]?.position?.start.offset;
      const containers = this.stack.filter(
        (entry) => entry.type === "listItem" || entry.type === "blockquote",
      );
      const prefixEnd = begin !== undefined && containers.length ? begin : start;
      const prefixStart = containers.length
        ? Math.max(text.lastIndexOf("\n", prefixEnd - 1), text.lastIndexOf("\r", prefixEnd - 1)) + 1
        : start;
      const prefix = containers
        .map((entry) =>
          text.slice(entry.position?.start.offset, entry.children[0]?.position?.start.offset),
        )
        .join("");
      source = {
        prefix: {
          start: prefixStart,
          end: prefixEnd,
          ownerStart: containers[0]?.position?.start.offset ?? start,
          text:
            prefix +
            (containers.length && inlineBlock?.type === "heading"
              ? text.slice(inlineBlock.position?.start.offset, begin)
              : ""),
        },
        value: "",
        offsets: [],
      };
      sources.set(start, source);
    }
    appendMarkdownSource(source, start, token, this.sliceSerialize(token));
  };
  return {
    enter: {
      codeTextData(token) {
        observe.call(this, token);
        // Preserve normal data compilation; the observation only records source/content ownership.
        expectDefined(this.config.enter.data, "Markdown data handler").call(this, token);
      },
      lineEnding: observe,
    },
  };
}

function captureIndentedSources(
  text: string,
  sources: Map<number, MarkdownIndentedSource>,
  observeInlineLineEnding?: Handle,
): Extension {
  const observe: Handle = function (token) {
    if (!this.tokenStack.some(([parent]) => parent.type === "codeIndented")) {
      return;
    }
    const node = this.stack.findLast((entry) => entry.type === "code");
    const start = node?.position?.start.offset;
    if (start === undefined) {
      return;
    }
    let source = sources.get(start);
    if (!source) {
      const owner = this.stack.find(
        (entry) => entry.type === "listItem" || entry.type === "blockquote",
      );
      source = {
        value: "",
        offsets: [],
        context: text.slice(owner?.position?.start.offset ?? start, token.start.offset),
        ownerStart: owner?.position?.start.offset ?? start,
        nested: owner !== undefined,
      };
      sources.set(start, source);
    }
    appendMarkdownSource(source, start, token, this.sliceSerialize(token));
  };
  return {
    enter: {
      codeFlowValue(token) {
        observe.call(this, token);
        expectDefined(this.config.enter.data, "Markdown data handler").call(this, token);
      },
      lineEnding(token) {
        observeInlineLineEnding?.call(this, token);
        observe.call(this, token);
      },
    },
  };
}

/** Parse semantic source maps and text nodes for renderers that need a Markdown tree. */
export function parseMarkdownOwnership(text: string, options?: MarkdownOwnershipOptions) {
  const paragraphs: Array<{ start: number; end: number }> | undefined =
    options?.includeIndentedSource ? [] : undefined;
  const regions: MarkdownCodeRegion[] = [];
  const textSpans: Array<[number, number]> = [];
  const sources = new Map<number, MarkdownInlineSource>();
  const indentedSources = options?.includeIndentedSource
    ? new Map<number, MarkdownIndentedSource>()
    : undefined;
  const inlineSourceExtension = options?.includeSource
    ? captureInlineSources(text, sources)
    : undefined;
  const tables = options?.syntax !== "commonmark";
  const tree = fromMarkdown(text, {
    extensions: [DISABLE_HTML_MARKDOWN, ...(tables ? [gfmTable()] : [])],
    mdastExtensions: [
      ...(tables ? [gfmTableFromMarkdown()] : []),
      ...(inlineSourceExtension ? [inlineSourceExtension] : []),
      ...(indentedSources
        ? [captureIndentedSources(text, indentedSources, inlineSourceExtension?.enter?.lineEnding)]
        : []),
    ],
  }) as PositionedNode;
  for (const block of tree.children ?? []) {
    const blockStart = block.position?.start?.offset;
    const blockEnd = block.position?.end?.offset;
    if (block.type === "paragraph" && blockStart !== undefined && blockEnd !== undefined) {
      paragraphs?.push({ start: blockStart, end: blockEnd });
    }
    const pending = [block];
    while (pending.length) {
      const node = expectDefined(pending.pop(), "Markdown source node");
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        if (options?.includeText && node.type === "text") {
          textSpans.push([start, end]);
        }
        if (node.type === "code" || node.type === "inlineCode") {
          const source = sources.get(start);
          if (source) {
            while (source.offsets.length <= end - start) {
              source.offsets.push(source.value.length);
            }
          }
          const indentedSource = indentedSources?.get(start);
          if (indentedSource) {
            indentedSource.value = node.value ?? "";
            while (indentedSource.offsets.length <= end - start) {
              indentedSource.offsets.push(indentedSource.value.length);
            }
            indentedSource.offsets.forEach((offset, sourceIndex) => {
              indentedSource.offsets[sourceIndex] = Math.min(offset, indentedSource.value.length);
            });
          }
          regions.push({
            start,
            end,
            block: node.type === "code",
            ...(source ? { source } : {}),
            ...(indentedSource ? { indentedSource } : {}),
          });
        }
      }
      for (const child of node.children?.toReversed() ?? []) {
        pending.push(child);
      }
    }
  }
  return { regions, textSpans, ...(paragraphs ? { paragraphs } : {}) };
}

/** Decoded source maps for the public chunking contract and the independent scanner oracle. */
export function findMarkdownCodeRegions(
  text: string,
  options?: MarkdownOwnershipOptions,
): MarkdownCodeRegion[] {
  return /[`~\t]| {4}/u.test(text) ? parseMarkdownOwnership(text, options).regions : [];
}
