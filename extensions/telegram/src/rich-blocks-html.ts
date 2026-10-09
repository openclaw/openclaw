// HTML-fragment parsing and inline-island conversion for the Telegram rich
// blocks emitter. Agents author rich content as markdown plus a documented set
// of HTML islands (see agentPrompt.inboundFormattingHints "markdown_telegram_rich");
// this module owns the tolerant parser and inline (RichText-level) mapping,
// while rich-blocks-html-map.ts owns block-level island mapping.
import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import { decodeTelegramHtmlEntities } from "./format-html.js";
import { MAX_RICH_BLOCK_NESTING, richTextLink, type RichText } from "./rich-block-model.js";

export type HtmlNode = { start: number; end: number } & (
  | { kind: "text"; text: string }
  | { kind: "element"; name: string; raw: string; children: HtmlNode[]; closed: boolean }
);

const VOID_TAGS = new Set(["br", "hr", "img", "input", "tg-map"]);

const INLINE_STYLE_TAGS: Record<
  string,
  Exclude<Extract<RichText, { text: RichText }>["type"], "url" | "text_mention" | "anchor_link">
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

export function parseHtmlAttrs(raw: string): Map<string, string> {
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
export function parseHtmlFragment(ir: MarkdownIR): HtmlNode[] {
  const text = ir.text;
  const literalRanges = [
    ...ir.styles.filter((span) => span.style === "code" || span.style === "code_block"),
    ...(ir.annotations ?? []),
  ];
  const root: HtmlNode[] = [];
  const stack: Array<Extract<HtmlNode, { kind: "element" }>> = [];
  const childrenOf = () => stack.at(-1)?.children ?? root;
  let cursor = 0;
  const pushText = (from: number, to: number) => {
    if (to > from) {
      childrenOf().push({ kind: "text", text: text.slice(from, to), start: from, end: to });
    }
  };
  for (const tag of ir.htmlTags ?? []) {
    const parent = stack.at(-1);
    // Code examples are text, including tag-shaped examples inside a disclosure.
    // Keep them out of matching so they cannot close or create an authored container.
    // Telegram's `<pre><code class="language-x">` wrapper is the one tag a <pre> opens.
    if (
      literalRanges.some((range) => tag.start >= range.start && tag.start < range.end) ||
      ((parent?.name === "code" || parent?.name === "pre") &&
        !(tag.closing && tag.name === parent.name) &&
        !(parent.name === "pre" && !tag.closing && tag.name === "code"))
    ) {
      continue;
    }
    pushText(cursor, tag.start);
    cursor = tag.end;
    if (tag.closing) {
      const openIndex = stack.findLastIndex((entry) => entry.name === tag.name);
      if (openIndex >= 0) {
        for (let depth = openIndex; depth < stack.length; depth += 1) {
          stack[depth]!.closed = depth === openIndex;
          stack[depth]!.end = depth === openIndex ? tag.end : tag.start;
        }
        stack.length = openIndex;
      } else {
        childrenOf().push({ kind: "text", text: tag.raw, start: tag.start, end: tag.end });
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
      start: tag.start,
      end: selfContained ? tag.end : text.length,
    };
    childrenOf().push(element);
    if (!selfContained) {
      stack.push(element);
    }
  }
  pushText(cursor, text.length);
  // Retain unmatched parents: extracting their children as islands would hide
  // malformed authored markup. Both inline and block rendering keep them literal.
  // Bound the tree before inline, island, and literal-subtree walkers see it.
  // The parser itself uses an explicit stack, so even the fallback can retain
  // all descendant text without first recursing through the hostile input.
  const pending = [{ nodes: root, depth: 0 }];
  while (pending.length > 0) {
    const frame = pending.pop()!;
    for (let index = 0; index < frame.nodes.length; index += 1) {
      const node = frame.nodes[index]!;
      if (node.kind !== "element") {
        continue;
      }
      if (frame.depth >= MAX_RICH_BLOCK_NESTING * 4) {
        frame.nodes[index] = {
          kind: "text",
          start: node.start,
          end: node.end,
          text: nodeText([node], true),
        };
      } else {
        pending.push({ nodes: node.children, depth: frame.depth + 1 });
      }
    }
  }
  return root;
}

export function nodeText(nodes: readonly HtmlNode[], preserveMediaSources = false): string {
  const parts: string[] = [];
  const pending = nodes.toReversed();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind === "text") {
      parts.push(decodeTelegramHtmlEntities(node.text));
    } else {
      if (!node.closed) {
        parts.push(decodeTelegramHtmlEntities(node.raw));
      }
      if (
        preserveMediaSources &&
        node.closed &&
        (node.name === "img" || node.name === "video" || node.name === "audio")
      ) {
        const source = parseHtmlAttrs(node.raw).get("src");
        if (source) {
          parts.push(`\n${source}\n`);
        }
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]!);
      }
    }
  }
  return parts.join("");
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
        : `${node.raw}${serializeHtmlNodes(node.children)}${node.closed ? `</${node.name}>` : ""}`;
    })
    .join("");
}

