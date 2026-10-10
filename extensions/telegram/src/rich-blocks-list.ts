import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import type { InputRichBlock, InputRichBlockListItem } from "./rich-block-model.js";

type MarkdownRichListItemSource = {
  start: number;
  end: number;
  contentStart: number;
  task: boolean;
  checked: boolean;
  value?: number;
};

export type MarkdownRichListSource = {
  start: number;
  end: number;
  items: MarkdownRichListItemSource[];
  /** First source Markdown line owning this list, for table-placement ties. */
  sourceStartLine?: number;
};

/** Groups exact parser-owned item spans by list identity without reparsing Markdown. */
export function collectMarkdownRichListSources(ir: MarkdownIR): MarkdownRichListSource[] {
  const byListId = new Map<number, MarkdownRichListItemSource[]>();
  const listLines = new Map<number, number>();
  for (const item of ir.listItems ?? []) {
    if (
      !item.listMarker ||
      item.listId === undefined ||
      item.start === undefined ||
      item.end === undefined
    ) {
      continue;
    }
    const sourceStartLine = (item as { sourceStartLine?: number }).sourceStartLine;
    if (sourceStartLine !== undefined) {
      listLines.set(
        item.listId,
        Math.min(listLines.get(item.listId) ?? sourceStartLine, sourceStartLine),
      );
    }
    const markerText = ir.text.slice(item.listMarker.start, item.listMarker.end);
    const taskText = item.taskMarker
      ? ir.text.slice(item.taskMarker.start, item.taskMarker.end)
      : "";
    const value = item.kind === "ordered" ? Number.parseInt(markerText, 10) : undefined;
    const source = {
      start: item.start,
      end: item.end,
      contentStart: item.taskMarker?.end ?? item.listMarker.end,
      task: item.task === true,
      checked: /^\[[xX]\]/u.test(taskText),
      ...(value !== undefined && Number.isFinite(value) ? { value } : {}),
    } satisfies MarkdownRichListItemSource;
    const list = byListId.get(item.listId) ?? [];
    list.push(source);
    byListId.set(item.listId, list);
  }
  return [...byListId.entries()].map(([listId, items]) => {
    items.sort((left, right) => left.start - right.start);
    const sourceStartLine = listLines.get(listId);
    const source: MarkdownRichListSource = {
      start: Math.min(...items.map((item) => item.start)),
      end: Math.max(...items.map((item) => item.end)),
      items,
    };
    if (sourceStartLine !== undefined) {
      source.sourceStartLine = sourceStartLine;
    }
    return source;
  });
}

type RenderRange = (start: number, end: number) => InputRichBlock[];

/** Renders one parser list; nested containers arrive through renderRange. */
export function renderMarkdownRichListSource(
  source: MarkdownRichListSource,
  renderRange: RenderRange,
): InputRichBlock {
  const items: InputRichBlockListItem[] = source.items.map((item) => {
    const blocks = renderRange(item.contentStart, item.end);
    return {
      blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
      ...(item.task ? { has_checkbox: true as const } : {}),
      ...(item.checked ? { is_checked: true as const } : {}),
      ...(item.value !== undefined ? { value: item.value } : {}),
    };
  });
  return { type: "list", items };
}
