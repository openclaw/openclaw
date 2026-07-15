// HTML-island layer for the Telegram rich blocks emitter. Agents author rich
// Telegram content as markdown plus a documented set of HTML islands (see the
// core system prompt's "Telegram rich ON" contract); this module parses those
// islands and maps them to typed Bot API 10.2 blocks / RichText nodes.
import { tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import { decodeTelegramHtmlEntities } from "./format-html.js";
import type {
  InputRichBlock,
  InputRichBlockListItem,
  RichBlockCaption,
  RichBlockTableCell,
  RichText,
} from "./rich-blocks.js";

type HtmlNode =
  | { kind: "text"; text: string }
  | { kind: "element"; name: string; raw: string; children: HtmlNode[]; closed: boolean };

const VOID_TAGS = new Set(["br", "hr", "img", "input", "tg-map"]);

// Block-level islands the agent contract documents. A supported open tag with a
// matching close (or a void tag) becomes a typed block; anything else stays text.
const BLOCK_ISLAND_TAGS = new Set([
  "details",
  "table",
  "ul",
  "ol",
  "figure",
  "img",
  "video",
  "audio",
  "blockquote",
  "aside",
  "footer",
  "hr",
  "tg-math-block",
  "tg-map",
  "tg-collage",
  "tg-slideshow",
  // Only an empty <a name> becomes an anchor block; hrefs fall through to the
  // inline path because elementToBlock returns undefined for them.
  "a",
]);

const INLINE_STYLE_TAGS: Record<
  string,
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "code"
  | "spoiler"
  | "marked"
  | "subscript"
  | "superscript"
> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strikethrough",
  del: "strikethrough",
  strike: "strikethrough",
  code: "code",
  "tg-spoiler": "spoiler",
  mark: "marked",
  sub: "subscript",
  sup: "superscript",
};

const HTML_ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseHtmlAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const inner = raw.replace(/^<\/?[a-zA-Z][a-zA-Z0-9-]*/, "").replace(/\/?>$/, "");
  for (const match of inner.matchAll(HTML_ATTR_RE)) {
    const name = match[1]?.toLowerCase();
    if (name) {
      attrs.set(name, decodeTelegramHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    }
  }
  return attrs;
}

/** Parse an HTML fragment into a light node tree; unmatched tags stay text. */
function parseHtmlFragment(text: string): HtmlNode[] {
  const root: HtmlNode[] = [];
  const stack: Array<{ name: string; node: Extract<HtmlNode, { kind: "element" }> }> = [];
  const childrenOf = () => (stack.length > 0 ? stack[stack.length - 1]!.node.children : root);
  let cursor = 0;
  const pushText = (from: number, to: number) => {
    if (to > from) {
      childrenOf().push({ kind: "text", text: text.slice(from, to) });
    }
  };
  for (const tag of tokenizeHtmlTags(text)) {
    pushText(cursor, tag.start);
    cursor = tag.end;
    if (tag.closing) {
      const openIndex = stack.findLastIndex((entry) => entry.name === tag.name);
      if (openIndex >= 0) {
        for (let depth = openIndex; depth < stack.length; depth += 1) {
          stack[depth]!.node.closed = depth === openIndex;
        }
        stack.length = openIndex;
      } else {
        childrenOf().push({ kind: "text", text: tag.raw });
      }
      continue;
    }
    const selfContained = tag.selfClosing || VOID_TAGS.has(tag.name);
    const element: Extract<HtmlNode, { kind: "element" }> = {
      kind: "element",
      name: tag.name,
      raw: tag.raw,
      children: [],
      closed: selfContained,
    };
    childrenOf().push(element);
    if (!selfContained) {
      stack.push({ name: tag.name, node: element });
    }
  }
  pushText(cursor, text.length);
  return unwrapUnclosed(root);
}

