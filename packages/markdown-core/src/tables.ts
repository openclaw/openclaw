import { expectDefined } from "@openclaw/normalization-core/expect";
import MarkdownIt, { type Env, type MarkdownIt as MarkdownItParser } from "markdown-it";
import { mergeStyleSpans } from "./ir-spans.js";
import { getMarkdownTableSource, markdownToIRWithMeta, type MarkdownStyleSpan } from "./ir.js";
import { renderMarkdownWithMarkers } from "./render.js";
import { renderMarkdownCodeTable, renderMarkdownTableBullets } from "./table-layout.js";
import type { MarkdownTableMode } from "./types.js";

let rowLabelParser: MarkdownItParser | undefined;

function makeRowLabelParser() {
  const parser = new MarkdownIt();
  // Row labels are emitted as CommonMark. Keep the exact spelling of code, links (including references), escapes and
  // entities. Their contents belong to their own inline syntax.
  parser.inline.ruler.before("text", "row_label_source", (state, silent) => {
    const start = state.pos;
    if (silent || !"[!<`\\&".includes(state.src.charAt(start))) {
      return false;
    }
    state.md.inline.skipToken(state);
    if (state.pos === start + 1) {
      state.pos = start;
      return false;
    }
    const token = state.push("row_label_source", "", 0);
    token.content = state.src.slice(start, state.pos);
    return true;
  });
  return parser;
}

function referenceEnvironment(markdown: string, parser: MarkdownItParser): Env {
  const env: Env = {};
  if (markdown.includes("]:")) {
    parser.block.parse(markdown, parser, env, []);
  }
  return env;
}

type LabelRun = { text: string; bold: boolean; italic: boolean; struck: boolean };

function labelRuns(markdown: string, parser: MarkdownItParser, env: Env, addBold: boolean) {
  const runs: LabelRun[] = [];
  const depth = { strong: 0, em: 0, s: 0 };
  for (const token of parser.parseInline(markdown, env)[0]?.children ?? []) {
    if (token.tag === "strong" || token.tag === "em" || token.tag === "s") {
      depth[token.tag] += token.nesting;
    } else if (token.content) {
      const bold = addBold || depth.strong > 0;
      const italic = depth.em > 0;
      const struck = depth.s > 0;
      let run = runs.at(-1);
      if (!run || run.bold !== bold || run.italic !== italic || run.struck !== struck) {
        run = { text: "", bold, italic, struck };
        runs.push(run);
      }
      run.text +=
        token.type === "row_label_source"
          ? token.content
          : token.content.replace(/[\\*_`~![\]<&]/gu, "\\$&");
    }
  }
  return runs;
}

function rowLabelContent(markdown: string, parser: MarkdownItParser, env: Env): string {
  // Prefer the authored spelling whenever the outer strong preserves every run.
  const runs = labelRuns(markdown, parser, env, true);
  const wrapped = labelRuns(`**${markdown}**`, parser, env, false);
  if (
    runs.length === wrapped.length &&
    runs.every((run, i) => {
      const actual = wrapped[i];
      return (
        actual.bold &&
        actual.italic === run.italic &&
        actual.struck === run.struck &&
        actual.text === run.text
      );
    })
  )
    return markdown;

  const italic: MarkdownStyleSpan[] = [];
  const strike: MarkdownStyleSpan[] = [];
  let text = "";
  for (const [i, run] of runs.entries()) {
    const before = runs[i - 1];
    const after = runs[i + 1];
    // Word boundaries outside a style must allow a delimiter to open or close,
    // even when its neighbor is link punctuation or intraword emphasis.
    const afterClose = (before?.italic && !run.italic) || (before?.struck && !run.struck);
    const beforeOpen = (after?.italic && !run.italic) || (after?.struck && !run.struck);
    const start = text.length;
    text +=
      afterClose || beforeOpen
        ? run.text.replace(/[^\s\p{P}\p{S}]+/gu, (word, offset: number) =>
            (afterClose && offset === 0) || (beforeOpen && offset + word.length === run.text.length)
              ? `**${word}**`
              : word,
          )
        : run.text;
    if (run.italic) {
      italic.push({ style: "italic", start, end: text.length });
    }
    if (run.struck) {
      strike.push({ style: "strikethrough", start, end: text.length });
    }
  }
  // A strike spanning several italic or plain runs stays open across all of them.
  return renderMarkdownWithMarkers(
    { text, styles: [...mergeStyleSpans(italic), ...mergeStyleSpans(strike)], links: [] },
    {
      styleMarkers: {
        italic: { open: "_", close: "_" },
        strikethrough: { open: "~~", close: "~~" },
      },
      escapeText: (value) => value,
    },
  );
}

/** Convert only parsed table ranges; unrelated Markdown retains its original source bytes. */
export function convertMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
  if (!markdown || mode === "off" || !markdown.includes("|")) {
    return markdown;
  }
  const { tables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    tableMode: "block",
  });
  let references: Env | undefined;
  let cursor = 0;
  let result = "";
  for (const table of tables) {
    const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
    let rendered = "";
    if (mode !== "bullets") {
      const text = renderMarkdownCodeTable(table.headers, table.rows);
      let fenceLength = 3;
      for (const run of text.matchAll(/`+/g)) {
        fenceLength = Math.max(fenceLength, run[0].length + 1);
      }
      const fence = "`".repeat(fenceLength);
      rendered = `${fence}\n${text}${fence}`;
    } else {
      const headers = table.headers.map((text, column) => ({
        text,
        markdown: source.headers[column],
      }));
      const rows = table.rows.map((row, index) =>
        row.map((text, column) => ({ text, markdown: source.rows[index]?.[column] })),
      );
      renderMarkdownTableBullets(
        headers,
        rows,
        (text) => {
          rendered += text;
        },
        (cell, rowLabel) => {
          let value = cell.markdown ?? cell.text;
          if (rowLabel) {
            // Adding the outer bold markers changes how adjacent star runs parse.
            if (value.includes("**")) {
              const parser = (rowLabelParser ??= makeRowLabelParser());
              const env = value.includes("[")
                ? (references ??= referenceEnvironment(markdown, parser))
                : {};
              value = rowLabelContent(value, parser, env);
            }
            value = `**${value}**`;
          }
          rendered += value;
        },
      );
      rendered = rendered.replace(/\n+$/u, "");
    }
    rendered = rendered.replaceAll("\n", "\n" + source.prefix);
    result += markdown.slice(cursor, source.start) + rendered;
    cursor = source.end;
  }
  return result + markdown.slice(cursor);
}
