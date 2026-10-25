// Markdown Core owns provider-tag scanning and CommonMark/GFM ownership.
import { expectDefined } from "@openclaw/normalization-core";
import { fromMarkdown, type Extension, type Handle } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { hasUnresolvedImageCode } from "./image-code-retention.js";
import { findListItemRetentionStart } from "./list-code-retention.js";
import { findReferenceDefinitionRetention } from "./reference-definition-retention.js";
import { retainTableParagraph } from "./table-code-retention.js";
export {
  parseReasoningTagAt,
  parseReasoningTagName,
  reduceReasoningText,
  scanReasoningTags,
  findNextLineEnding,
  isInsideCode,
} from "./reasoning-tag-syntax.js";
export type { ReasoningTagTextDelta, ReductionState } from "./reasoning-tag-syntax.js";

const DISABLE_HTML_MARKDOWN = {
  disable: { null: ["htmlFlow", "htmlText"] },
};

export type PositionedNode = {
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

type MarkdownCompletedParagraph = {
  start: number;
  end: number;
  hasReferenceCandidate: boolean;
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

export function parseMarkdownOwnership(text: string, options?: MarkdownOwnershipOptions) {
  const paragraphs: Array<{ start: number; end: number }> | undefined =
    options?.includeIndentedSource ? [] : undefined;
  if (!text) {
    return {
      regions: [],
      codeSpans: [],
      textSpans: [],
      retainStart: 0,
      completedParagraphs: [],
      definitions: [],
      unsettledDefinitionStarts: [],
      ...(paragraphs ? { paragraphs } : {}),
    };
  }
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
  const completedParagraphs: MarkdownCompletedParagraph[] = [];
  const regions: MarkdownCodeRegion[] = [];
  const textSpans: Array<[number, number]> = [];
  const definitions: Array<{ identifier: string; start: number; end: number }> = [];
  let unresolvedImageCodeStart: number | undefined;
  const blocks = tree.children ?? [];
  let retainStart = findListItemRetentionStart(text, blocks);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = expectDefined(blocks[index], "Markdown block");
    const next = blocks[index + 1]?.position?.start;
    const blockStart = block.position?.start?.offset;
    const endLine = block.position?.end?.line;
    const blockEnd = block.position?.end?.offset;
    retainStart = retainTableParagraph(retainStart, text.length, block, blocks[index - 1]);
    if (
      paragraphs &&
      block.type === "paragraph" &&
      blockStart !== undefined &&
      blockEnd !== undefined
    ) {
      paragraphs.push({ start: blockStart, end: blockEnd });
    }
    let paragraph: MarkdownCompletedParagraph | undefined;
    if (
      block.type === "paragraph" &&
      blockStart !== undefined &&
      endLine !== undefined &&
      next?.offset !== undefined &&
      next.line !== undefined &&
      next.line > endLine + 1
    ) {
      // Include the blank separator so projections can retain the completed block boundary.
      // Unresolved reference labels can still become image alt text after a later definition.
      paragraph = {
        start: blockStart,
        end: next.offset,
        hasReferenceCandidate: false,
      };
      completedParagraphs.push(paragraph);
    }
    const pending: PositionedNode[] = [block];
    const regionStart = regions.length;
    let hasReferenceCandidate = false;
    let hasInlineCode = false;
    while (pending.length > 0) {
      const node = expectDefined(pending.pop(), "Markdown ownership node");
      if (node.type === "text" && node.value?.includes("[")) {
        hasReferenceCandidate = true;
        if (paragraph) {
          paragraph.hasReferenceCandidate = true;
        }
      }
      hasInlineCode ||= node.type === "inlineCode";
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (
        node.type === "definition" &&
        node.identifier !== undefined &&
        start !== undefined &&
        end !== undefined
      ) {
        definitions.push({ identifier: node.identifier, start, end });
      }
      if (
        options?.includeText &&
        node.type === "text" &&
        start !== undefined &&
        end !== undefined
      ) {
        textSpans.push([start, end]);
      }
      if (
        (node.type === "code" || node.type === "inlineCode") &&
        start !== undefined &&
        end !== undefined
      ) {
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
      for (const child of node.children?.toReversed() ?? []) {
        pending.push(child);
      }
    }
    // A later image reference definition can turn inline code into unprotected alt text.
    if (
      hasReferenceCandidate &&
      hasInlineCode &&
      blockStart !== undefined &&
      blockEnd !== undefined &&
      hasUnresolvedImageCode(text, blockStart, blockEnd, regions, regionStart)
    ) {
      unresolvedImageCodeStart = blockStart;
      retainStart = Math.min(retainStart, blockStart);
    }
  }
  const { unsettledDefinitionStarts, retainStart: referenceStart } =
    findReferenceDefinitionRetention(text, definitions);
  retainStart = findListItemRetentionStart(text, blocks, Math.min(retainStart, referenceStart));
  regions.sort((left, right) => left.start - right.start);
  return {
    regions,
    codeSpans: regions.map(({ start, end }): [number, number] => [start, end]),
    textSpans,
    retainStart,
    ...(unresolvedImageCodeStart === undefined ? {} : { unresolvedImageCodeStart }),
    completedParagraphs,
    definitions,
    unsettledDefinitionStarts,
    ...(paragraphs ? { paragraphs } : {}),
  };
}

/** Returns parser-owned CommonMark/GFM code ranges with block ownership. */
export function findMarkdownCodeRegions(
  text: string,
  options?: MarkdownOwnershipOptions,
): MarkdownCodeRegion[] {
  return /[`~\t]| {4}/u.test(text) ? parseMarkdownOwnership(text, options).regions : [];
}