// An open tag with no matching close is not an island: it stays literal text so
// malformed agent output remains visible instead of silently restyling the rest.
function unwrapUnclosed(nodes: HtmlNode[]): HtmlNode[] {
  const result: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      result.push(node);
      continue;
    }
    const children = unwrapUnclosed(node.children);
    if (node.closed) {
      result.push({ ...node, children });
    } else {
      result.push({ kind: "text", text: node.raw }, ...children);
    }
  }
  return result;
}

function nodeText(nodes: readonly HtmlNode[]): string {
  return nodes
    .map((node) =>
      node.kind === "text" ? decodeTelegramHtmlEntities(node.text) : nodeText(node.children),
    )
    .join("");
}

function normalizeIslandText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Raw round-trip of a subtree; keeps unsupported wrappers fully literal.
function serializeHtmlNodes(nodes: readonly HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") {
        return node.text;
      }
      const selfContained = VOID_TAGS.has(node.name) || node.raw.trimEnd().endsWith("/>");
      return selfContained
        ? node.raw
        : `${node.raw}${serializeHtmlNodes(node.children)}</${node.name}>`;
    })
    .join("");
}

/** Convert island children into RichText, honoring documented inline tags. */
export function htmlNodesToRichText(nodes: readonly HtmlNode[]): RichText {
  const parts: RichText[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const value = decodeTelegramHtmlEntities(node.text.replace(/\s+/g, " "));
      if (value) {
        parts.push(value);
      }
      continue;
    }
    const style = INLINE_STYLE_TAGS[node.name];
    if (style) {
      parts.push({ type: style, text: htmlNodesToRichText(node.children) });
      continue;
    }
    if (node.name === "a") {
      const href = parseHtmlAttrs(node.raw).get("href");
      const inner = htmlNodesToRichText(node.children);
      if (href?.startsWith("#")) {
        // In-message fragments are RichTextAnchorLink, not RichTextUrl.
        parts.push({ type: "anchor_link", text: inner, anchor_name: href.slice(1) });
      } else {
        parts.push(href ? { type: "url", text: inner, url: href } : inner);
      }
      continue;
    }
    if (node.name === "tg-math") {
      parts.push({ type: "mathematical_expression", expression: nodeText(node.children) });
      continue;
    }
    if (node.name === "tg-emoji") {
      const emojiId = parseHtmlAttrs(node.raw).get("emoji-id");
      const alternative = normalizeIslandText(nodeText(node.children));
      // Wire contract: custom_emoji_id must be a valid Number (live-verified
      // 400 otherwise); unknown-but-numeric IDs degrade server-side.
      if (emojiId && /^\d+$/.test(emojiId) && alternative) {
        parts.push({
          type: "custom_emoji",
          custom_emoji_id: emojiId,
          alternative_text: alternative,
        });
        continue;
      }
      parts.push(alternative);
      continue;
    }
    if (node.name === "br") {
      parts.push("\n");
      continue;
    }
    if (node.name === "p" || node.name === "span" || node.name === "div") {
      // Transparent containers: content only.
      parts.push(htmlNodesToRichText(node.children));
      continue;
    }
    // Unsupported element: its ENTIRE subtree stays literal so agent mistakes
    // remain visible; converting recognized descendants would mix typed nodes
    // into a literal wrapper and lose their markup from the plain projection.
    const selfContained = VOID_TAGS.has(node.name) || node.raw.trimEnd().endsWith("/>");
    parts.push(node.raw, serializeHtmlNodes(node.children));
    if (!selfContained) {
      parts.push(`</${node.name}>`);
    }
  }
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0] ?? "";
  }
  return parts;
}

/** Parse inline islands (<sup>, <tg-math>, <tg-emoji>, …) out of a text leaf. */
export function parseInlineHtmlIslands(leaf: string): RichText {
  if (!leaf.includes("<")) {
    return leaf;
  }
  const nodes = parseHtmlFragment(leaf);
  const hasElement = nodes.some((node) => node.kind === "element");
  if (!hasElement) {
    return leaf;
  }
  // Preserve raw whitespace when no islands parse; only island-bearing leaves
  // go through the normalizing HTML text model.
  return htmlNodesToRichText(nodes);
}

