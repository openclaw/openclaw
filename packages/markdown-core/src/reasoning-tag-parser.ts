// Markdown Core owns provider-tag scanning and CommonMark/GFM ownership.
import { expectDefined } from "@openclaw/normalization-core";
import { fromMarkdown, type Extension, type Handle } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
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
      scanBracketOwnership(text, blockStart, blockEnd, regions, regionStart).hasImageCode
    ) {
      unresolvedImageCodeStart = blockStart;
      retainStart = Math.min(retainStart, blockStart);
    }
  }
  const { unsettledDefinitionStarts, retainStart: referenceStart } =
    findReferenceDefinitionRetention(text, definitions);
  retainStart = findListItemRetentionStart(text, blocks, Math.min(retainStart, referenceStart));
  regions.sort((left, right) => left.start - right.start);
  const continuation = findContainerContinuation(text, blocks.at(-1), retainStart);
  return {
    regions,
    codeSpans: regions.map(({ start, end }): [number, number] => [start, end]),
    textSpans,
    retainStart,
    ...(continuation ? { continuation } : {}),
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

function scanBracketOwnership(
  text: string,
  start: number,
  end: number,
  regions: readonly { start: number; end: number; block: boolean }[],
  regionStart: number,
) {
  let regionIndex = regionStart;
  const brackets: Array<{ image: boolean; code: boolean }> = [];
  let hasImageCode = false;
  for (let cursor = start; cursor < end; cursor += 1) {
    const region = regions[regionIndex];
    if (region?.start === cursor) {
      if (!region.block) {
        for (const bracket of brackets) {
          bracket.code ||= bracket.image;
        }
      }
      cursor = region.end - 1;
      regionIndex += 1;
    } else if (text[cursor] === "\\") {
      cursor += 1;
    } else if (text[cursor] === "!" && text[cursor + 1] === "[") {
      brackets.push({ image: true, code: false });
      cursor += 1;
    } else if (text[cursor] === "[") {
      brackets.push({ image: false, code: false });
    } else if (text[cursor] === "]" && brackets.pop()?.code) {
      hasImageCode = true;
    }
  }
  return {
    hasImageCode: hasImageCode || brackets.some((bracket) => bracket.image && bracket.code),
    hasOpenLabel: brackets.length > 0,
  };
}

/** Preserve an open container without retaining its already-stable literal lines. */
function findContainerContinuation(
  text: string,
  block: PositionedNode | undefined,
  retainStart: number,
) {
  const start = block?.position?.start?.offset;
  const end = block?.position?.end?.offset;
  if (start === undefined || end === undefined || retainStart < start || /\r(?!\n)/u.test(text)) {
    return undefined;
  }
  // Keep the last content line and trailing blanks: the next line may terminate the container.
  const offset = text.lastIndexOf("\n", end - 1) + 1;
  if (offset <= start) {
    return undefined;
  }
  if (block?.type === "code" && /^(?: {4}| {0,3}\t)/u.test(text.slice(start))) {
    return { offset, context: "    x\n" };
  }
  const paragraph = block?.children?.length === 1 ? block.children[0] : undefined;
  const paragraphStart = paragraph?.position?.start?.offset;
  if (
    block?.type !== "blockquote" ||
    paragraph?.type !== "paragraph" ||
    paragraphStart === undefined
  ) {
    return undefined;
  }
  const prefix = text.slice(paragraphStart, offset);
  // Labels, link or reference titles, and code delimiters can gain ownership after an append.
  if (
    /[`|]|\][(:]/u.test(prefix) ||
    scanBracketOwnership(text, paragraphStart, offset, [], 0).hasOpenLabel
  ) {
    return undefined;
  }
  return { offset, context: text.slice(start, paragraphStart) + "x\n" };
}

/** Retain the current item, including any container framing an earlier reference needs. */
function findListItemRetentionStart(
  text: string,
  blocks: readonly PositionedNode[],
  retainStart?: number,
): number {
  const offset = retainStart ?? blocks.at(-1)?.position?.start?.offset ?? text.length;
  const block = blocks.findLast((entry) => (entry.position?.start?.offset ?? Infinity) <= offset);
  if (block?.type !== "list") {
    return offset;
  }
  // A partial marker can still become continuation text; keep it with its predecessor.
  const completeLineEnd = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return (
    block.children?.findLast((item) => {
      const start = item.position?.start?.offset;
      return (
        start !== undefined && start <= (retainStart ?? text.length) && start < completeLineEnd
      );
    })?.position?.start?.offset ?? offset
  );
}

function findReferenceDefinitionRetention(
  text: string,
  definitions: readonly { identifier: string; start: number; end: number }[],
) {
  const unsettledDefinitionStarts = definitions
    .filter((definition) => canStillHaveReferenceTitle(text, definition.end))
    .map(({ start }) => start);
  // Expanded labels cannot be serialized as carried CommonMark definitions (999 source
  // characters maximum); keep their original source just like unfinished titles.
  const retainStart = definitions.reduce(
    (offset, { identifier, start }) => (identifier.length > 999 ? Math.min(offset, start) : offset),
    Math.min(text.length, ...unsettledDefinitionStarts),
  );
  return { unsettledDefinitionStarts, retainStart };
}

function canStillHaveReferenceTitle(text: string, start: number): boolean {
  let cursor = start;
  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor === text.length) {
    return true;
  }

  const lineEndingWidth = getLineEndingWidth(text, cursor);
  if (lineEndingWidth > 0) {
    cursor += lineEndingWidth;
    if (cursor === text.length) {
      return true;
    }
  }

  const titleStart = findPossibleTitleStart(text, cursor);
  if (titleStart === undefined) {
    return false;
  }
  return hasUnclosedTitle(text, titleStart);
}

function findPossibleTitleStart(text: string, start: number): number | undefined {
  let cursor = skipContainerPrefixes(text, start);

  while (text[cursor] === " " || text[cursor] === "\t") {
    cursor += 1;
  }
  if (cursor === text.length) {
    return cursor;
  }
  const opening = text[cursor];
  return opening === '"' || opening === "'" || opening === "(" ? cursor : undefined;
}

function skipContainerPrefixes(text: string, start: number) {
  let cursor = start;
  while (cursor < text.length) {
    let markerStart = cursor;
    while (text[markerStart] === " " || text[markerStart] === "\t") {
      markerStart += 1;
    }

    if (text[markerStart] === ">") {
      cursor = markerStart + 1;
      if (text[cursor] === " " || text[cursor] === "\t") {
        cursor += 1;
      }
      continue;
    }

    const markerEnd = listMarkerEnd(text, markerStart);
    if (markerEnd > markerStart) {
      cursor = markerEnd;
      while (text[cursor] === " " || text[cursor] === "\t") {
        cursor += 1;
      }
      continue;
    }
    break;
  }
  return cursor;
}

function listMarkerEnd(text: string, start: number) {
  const first = text[start] ?? "";
  let markerEnd = start;
  if (first === "-" || first === "+" || first === "*") {
    markerEnd += 1;
  } else if (first >= "0" && first <= "9") {
    while ((text[markerEnd] ?? "") >= "0" && (text[markerEnd] ?? "") <= "9") {
      markerEnd += 1;
    }
    const delimiter = text[markerEnd] ?? "";
    if (markerEnd - start > 9 || (delimiter !== "." && delimiter !== ")")) {
      return start;
    }
    markerEnd += 1;
  } else {
    return start;
  }
  const trailingSpace = text[markerEnd];
  return trailingSpace === " " || trailingSpace === "\t" ? markerEnd : start;
}

function hasUnclosedTitle(text: string, start: number): boolean {
  if (start === text.length) {
    return true;
  }
  const opening = text[start];
  if (opening !== '"' && opening !== "'" && opening !== "(") {
    return false;
  }
  const closing = opening === "(" ? ")" : opening;
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === closing) {
      return false;
    }

    const lineEndingWidth = getLineEndingWidth(text, cursor);
    if (lineEndingWidth > 0) {
      let nextLine = cursor + lineEndingWidth;
      while (text[nextLine] === " " || text[nextLine] === "\t") {
        nextLine += 1;
      }
      if (getLineEndingWidth(text, nextLine) > 0) {
        return false;
      }
      cursor += lineEndingWidth - 1;
    }
  }
  return true;
}

function getLineEndingWidth(text: string, index: number): number {
  if (text[index] === "\n") {
    return 1;
  }
  if (text[index] !== "\r") {
    return 0;
  }
  return text[index + 1] === "\n" ? 2 : 1;
}

/** An unfinished table delimiter can still rejoin its preceding paragraph. */
function retainTableParagraph(
  retainStart: number,
  textLength: number,
  block: PositionedNode,
  previous: PositionedNode | undefined,
): number {
  const startLine = block.position?.start?.line;
  return block.type === "table" &&
    block.children?.length === 1 &&
    block.position?.end?.offset === textLength &&
    previous?.type === "paragraph" &&
    startLine !== undefined &&
    previous.position?.end?.line === startLine - 1
    ? Math.min(retainStart, previous.position?.start?.offset ?? retainStart)
    : retainStart;
}
