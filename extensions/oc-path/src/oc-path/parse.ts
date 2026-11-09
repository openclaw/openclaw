/**
 * Markdown parser for workspace files: frontmatter + preamble + H2
 * blocks (with bullet items as the only addressable structural child).
 * Tokenization via markdown-it; frontmatter handled here.
 *
 * Grammar opinions (indented `##`, empty `## `, ordered lists, nested
 * sub-bullets) live in lint rules, not the parser.
 *
 * Byte-fidelity: `parseMd(raw).raw === raw`.
 *
 * @module @openclaw/oc-path/parse
 */

import MarkdownIt, { type MarkdownIt as MarkdownItParser } from "markdown-it";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { isMap, isScalar, LineCounter, parseDocument, stringify } from "yaml";
import type { AstBlock, AstItem, FrontmatterEntry, MdAst } from "./ast.js";
import { slugify } from "./slug.js";

type Token = ReturnType<MarkdownItParser["parse"]>[number];

const FENCE = "---";
const BOM = "﻿";

const md = new MarkdownIt({ html: true });

export function parseMdItemKeyValue(text: string): AstItem["kv"] {
  const match = /^([^:\r\n]+?)[ \t]*:\s*(.+)$/s.exec(text);
  const value = match === null ? "" : expectDefined(match[2], "item value capture").trim();
  return match === null || value === ""
    ? undefined
    : {
        key: expectDefined(match[1], "item key capture").trim(),
        value,
      };
}

export function parseMd(raw: string): MdAst {
  const withoutBom = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;
  const lines = withoutBom.split(/\r?\n/);

  const fm = detectFrontmatter(lines);
  const bodyStartIdx = fm === null ? 0 : fm.endLine + 1;
  const bodyLines = lines.slice(bodyStartIdx);
  const bodyFileLine = bodyStartIdx + 1;

  const tokens = md.parse(bodyLines.join("\n"), {});
  const { preamble, blocks } = walkBlocks(tokens, bodyLines, bodyFileLine);

  return {
    kind: "md",
    raw,
    frontmatter: fm?.entries ?? [],
    ...(fm === null ? {} : { frontmatterEndLine: fm.endLine + 1 }),
    preamble,
    blocks,
  };
}

interface FrontmatterRange {
  readonly entries: readonly FrontmatterEntry[];
  /** 0-based line index of the closing `---`. */
  readonly endLine: number;
}

function detectFrontmatter(lines: readonly string[]): FrontmatterRange | null {
  if (lines.length < 2 || lines.at(0) !== FENCE) {
    return null;
  }
  let closeIndex = -1;
  for (const [offset, line] of lines.slice(1).entries()) {
    if (line === FENCE) {
      closeIndex = offset + 1;
      break;
    }
  }
  if (closeIndex === -1) {
    return null;
  }
  const frontmatter = lines.slice(1, closeIndex);
  const lineCounter = new LineCounter();
  // Keep the final newline so YAML owns multiline folding and chomping.
  const doc = parseDocument(frontmatter.join("\n") + "\n", {
    prettyErrors: false,
    lineCounter,
  });
  const entries: FrontmatterEntry[] = [];
  if (doc.errors.length === 0 && isMap(doc.contents)) {
    for (const { key, value } of doc.contents.items) {
      if (!isScalar(key) || !key.range) {
        continue;
      }
      const keyLine = lineCounter.linePos(key.range[0]).line;
      const source = expectDefined(frontmatter.at(keyLine - 1), "frontmatter key source line");
      const match = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(source);
      if (match !== null) {
        const capture = expectDefined(match[2], "frontmatter value capture").trim();
        entries.push({
          key: expectDefined(match[1], "frontmatter key capture"),
          value:
            isScalar(value) && typeof value.value === "string"
              ? value.value
              : // capture is empty (block value starts below); out-of-scope anchors stay alias text
                capture === "" && !isScalar(value)
                ? stringify(value, { verifyAliasOrder: false }).trimEnd()
                : unquote(capture),
          line: keyLine + 1,
        });
      }
    }
    return { entries, endLine: closeIndex };
  }
  // Malformed, hand-authored frontmatter retains the tolerant line reader.
  for (const [offset, line] of frontmatter.entries()) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (m !== null) {
      const key = expectDefined(m[1], "frontmatter key capture");
      const capture = expectDefined(m[2], "frontmatter value capture").trim();
      const value =
        capture === "" || BLOCK_SCALAR_HEADER_RE.test(capture)
          ? (readIndentedValue(frontmatter, offset) ?? unquote(capture))
          : unquote(capture);
      entries.push({ key, value, line: offset + 2 });
    }
  }
  return { entries, endLine: closeIndex };
}