// Prompt contract: media islands are https-only.
const MEDIA_SRC_RE = /^https:\/\//i;

// True when a container holds meaningful content outside its allowed children;
// such islands stay literal instead of silently dropping the stray content.
function hasStrayContent(nodes: readonly HtmlNode[], allowed: ReadonlySet<string>): boolean {
  return nodes.some((node) =>
    node.kind === "text" ? node.text.trim() !== "" : !allowed.has(node.name),
  );
}

function mediaBlockFromElement(
  node: Extract<HtmlNode, { kind: "element" }>,
  caption?: RichBlockCaption,
): InputRichBlock | undefined {
  const attrs = parseHtmlAttrs(node.raw);
  const src = attrs.get("src") ?? "";
  // Media islands are content-free (src only); any authored body — text or
  // nested elements — would be silently lost from rich output and fallback.
  const hasBody = node.children.some((child) =>
    child.kind === "text" ? child.text.trim() !== "" : true,
  );
  if (!MEDIA_SRC_RE.test(src) || hasBody) {
    return undefined;
  }
  const withCaption = caption ? { caption } : {};
  // GIF sources render as looping animations, matching the old rich HTML
  // pipeline where Telegram inferred the media kind from the URL.
  const isGif = /\.gif(?:[?#]|$)/i.test(src);
  if (node.name === "img" || node.name === "video") {
    if (isGif) {
      return { type: "animation", animation: { type: "animation", media: src }, ...withCaption };
    }
    return node.name === "img"
      ? { type: "photo", photo: { type: "photo", media: src }, ...withCaption }
      : { type: "video", video: { type: "video", media: src }, ...withCaption };
  }
  if (node.name === "audio") {
    // OGG/Opus is Telegram's voice-note family; the music `audio` type rejects
    // it (live-verified RICH_MESSAGE_AUDIO_INVALID), and a Vorbis ogg fails
    // under both types, so voice_note strictly dominates for these extensions.
    if (/\.(?:ogg|opus|oga)(?:[?#]|$)/i.test(src)) {
      return {
        type: "voice_note",
        voice_note: { type: "voice_note", media: src },
        ...withCaption,
      };
    }
    return { type: "audio", audio: { type: "audio", media: src }, ...withCaption };
  }
  return undefined;
}

function countChildren(nodes: readonly HtmlNode[], name: string): number {
  return nodes.filter((node) => node.kind === "element" && node.name === name).length;
}

function captionFromFigcaption(nodes: readonly HtmlNode[]): RichBlockCaption | undefined {
  const figcaption = nodes.find(
    (node): node is Extract<HtmlNode, { kind: "element" }> =>
      node.kind === "element" && node.name === "figcaption",
  );
  if (!figcaption) {
    return undefined;
  }
  const cite = figcaption.children.find(
    (node): node is Extract<HtmlNode, { kind: "element" }> =>
      node.kind === "element" && node.name === "cite",
  );
  const textNodes = figcaption.children.filter((node) => node !== cite);
  const text = htmlNodesToRichText(textNodes);
  if (text === "" && !cite) {
    return undefined;
  }
  return {
    text,
    ...(cite ? { credit: htmlNodesToRichText(cite.children) } : {}),
  };
}

const FIGURE_CHILDREN = new Set(["img", "video", "audio", "tg-map", "figcaption"]);

function figureToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (hasStrayContent(node.children, FIGURE_CHILDREN)) {
    return undefined;
  }
  // A figure carries exactly one media element and at most one caption;
  // multiples would silently drop authored content.
  const mediaChildren = node.children.filter(
    (child) => child.kind === "element" && child.name !== "figcaption",
  );
  if (mediaChildren.length > 1 || countChildren(node.children, "figcaption") > 1) {
    return undefined;
  }
  const media = node.children.find(
    (child): child is Extract<HtmlNode, { kind: "element" }> =>
      child.kind === "element" &&
      (child.name === "img" ||
        child.name === "video" ||
        child.name === "audio" ||
        child.name === "tg-map"),
  );
  if (!media) {
    return undefined;
  }
  const caption = captionFromFigcaption(node.children);
  if (media.name === "tg-map") {
    const map = mapToBlock(media);
    if (map?.type === "map" && caption) {
      return { ...map, caption };
    }
    return map;
  }
  return mediaBlockFromElement(media, caption);
}

const LIST_CHILDREN = new Set(["li"]);

function listToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (hasStrayContent(node.children, LIST_CHILDREN)) {
    return undefined;
  }
  const items: InputRichBlockListItem[] = [];
  for (const child of node.children) {
    if (child.kind !== "element" || child.name !== "li") {
      continue;
    }
    const checkbox = child.children.find(
      (grandchild): grandchild is Extract<HtmlNode, { kind: "element" }> =>
        grandchild.kind === "element" &&
        grandchild.name === "input" &&
        parseHtmlAttrs(grandchild.raw).get("type") === "checkbox",
    );
    const contentNodes = child.children.filter((grandchild) => grandchild !== checkbox);
    const blocks = htmlNodesToBlocks(contentNodes);
    const item: InputRichBlockListItem = {
      blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
    };
    if (checkbox) {
      item.has_checkbox = true;
      if (parseHtmlAttrs(checkbox.raw).has("checked")) {
        item.is_checked = true;
      }
    }
    items.push(item);
  }
  if (items.length === 0) {
    return undefined;
  }
  return {
    type: "list",
    items: node.name === "ol" ? items.map((item, index) => ({ ...item, value: index + 1 })) : items,
  };
}

const CELL_ALIGN_VALUES = new Set(["left", "center", "right"]);

function tableCellFromElement(
  node: Extract<HtmlNode, { kind: "element" }>,
  inHeader: boolean,
): RichBlockTableCell {
  const attrs = parseHtmlAttrs(node.raw);
  const text = htmlNodesToRichText(node.children);
  const colspan = Number.parseInt(attrs.get("colspan") ?? "", 10);
  const rowspan = Number.parseInt(attrs.get("rowspan") ?? "", 10);
  const align = attrs.get("align")?.toLowerCase();
  return {
    ...(text !== "" ? { text } : {}),
    ...(node.name === "th" || inHeader ? { is_header: true as const } : {}),
    ...(Number.isFinite(colspan) && colspan > 1 ? { colspan } : {}),
    ...(Number.isFinite(rowspan) && rowspan > 1 ? { rowspan } : {}),
    ...(align && CELL_ALIGN_VALUES.has(align)
      ? { align: align as RichBlockTableCell["align"] }
      : {}),
  };
}

function richTextPlain(text: RichText): string {
  if (typeof text === "string") {
    return text;
  }
  if (Array.isArray(text)) {
    return text.map(richTextPlain).join("");
  }
  if (text.type === "mathematical_expression") {
    return text.expression;
  }
  if (text.type === "custom_emoji") {
    return text.alternative_text;
  }
  return richTextPlain(text.text);
}

// Live-verified: >20 effective columns → RICH_MESSAGE_TABLE_COLS_TOO_MANY.
const TABLE_COLUMN_LIMIT = 20;

function tableColumnCount(cells: readonly RichBlockTableCell[][]): number {
  // Rowspans occupy width in later rows too; ignoring the carryover would
  // under-count and emit tables Telegram rejects with TABLE_COLS_TOO_MANY.
  let carryover: Array<{ span: number; rows: number }> = [];
  let max = 0;
  for (const row of cells) {
    const carried = carryover.reduce((total, cell) => total + cell.span, 0);
    const own = row.reduce((total, cell) => total + (cell.colspan ?? 1), 0);
    max = Math.max(max, carried + own);
    carryover = [
      ...carryover
        .map((cell) => ({ span: cell.span, rows: cell.rows - 1 }))
        .filter((cell) => cell.rows > 0),
      ...row
        .filter((cell) => (cell.rowspan ?? 1) > 1)
        .map((cell) => ({ span: cell.colspan ?? 1, rows: (cell.rowspan ?? 1) - 1 })),
    ];
  }
  return max;
}

const TABLE_CHILDREN = new Set(["caption", "thead", "tbody", "tfoot", "tr"]);
const TABLE_ROW_CHILDREN = new Set(["td", "th"]);

function tableToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (hasStrayContent(node.children, TABLE_CHILDREN)) {
    return undefined;
  }
  const cells: RichBlockTableCell[][] = [];
  let caption: RichText | undefined;
  // Stray non-whitespace content anywhere in the table structure rejects the
  // island: silently dropping it would lose agent content from the fallback too.
  let stray = false;
  const visitRows = (parent: Extract<HtmlNode, { kind: "element" }>, inHeader: boolean) => {
    for (const child of parent.children) {
      if (child.kind !== "element") {
        stray ||= child.text.trim() !== "";
        continue;
      }
      if (child.name === "caption") {
        const text = htmlNodesToRichText(child.children);
        if (text !== "") {
          // A second caption would overwrite authored content; reject instead.
          stray ||= caption !== undefined;
          caption = text;
        }
        continue;
      }
      if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
        visitRows(child, child.name === "thead");
        continue;
      }
      if (child.name === "tr") {
        if (hasStrayContent(child.children, TABLE_ROW_CHILDREN)) {
          stray = true;
          continue;
        }
        const row = child.children
          .filter(
            (cell): cell is Extract<HtmlNode, { kind: "element" }> =>
              cell.kind === "element" && (cell.name === "td" || cell.name === "th"),
          )
          .map((cell) => tableCellFromElement(cell, inHeader));
        if (row.length > 0) {
          cells.push(row);
        }
        continue;
      }
      stray = true;
    }
  };
  visitRows(node, false);
  if (stray || cells.length === 0) {
    return undefined;
  }
  if (tableColumnCount(cells) > TABLE_COLUMN_LIMIT) {
    // Mirror the markdown table path: over-wide tables degrade to a readable
    // monospace grid instead of an API-rejected table block.
    const grid = cells
      .map((row) => `| ${row.map((cell) => richTextPlain(cell.text ?? "")).join(" | ")} |`)
      .join("\n");
    return {
      type: "pre",
      text: caption !== undefined ? `${richTextPlain(caption)}\n${grid}` : grid,
    };
  }
  return {
    type: "table",
    cells,
    is_bordered: true,
    is_striped: true,
    ...(caption !== undefined ? { caption } : {}),
  };
}