type HtmlRichTextRenderer = {
  text: (node: Extract<HtmlNode, { kind: "text" }>) => RichText;
  literal: (range: { start: number; end: number }, serialize: () => string) => RichText;
  wrap: (
    range: { start: number; end: number },
    wrap: (text: RichText) => RichText,
    children: () => RichText,
  ) => RichText;
  atom: (range: { start: number; end: number }, value: RichText) => RichText;
};

const defaultHtmlRenderer: HtmlRichTextRenderer = {
  text: (node) => decodeTelegramHtmlEntities(node.text.replace(/\s+/g, " ")),
  literal: (_range, serialize) => serialize(),
  wrap: (_range, wrap, children) => wrap(children()),
  atom: (_range, value) => value,
};

/** The same tag mapping serves standalone HTML and Markdown source-range composition. */
export function htmlNodesToRichText(
  nodes: readonly HtmlNode[],
  renderer: HtmlRichTextRenderer = defaultHtmlRenderer,
): RichText {
  const parts: RichText[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const value = renderer.text(node);
      if (value) {
        parts.push(value);
      }
      continue;
    }
    const children = () => htmlNodesToRichText(node.children, renderer);
    const emit = (build: () => RichText): RichText =>
      node.closed
        ? build()
        : [
            renderer.atom({ start: node.start, end: node.start + node.raw.length }, node.raw),
            children(),
          ];
    const wrap = (build: (text: RichText) => RichText) =>
      emit(() => renderer.wrap(node, build, children));
    const atom = (value: RichText) => emit(() => renderer.atom(node, value));
    const style = Object.hasOwn(INLINE_STYLE_TAGS, node.name) && INLINE_STYLE_TAGS[node.name];
    if (style) {
      parts.push(wrap((text) => ({ type: style, text })));
      continue;
    }
    if (node.name === "a") {
      const href = parseHtmlAttrs(node.raw).get("href");
      if (href?.startsWith("#")) {
        // In-message fragments are RichTextAnchorLink, not RichTextUrl.
        parts.push(wrap((text) => ({ type: "anchor_link", text, anchor_name: href.slice(1) })));
      } else {
        parts.push(href ? wrap((text) => richTextLink(text, href)) : emit(children));
      }
      continue;
    }
    if (node.name === "tg-math") {
      parts.push(atom({ type: "mathematical_expression", expression: nodeText(node.children) }));
      continue;
    }
    if (node.name === "tg-emoji") {
      const emojiId = parseHtmlAttrs(node.raw).get("emoji-id");
      const alternative = nodeText(node.children).replace(/\s+/g, " ").trim();
      // Wire contract: custom_emoji_id must be a valid Number (live-verified
      // 400 otherwise); unknown-but-numeric IDs degrade server-side.
      if (emojiId && /^\d+$/.test(emojiId) && alternative) {
        parts.push(
          atom({
            type: "custom_emoji",
            custom_emoji_id: emojiId,
            alternative_text: alternative,
          }),
        );
        continue;
      }
      parts.push(atom(alternative));
      continue;
    }
    if (node.name === "br") {
      parts.push(atom("\n"));
      continue;
    }
    if (node.name === "p" || node.name === "span" || node.name === "div") {
      parts.push(emit(children));
      continue;
    }
    // Unsupported HTML and its HTML descendants stay literal, but independently
    // authored Markdown spans must still apply inside that text range.
    parts.push(renderer.literal(node, () => serializeHtmlNodes([node])));
  }
  return parts.length > 1 ? parts : (parts[0] ?? "");
}