const BLOCK_SCALAR_HEADER_RE = /^[|>](?:[+-]?\d*|\d*[+-]?)\s*(?:#.*)?$/;

// Reparse the key line plus its indented continuation: unquote("|") parses to
// "", dropping block scalars and block collections when the document has errors.
function readIndentedValue(lines: readonly string[], keyIndex: number): string | undefined {
  const rest = lines.slice(keyIndex + 1);
  const stop = rest.findIndex((next) => next !== "" && !/^\s/.test(next));
  const tail = stop === -1 ? rest : rest.slice(0, stop);
  const doc = parseDocument(`${lines[keyIndex]}\n${tail.join("\n")}\n`, { prettyErrors: false });
  const value =
    doc.errors.length === 0 && isMap(doc.contents) ? doc.contents.items[0]?.value : null;
  if (isScalar(value)) {
    return typeof value.value === "string" ? value.value : "";
  }
  // The reparsed slice cannot see anchors on sibling keys; keep alias text.
  return value === null || value === undefined
    ? undefined
    : stringify(value, { verifyAliasOrder: false }).trimEnd();
}

function unquote(value: string): string {
  const doc = parseDocument(value, { prettyErrors: false });
  if (doc.errors.length === 0 && isScalar(doc.contents) && typeof doc.contents.value === "string") {
    return doc.contents.value;
  }
  if (value.length >= 2) {
    const f = value.charCodeAt(0);
    const l = value.charCodeAt(value.length - 1);
    if (f === 34 || f === 39) {
      // Preserve the tolerant handling of malformed, hand-authored quoted values.
      return f === l ? value.slice(1, -1) : value;
    }
  }
  return value;
}

function walkBlocks(
  tokens: readonly Token[],
  bodyLines: readonly string[],
  bodyFileLine: number,
): { preamble: string; blocks: AstBlock[] } {
  // Match atx `##` only; setext h2 has `markup: "-"`.
  const h2: { tokenIdx: number; lineIdx: number; text: string }[] = [];
  for (const [i, t] of tokens.entries()) {
    if (t.type === "heading_open" && t.tag === "h2" && t.markup === "##" && t.map !== null) {
      const inline = tokens[i + 1];
      h2.push({
        tokenIdx: i,
        lineIdx: expectDefined(t.map.at(0), "heading token map start"),
        text: inline?.content ?? "",
      });
    }
  }

  if (h2.length === 0) {
    return { preamble: bodyLines.join("\n"), blocks: [] };
  }

  const firstHeading = expectDefined(h2.at(0), "non-empty heading list");
  const preamble = bodyLines.slice(0, firstHeading.lineIdx).join("\n");
  const blocks: AstBlock[] = [];

  for (const [h, heading] of h2.entries()) {
    const nextHeading = h2.at(h + 1);
    const start = heading.lineIdx;
    const end = nextHeading?.lineIdx ?? bodyLines.length;
    // Slice by INDEX so unmapped descendants (cells, markers, inline)
    // ride along with their parent. h2 = open + inline + close = 3.
    const tokenStart = heading.tokenIdx + 3;
    const tokenEnd = nextHeading?.tokenIdx ?? tokens.length;
    const blockTokens = tokens.slice(tokenStart, tokenEnd);
    // Every list_item_open becomes an item (bullets, numbered, nested
    // sub-bullets); lint rules flag depth / duplicate-slug collisions.
    const items: AstItem[] = [];
    for (const [i, t] of blockTokens.entries()) {
      if (t.type !== "list_item_open" || t.map === null) {
        continue;
      }
      // First inline at the item's own depth is the item text.
      let nestedDepth = 0;
      let text = "";
      let textLine: number | null = null;
      for (let j = i + 1; j < blockTokens.length; j++) {
        const x = expectDefined(blockTokens[j], "item scan index is in bounds");
        if (x.type === "list_item_close" && nestedDepth === 0) {
          break;
        }
        if (x.type === "bullet_list_open" || x.type === "ordered_list_open") {
          nestedDepth++;
        } else if (x.type === "bullet_list_close" || x.type === "ordered_list_close") {
          nestedDepth--;
        } else if (x.type === "inline" && nestedDepth === 0 && text === "") {
          text = x.content;
          textLine =
            x.map === null ? null : bodyFileLine + expectDefined(x.map.at(0), "inline source line");
        }
      }
      const kv = parseMdItemKeyValue(text);
      items.push({
        text,
        slug: slugify(kv?.key ?? text),
        line: bodyFileLine + expectDefined(t.map.at(0), "list item token map start"),
        textLine,
        ...(kv === undefined ? {} : { kv }),
      });
    }
    blocks.push({
      heading: heading.text,
      slug: slugify(heading.text),
      line: bodyFileLine + start,
      bodyText: bodyLines.slice(start + 1, end).join("\n"),
      items,
    });
  }

  return { preamble, blocks };
}