// Full-string numeric parse: prefix-tolerant parseFloat would silently map
// malformed coordinates like "48.8north" to an unintended location.
function strictNumber(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    return undefined;
  }
  return Number.parseFloat(value);
}

function mapToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  const attrs = parseHtmlAttrs(node.raw);
  const latitude = strictNumber(attrs.get("lat"));
  const longitude = strictNumber(attrs.get("long"));
  const inRange =
    latitude !== undefined &&
    longitude !== undefined &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;
  if (!inRange) {
    return undefined;
  }
  const zoom = strictNumber(attrs.get("zoom")) ?? Number.NaN;
  return {
    type: "map",
    location: { latitude, longitude },
    zoom: Number.isFinite(zoom) ? Math.min(24, Math.max(0, Math.round(zoom))) : 14,
    // The documented <tg-map> island carries no size; a 16:9 default satisfies
    // the API's total<=10000 and ratio<=20 constraints.
    width: 800,
    height: 450,
  };
}

const COLLAGE_CHILDREN = new Set(["figure", "img", "video", "audio", "figcaption"]);

function collageToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (
    hasStrayContent(node.children, COLLAGE_CHILDREN) ||
    countChildren(node.children, "figcaption") > 1
  ) {
    return undefined;
  }
  const blocks: InputRichBlock[] = [];
  for (const child of node.children) {
    if (child.kind !== "element" || child.name === "figcaption") {
      continue;
    }
    const media = child.name === "figure" ? figureToBlock(child) : mediaBlockFromElement(child);
    if (!media) {
      // A child that fails conversion (bad scheme, unsupported tag) rejects the
      // whole island: partial collages would silently drop agent content.
      return undefined;
    }
    blocks.push(media);
  }
  if (blocks.length === 0) {
    return undefined;
  }
  const caption = captionFromFigcaption(node.children);
  return {
    type: node.name === "tg-slideshow" ? "slideshow" : "collage",
    blocks,
    ...(caption ? { caption } : {}),
  };
}

