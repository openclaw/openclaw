import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";

type StoryInline =
  | string
  | { imageBlock: { src: string; alt: string } }
  | { bold: StoryInline[] }
  | { italics: StoryInline[] }
  | { strike: StoryInline[] }
  | { blockquote: StoryInline[] }
  | { "inline-code": string }
  | { code: string }
  | { ship: string }
  | { link: { href: string; content: string } }
  | { task: { checked: boolean; content: StoryInline[] } }
  | { break: null }
  | { tag: string };

type StoryListType = "ordered" | "unordered" | "tasklist";

type StoryBlock =
  | { header: { tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"; content: StoryInline[] } }
  | { code: { code: string; lang: string } }
  | { image: { src: string; height: number; width: number; alt: string } }
  | { rule: null }
  | { listing: StoryListing };

type StoryListing =
  | {
      list: {
        type: StoryListType;
        items: StoryListing[];
        contents: StoryInline[];
      };
    }
  | { item: StoryInline[] };

type StoryVerse = { block: StoryBlock } | { inline: StoryInline[] };

export type Story = StoryVerse[];

type InlineMatch = { readonly 0: string; readonly [index: number]: string | undefined };

// In running prose a bare URL never ends in sentence punctuation or a stray paren. A closing
// paren ends the URL only when it balances one inside it, as in .../wiki/Function_(mathematics).
function matchBareUrl(text: string): InlineMatch | null {
  let url = /^https?:\/\/[^\s<>"\]]+/.exec(text)?.[0];
  if (!url) {
    return null;
  }
  let unbalanced = url.split(")").length - url.split("(").length;
  while (/[.,;:!?(]$/.test(url) || (url.endsWith(")") && unbalanced > 0)) {
    unbalanced += url.endsWith(")") ? -1 : url.endsWith("(") ? 1 : 0;
    url = url.slice(0, -1);
  }
  return /^https?:\/\/./.test(url) ? [url, url] : null;
}

const INLINE_MARKDOWN_RULES: ReadonlyArray<{
  pattern: RegExp | ((text: string) => InlineMatch | null);
  render: (match: InlineMatch) => StoryInline;
}> = [
  {
    pattern: /^(~[a-z][-a-z0-9]*)/,
    render: (match) => ({ ship: expectDefined(match[1], "ship mention capture") }),
  },
  {
    pattern: /^\*\*(.+?)\*\*|^__(.+?)__/,
    render: (match) => ({
      bold: parseInlineMarkdown(expectDefined(match[1] ?? match[2], "bold body capture")),
    }),
  },
  {
    pattern: /^\*([^*]+?)\*|^_([^_]+?)_(?![a-zA-Z0-9])/,
    render: (match) => ({
      italics: parseInlineMarkdown(expectDefined(match[1] ?? match[2], "italic body capture")),
    }),
  },
  {
    pattern: /^~~(.+?)~~/,
    render: (match) => ({
      strike: parseInlineMarkdown(expectDefined(match[1], "strikethrough body capture")),
    }),
  },
  {
    pattern: /^`([^`]+)`/,
    render: (match) => ({ "inline-code": expectDefined(match[1], "inline code capture") }),
  },
  {
    pattern: /^\[([^\]]+)\]\(([^)]+)\)/,
    render: (match) => ({
      link: {
        href: expectDefined(match[2], "link URL capture"),
        content: expectDefined(match[1], "link text capture"),
      },
    }),
  },
  {
    pattern: /^!\[([^\]]*)\]\(([^)]+)\)/,
    render: (match) => ({
      imageBlock: {
        src: expectDefined(match[2], "image URL capture"),
        alt: expectDefined(match[1], "image alt capture"),
      },
    }),
  },
  {
    pattern: matchBareUrl,
    render: (match) => {
      const url = expectDefined(match[1], "plain URL capture");
      return { link: { href: url, content: url } };
    },
  },
  {
    // Stop before special characters, image markers, and URL starts so earlier rules get priority.
    pattern: /^(?:(?!https?:\/\/)[^*_`~[#\n!])+/,
    render: (match) => expectDefined(match[0], "plain text match"),
  },
];

function parseInlineMarkdown(text: string): StoryInline[] {
  const result: StoryInline[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let consumed = 1;
    let inline: StoryInline = remaining.charAt(0);
    for (const rule of INLINE_MARKDOWN_RULES) {
      const match =
        typeof rule.pattern === "function"
          ? rule.pattern(remaining)
          : remaining.match(rule.pattern);
      if (match) {
        inline = rule.render(match);
        consumed = match[0].length;
        break;
      }
    }
    result.push(inline);
    remaining = remaining.slice(consumed);
  }
  return mergeAdjacentStrings(result);
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function mergeAdjacentStrings(inlines: StoryInline[]): StoryInline[] {
  const result: StoryInline[] = [];
  for (const item of inlines) {
    const last = result.at(-1);
    if (typeof item === "string" && typeof last === "string") {
      result.splice(-1, 1, last + item);
    } else {
      result.push(item);
    }
  }
  return result;
}

export function createImageBlock(src: string, alt = ""): StoryVerse {
  return {
    block: {
      image: { src, height: 0, width: 0, alt },
    },
  };
}

export function isImageUrl(url: string): boolean {
  const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i;
  let path = url.split(/[?#]/, 1)[0] ?? url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Keep existing non-URL path handling.
  }
  return imageExtensions.test(path);
}

// Stories carry images only as blocks, so move every image marker out of its
// inline context and drop the styles it leaves empty.
function hoistImageBlocks(inlines: StoryInline[], imageBlocks: StoryVerse[]): StoryInline[] {
  const wrap = <T>(content: StoryInline[], make: (content: StoryInline[]) => T): T[] =>
    content.length > 0 ? [make(content)] : [];
  const hoisted = inlines.flatMap((inline): StoryInline[] => {
    if (typeof inline !== "object") {
      return [inline];
    }
    if ("imageBlock" in inline) {
      imageBlocks.push(createImageBlock(inline.imageBlock.src, inline.imageBlock.alt));
      return [];
    }
    if ("bold" in inline) {
      return wrap(hoistImageBlocks(inline.bold, imageBlocks), (bold) => ({ bold }));
    }
    if ("italics" in inline) {
      return wrap(hoistImageBlocks(inline.italics, imageBlocks), (italics) => ({ italics }));
    }
    if ("strike" in inline) {
      return wrap(hoistImageBlocks(inline.strike, imageBlocks), (strike) => ({ strike }));
    }
    if ("blockquote" in inline) {
      return wrap(hoistImageBlocks(inline.blockquote, imageBlocks), (blockquote) => ({
        blockquote,
      }));
    }
    return [inline];
  });
  return mergeAdjacentStrings(hoisted);
}

function parseInlinesWithBreaks(text: string) {
  const withBreaks: StoryInline[] = [];
  const imageBlocks: StoryVerse[] = [];
  for (const inline of hoistImageBlocks(parseInlineMarkdown(text), imageBlocks)) {
    if (typeof inline !== "string" || !inline.includes("\n")) {
      withBreaks.push(inline);
      continue;
    }
    const parts = inline.split("\n");
    for (const [index, part] of parts.entries()) {
      if (part) {
        withBreaks.push(part);
      }
      if (index < parts.length - 1) {
        withBreaks.push({ break: null });
      }
    }
  }
  return { inlines: withBreaks, imageBlocks };
}

type MarkdownListItem = NonNullable<ReturnType<typeof parseMarkdownListItem>>;

const MARKDOWN_LIST_ITEM_PATTERN = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;

function isMarkdownThematicBreak(text: string): boolean {
  return /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(text);
}

function startsListBlockSyntax(text: string): boolean {
  return (
    /^(`{3,}|~{3,})/.test(text) ||
    text.startsWith(">") ||
    /^#{1,6}(?:\s|$)/.test(text) ||
    isMarkdownThematicBreak(text) ||
    /^(?:[-+*]|\d{1,9}[.)])(?:\s|$)/.test(text)
  );
}

function whitespaceColumns(text: string, startColumn = 0): number {
  let column = startColumn;
  for (const char of text) {
    column += char === "\t" ? 4 - (column % 4) : 1;
  }
  return column;
}

function parseMarkdownListItem(line: string) {
  const match = line.match(MARKDOWN_LIST_ITEM_PATTERN);
  if (!match || isMarkdownThematicBreak(line.trim())) {
    return undefined;
  }

  const marker = expectDefined(match[2], "list marker capture");
  const markerType: Exclude<StoryListType, "tasklist"> = /^\d/.test(marker)
    ? "ordered"
    : "unordered";
  const padding = match[3] ?? " ";
  const sourceBody = match[4] ?? "";
  let body = sourceBody;
  const task = body.match(/^\[([\t xX])\](?:\s+(.*))?$/);
  let checked: boolean | undefined;
  if (task) {
    checked = expectDefined(task[1], "task state capture").toLowerCase() === "x";
    body = task[2] ?? "";
  }

  const { inlines, imageBlocks } = parseInlinesWithBreaks(body);
  const indent = whitespaceColumns(expectDefined(match[1], "list indent capture"));
  const markerEnd = indent + marker.length;
  const contentIndent = whitespaceColumns(padding, markerEnd);
  return {
    indent,
    contentIndent,
    markerType,
    markerKey: markerType === "ordered" ? marker.slice(-1) : marker,
    ...(markerType === "ordered" ? { orderedStart: Number.parseInt(marker, 10) } : {}),
    hasSourceBody: sourceBody.length > 0,
    hasBlockBody:
      sourceBody.length > 0 &&
      (contentIndent - markerEnd >= 5 || startsListBlockSyntax(sourceBody)),
    hasImages: imageBlocks.length > 0,
    content: inlines,
    ...(checked === undefined ? {} : { checked }),
  };
}

function lineIndent(line: string): number {
  return whitespaceColumns(line.match(/^[ \t]*/)?.[0] ?? "");
}

function startsTopLevelStoryBlock(line: string): boolean {
  return (
    /^(#{1,6})\s+(.+)$/.test(line) ||
    line.startsWith("```") ||
    line.startsWith("> ") ||
    /^(-{3,}|\*{3,})$/.test(line.trim())
  );
}

function listItemContent(item: MarkdownListItem): StoryInline[] {
  return item.checked === undefined
    ? item.content
    : [{ task: { checked: item.checked, content: item.content } }];
}

function canInterruptWithListItem(item: MarkdownListItem): boolean {
  return item.hasSourceBody && (item.markerType === "unordered" || item.orderedStart === 1);
}

function parseListingBlock(
  lines: string[],
  startIndex: number,
): { verses: StoryVerse[]; nextIndex: number } | undefined {
  const first = parseMarkdownListItem(expectDefined(lines[startIndex], "list start line"));
  if (!first) {
    return undefined;
  }
  if (first.indent >= 4 || (first.markerType === "ordered" && first.orderedStart !== 1)) {
    return undefined;
  }

  function parseLevel(
    index: number,
    minIndent: number,
    markerKey: string,
  ): { type: StoryListType; items: StoryListing[]; nextIndex: number } | undefined {
    const firstItem = parseMarkdownListItem(expectDefined(lines[index], "list level start"));
    if (
      !firstItem ||
      firstItem.indent < minIndent ||
      firstItem.indent > minIndent + 3 ||
      (firstItem.markerType === "ordered" && firstItem.orderedStart !== 1)
    ) {
      return undefined;
    }

    const items: StoryListing[] = [];
    const markerType = firstItem.markerType;
    let allTasks = true;
    let cursor = index;
    while (cursor < lines.length) {
      const item = parseMarkdownListItem(expectDefined(lines[cursor], "list line index"));
      if (
        !item ||
        item.indent < minIndent ||
        item.indent > minIndent + 3 ||
        item.markerKey !== markerKey
      ) {
        break;
      }
      if (item.hasBlockBody || item.hasImages) {
        return undefined;
      }

      allTasks &&= item.checked !== undefined;
      cursor++;

      while (cursor < lines.length) {
        const continuationLine = expectDefined(lines[cursor], "continuation line index");
        if (continuationLine.trim() === "") {
          let nextContentIndex = cursor + 1;
          while (lines[nextContentIndex]?.trim() === "") {
            nextContentIndex++;
          }
          const nextContent = lines.at(nextContentIndex);
          if (nextContent === undefined) {
            break;
          }
          const nextListItem = parseMarkdownListItem(nextContent);
          if (nextListItem) {
            cursor = nextContentIndex;
            continue;
          }
          if (lineIndent(nextContent) > item.indent) {
            return undefined;
          }
          break;
        }

        if (parseMarkdownListItem(continuationLine)) {
          break;
        }
        if (
          lineIndent(continuationLine) <= item.indent &&
          startsTopLevelStoryBlock(continuationLine)
        ) {
          break;
        }
        return undefined;
      }

      const childLine = lines.at(cursor);
      const child = childLine === undefined ? undefined : parseMarkdownListItem(childLine);
      const childIsSibling =
        child !== undefined &&
        child.markerKey === markerKey &&
        child.indent >= minIndent &&
        child.indent <= minIndent + 3 &&
        child.indent < item.contentIndent;
      if (childIsSibling) {
        items.push({ item: listItemContent(item) });
        continue;
      }
      if (child && child.markerKey !== markerKey && !canInterruptWithListItem(child)) {
        return undefined;
      }
      if (child && child.indent >= item.contentIndent && !canInterruptWithListItem(child)) {
        return undefined;
      }
      if (child && child.indent > item.indent) {
        if (child.indent < item.contentIndent || child.indent >= item.contentIndent + 4) {
          return undefined;
        }
        const nested = parseLevel(cursor, item.contentIndent, child.markerKey);
        if (!nested) {
          return undefined;
        }
        // A nested node stores its parent item's contents, while its type controls
        // the child markers. Preserve that type when list styles change by depth.
        items.push({
          list: {
            type: nested.type,
            contents: listItemContent(item),
            items: nested.items,
          },
        });
        cursor = nested.nextIndex;
        const strandedChildLine = lines.at(cursor);
        const strandedChild =
          strandedChildLine === undefined ? undefined : parseMarkdownListItem(strandedChildLine);
        const strandedIsSibling =
          strandedChild !== undefined &&
          strandedChild.markerKey === markerKey &&
          strandedChild.indent >= minIndent &&
          strandedChild.indent <= minIndent + 3 &&
          strandedChild.indent < item.contentIndent;
        if (!strandedIsSibling && strandedChild && strandedChild.indent > item.indent) {
          return undefined;
        }
        let trailingIndex = cursor;
        while (lines[trailingIndex]?.trim() === "") {
          trailingIndex++;
        }
        const trailingLine = lines.at(trailingIndex);
        if (
          trailingLine !== undefined &&
          !parseMarkdownListItem(trailingLine) &&
          lineIndent(trailingLine) > item.indent
        ) {
          return undefined;
        }
      } else {
        items.push({ item: listItemContent(item) });
      }
    }
    return {
      type: markerType === "unordered" && allTasks && items.length > 0 ? "tasklist" : markerType,
      items,
      nextIndex: cursor,
    };
  }

  const parsed = parseLevel(startIndex, 0, first.markerKey);
  if (!parsed) {
    return undefined;
  }
  return {
    verses: [
      {
        block: {
          listing: {
            list: { type: parsed.type, contents: [], items: parsed.items },
          },
        },
      },
    ],
    nextIndex: parsed.nextIndex,
  };
}

export function markdownToStory(markdown: string): Story {
  const story: Story = [];
  const lines = markdown.split("\n");
  let i = 0;
  let preservedListMarkerKey: string | undefined;

  while (i < lines.length) {
    const line = expectDefined(lines[i], "Markdown line index is in bounds");
    const lineListItem = parseMarkdownListItem(line);
    if (
      line.trim() !== "" &&
      preservedListMarkerKey !== undefined &&
      (lineListItem !== undefined
        ? lineListItem.markerKey !== preservedListMarkerKey
        : lineIndent(line) === 0)
    ) {
      preservedListMarkerKey = undefined;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || "plaintext";
      const codeLines: string[] = [];
      i++;
      while (true) {
        const codeLine = lines.at(i);
        if (codeLine === undefined || codeLine.startsWith("```")) {
          break;
        }
        codeLines.push(codeLine);
        i++;
      }
      story.push({
        block: {
          code: {
            code: codeLines.join("\n"),
            lang,
          },
        },
      });
      i++; // skip closing ```
      continue;
    }

    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const tag =
        HEADING_TAGS[expectDefined(headerMatch[1], "header marker capture").length - 1] ?? "h6";
      const imageBlocks: StoryVerse[] = [];
      const content = hoistImageBlocks(
        parseInlineMarkdown(expectDefined(headerMatch[2], "header body capture")),
        imageBlocks,
      );
      if (content.length > 0) {
        story.push({ block: { header: { tag, content } } });
      }
      story.push(...imageBlocks);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      story.push({ block: { rule: null } });
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (true) {
        const quoteLine = lines.at(i);
        if (quoteLine === undefined || !quoteLine.startsWith("> ")) {
          break;
        }
        quoteLines.push(quoteLine.slice(2));
        i++;
      }
      const quoteText = quoteLines.join("\n");
      const imageBlocks: StoryVerse[] = [];
      const inline = hoistImageBlocks(
        [{ blockquote: parseInlineMarkdown(quoteText) }],
        imageBlocks,
      );
      if (inline.length > 0) {
        story.push({ inline });
      }
      story.push(...imageBlocks);
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const preservesLooseList =
      preservedListMarkerKey !== undefined && lineListItem?.markerKey === preservedListMarkerKey;
    const listing = preservesLooseList ? undefined : parseListingBlock(lines, i);
    if (listing) {
      story.push(...listing.verses);
      i = listing.nextIndex;
      preservedListMarkerKey = undefined;
      continue;
    }
    if (lineListItem) {
      preservedListMarkerKey = lineListItem.markerKey;
    }

    // If a list-like block cannot be represented without losing Markdown semantics,
    // preserve the whole block in the existing plain paragraph path.
    let preserveListText = preservesLooseList || MARKDOWN_LIST_ITEM_PATTERN.test(line);

    // Only interrupt for blocks consumed above; plain hashtags must advance the cursor.
    const paragraphLines: string[] = [];
    while (true) {
      const paragraphLine = lines.at(i);
      if (
        paragraphLine === undefined ||
        paragraphLine.trim() === "" ||
        startsTopLevelStoryBlock(paragraphLine)
      ) {
        break;
      }

      if (!preserveListText && MARKDOWN_LIST_ITEM_PATTERN.test(paragraphLine)) {
        const item = parseMarkdownListItem(paragraphLine);
        const candidate = parseListingBlock(lines, i);
        if (item?.hasSourceBody === true && candidate) {
          break;
        }
        // Once one candidate is not safely representable, keep the remaining
        // paragraph byte-compatible instead of repeatedly reparsing its suffixes.
        preserveListText = true;
        if (item) {
          preservedListMarkerKey = item.markerKey;
        }
      }
      paragraphLines.push(paragraphLine);
      i++;
    }

    if (paragraphLines.length > 0) {
      const { inlines, imageBlocks } = parseInlinesWithBreaks(paragraphLines.join("\n"));

      if (inlines.length > 0) {
        story.push({ inline: inlines });
      }
      story.push(...imageBlocks);
    }
  }

  return story;
}
