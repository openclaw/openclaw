// Feishu tests cover docx table ops plugin behavior.
import { describe, expect, it } from "vitest";
import { cleanBlocksForDescendant } from "./docx-table-ops.js";

describe("cleanBlocksForDescendant", () => {
  it("removes parent links and read-only table fields while normalizing table cells", () => {
    const blocks = [
      {
        block_id: "table-1",
        parent_id: "parent-1",
        block_type: 31,
        children: "cell-1",
        table: {
          property: {
            row_size: 1,
            column_size: 1,
            column_width: [240],
          },
          cells: ["cell-1"],
          merge_info: [{ row_span: 1, col_span: 1 }],
        },
      },
      {
        block_id: "cell-1",
        parent_id: "table-1",
        block_type: 32,
        children: "text-1",
      },
      {
        block_id: "text-1",
        parent_id: "cell-1",
        block_type: 2,
        text: {
          elements: [{ text_run: { content: "hello" } }],
        },
      },
      {
        block_id: "table-2",
        block_type: 31,
        children: ["cell-2a", "cell-2b"],
        table: {
          property: { row_size: 1, column_size: 2, column_width: [150, 150] },
        },
      },
      { block_id: "cell-2a", block_type: 32, children: "text-2a" },
      { block_id: "cell-2b", block_type: 32, children: "text-2b" },
      {
        block_id: "text-2a",
        block_type: 2,
        text: {
          elements: [{ text_run: { content: "\ud83d" } }, { text_run: { content: "\ude00" } }],
        },
      },
      {
        block_id: "text-2b",
        block_type: 2,
        text: { elements: [{ text_run: { content: "abcd" } }] },
      },
    ];

    const original = structuredClone(blocks);
    const cleaned = cleanBlocksForDescendant(blocks);

    expect(cleaned[0]).not.toHaveProperty("parent_id");
    expect(cleaned[1]).not.toHaveProperty("parent_id");
    expect(cleaned[2]).not.toHaveProperty("parent_id");

    expect(cleaned[0]?.table).toEqual({
      property: {
        row_size: 1,
        column_size: 1,
        column_width: [240],
      },
    });
    expect(cleaned[1]?.children).toEqual(["text-1"]);
    expect(cleaned[3]?.table?.property?.column_width).toEqual([100, 200]);
    expect(blocks).toEqual(original);

    blocks[6] = {
      block_id: "text-2a",
      block_type: 2,
      text: { elements: [{ text_run: { content: "中文中文" } }] },
    };
    expect(cleanBlocksForDescendant(blocks)[3]?.table?.property?.column_width).toEqual([200, 100]);
  });
});