function richTextIsBlank(text: RichText): boolean {
  if (typeof text === "string") {
    return text.trim() === "";
  }
  if (Array.isArray(text)) {
    return text.every(richTextIsBlank);
  }
  if (text.type === "mathematical_expression") {
    return text.expression.trim() === "";
  }
  if (text.type === "custom_emoji") {
    return false;
  }
  return richTextIsBlank(text.text);
}

/** Map island element nodes plus loose text into typed blocks. */
export function htmlNodesToBlocks(nodes: readonly HtmlNode[]): InputRichBlock[] {
  const blocks: InputRichBlock[] = [];
  let pendingInline: HtmlNode[] = [];
  const flushInline = () => {
    if (pendingInline.length === 0) {
      return;
    }
    const text = htmlNodesToRichText(pendingInline);
    pendingInline = [];
    // Indentation between child tags collapses to spaces; a whitespace-only
    // run is layout, not content, and must not mint blank paragraphs.
    if (!richTextIsBlank(text)) {
      blocks.push({ type: "paragraph", text });
    }
  };
  for (const node of nodes) {
    const block = node.kind === "element" ? elementToBlock(node) : undefined;
    if (block) {
      flushInline();
      blocks.push(block);
      continue;
    }
    if (node.kind === "element" && node.name === "p") {
      flushInline();
      const text = htmlNodesToRichText(node.children);
      if (text !== "") {
        blocks.push({ type: "paragraph", text });
      }
      continue;
    }
    pendingInline.push(node);
  }
  flushInline();
  return blocks;
}

function elementToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  switch (node.name) {
    case "hr":
      return { type: "divider" };
    case "details": {
      const summary = node.children.find(
        (child): child is Extract<HtmlNode, { kind: "element" }> =>
          child.kind === "element" && child.name === "summary",
      );
      const bodyNodes = node.children.filter((child) => child !== summary);
      const blocks = htmlNodesToBlocks(bodyNodes);
      return {
        type: "details",
        summary: summary ? htmlNodesToRichText(summary.children) : "Details",
        blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
        ...(parseHtmlAttrs(node.raw).has("open") ? { is_open: true } : {}),
      };
    }
    case "ul":
    case "ol":
      return listToBlock(node);
    case "table":
      return tableToBlock(node);
    case "figure":
      return figureToBlock(node);
    case "img":
    case "video":
    case "audio":
      return mediaBlockFromElement(node);
    case "blockquote": {
      const cite = node.children.find(
        (child): child is Extract<HtmlNode, { kind: "element" }> =>
          child.kind === "element" && child.name === "cite",
      );
      const blocks = htmlNodesToBlocks(node.children.filter((child) => child !== cite));
      if (blocks.length === 0) {
        return undefined;
      }
      const credit = cite ? htmlNodesToRichText(cite.children) : "";
      return credit !== ""
        ? { type: "blockquote", blocks, credit }
        : { type: "blockquote", blocks };
    }
    case "aside": {
      const cite = node.children.find(
        (child): child is Extract<HtmlNode, { kind: "element" }> =>
          child.kind === "element" && child.name === "cite",
      );
      const text = htmlNodesToRichText(node.children.filter((child) => child !== cite));
      if (text === "") {
        return undefined;
      }
      return {
        type: "pullquote",
        text,
        ...(cite ? { credit: htmlNodesToRichText(cite.children) } : {}),
      };
    }
    case "footer": {
      const text = htmlNodesToRichText(node.children);
      return text === "" ? undefined : { type: "footer", text };
    }
    case "tg-math-block": {
      const expression = nodeText(node.children).trim();
      return expression ? { type: "mathematical_expression", expression } : undefined;
    }
    case "tg-map":
      return mapToBlock(node);
    case "tg-collage":
    case "tg-slideshow":
      return collageToBlock(node);
    case "a": {
      const attrs = parseHtmlAttrs(node.raw);
      const name = attrs.get("name");
      // Only an empty named <a> is an anchor block; hrefs are inline islands.
      if (name && !attrs.get("href") && nodeText(node.children).trim() === "") {
        return { type: "anchor", name };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

export type TelegramHtmlIsland = {
  start: number;
  end: number;
  blocks: InputRichBlock[];
};

/**
 * Find supported block islands inside a text range. Returns non-overlapping
 * spans in order; text outside spans stays on the markdown paragraph path.
 */
export function findTelegramHtmlIslands(text: string): TelegramHtmlIsland[] {
  if (!text.includes("<")) {
    return [];
  }
  const islands: TelegramHtmlIsland[] = [];
  const tags = [...tokenizeHtmlTags(text)];
  // Open non-island containers seen at scan level; a supported tag nested in an
  // unsupported wrapper (<custom><hr/></custom>) must stay literal with it.
  const openContainers: string[] = [];
  let index = 0;
  while (index < tags.length) {
    const tag = tags[index];
    if (!tag) {
      index += 1;
      continue;
    }
    const startsIsland =
      !tag.closing && BLOCK_ISLAND_TAGS.has(tag.name) && openContainers.length === 0;
    if (!startsIsland) {
      if (tag.closing) {
        const openIndex = openContainers.lastIndexOf(tag.name);
        if (openIndex >= 0) {
          openContainers.length = openIndex;
        }
      } else if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
        openContainers.push(tag.name);
      }
      index += 1;
      continue;
    }
    let end = tag.end;
    const contentStart = tag.end;
    let contentEnd = tag.end;
    let matched = tag.selfClosing || VOID_TAGS.has(tag.name);
    if (!matched) {
      let depth = 1;
      // Tag names quoted in prose (<code><details></code>) must not count
      // toward matching; models routinely mention tags inside code spans.
      let codeDepth = 0;
      let scan = index + 1;
      while (scan < tags.length) {
        const candidate = tags[scan];
        if (candidate && (candidate.name === "code" || candidate.name === "pre")) {
          if (candidate.closing) {
            codeDepth = Math.max(0, codeDepth - 1);
          } else if (!candidate.selfClosing) {
            codeDepth += 1;
          }
          scan += 1;
          continue;
        }
        if (candidate && candidate.name === tag.name && codeDepth === 0) {
          depth += candidate.closing ? -1 : candidate.selfClosing ? 0 : 1;
          if (depth === 0) {
            end = candidate.end;
            contentEnd = candidate.start;
            matched = true;
            index = scan;
            break;
          }
        }
        scan += 1;
      }
    }
    if (!matched) {
      // An unclosed supported opener wraps everything after it; treating later
      // tags as islands would extract blocks out of a malformed fragment.
      openContainers.push(tag.name);
      index += 1;
      continue;
    }
    if (tag.name === "a") {
      // Only an empty named anchor is a block; href/labelled links stay inline
      // so a mid-sentence link never breaks its paragraph apart.
      const attrs = parseHtmlAttrs(tag.raw);
      const isEmptyNamedAnchor =
        attrs.get("name") !== undefined &&
        attrs.get("href") === undefined &&
        text.slice(contentStart, contentEnd).trim() === "";
      if (!isEmptyNamedAnchor) {
        index += 1;
        continue;
      }
    }
    const blocks = htmlNodesToBlocks(parseHtmlFragment(text.slice(tag.start, end)));
    if (blocks.length > 0) {
      islands.push({ start: tag.start, end, blocks });
    }
    index += 1;
  }
  return islands;
}
