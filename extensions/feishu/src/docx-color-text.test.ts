import { describe, it, expect, vi } from "vitest";
import { parseColorMarkup, updateColorText } from "./docx-color-text.js";

describe("parseColorMarkup", () => {
  it("returns plain text segment when no markup", () => {
    expect(parseColorMarkup("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("parses color tags", () => {
    const result = parseColorMarkup("[red]error[/red]");
    expect(result).toEqual([{ text: "error", textColor: 1 }]);
  });

  it("mixes plain text and colored segments", () => {
    const result = parseColorMarkup("Revenue [green]+15%[/green] YoY");
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ text: "Revenue " });
    expect(result[1]).toEqual({ text: "+15%", textColor: 4 });
    expect(result[2]).toEqual({ text: " YoY" });
  });
});

// 模拟飞书 client
function mockClient(block?: Record<string, unknown>) {
  return {
    docx: {
      documentBlock: {
        get: vi.fn().mockResolvedValue({
          code: 0,
          data: { block },
        }),
        patch: vi.fn().mockResolvedValue({
          code: 0,
          data: { block: {} },
        }),
      },
    },
  } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("updateColorText", () => {
  it("uses provided content with markup", async () => {
    const client = mockClient();
    const result = await updateColorText(client, "doc1", "blk1", "[red]hello[/red]");
    expect(result.success).toBe(true);
    expect(result.segments).toBe(1);
    expect(client.docx.documentBlock.get).not.toHaveBeenCalled();
    expect(client.docx.documentBlock.patch).toHaveBeenCalledWith({
      path: { document_id: "doc1", block_id: "blk1" },
      data: {
        update_text_elements: {
          elements: [
            {
              text_run: {
                content: "hello",
                text_element_style: { text_color: 1 },
              },
            },
          ],
        },
      },
    });
  });

  it("reads existing text block content when content is omitted", async () => {
    const block = {
      block_type: 2,
      text: {
        elements: [{ text_run: { content: "existing text" } }],
      },
    };
    const client = mockClient(block);
    const result = await updateColorText(client, "doc1", "blk1");
    expect(result.success).toBe(true);
    expect(client.docx.documentBlock.get).toHaveBeenCalledWith({
      path: { document_id: "doc1", block_id: "blk1" },
    });
    // 使用现有文本作为纯文本 segment
    expect(result.segments).toBe(1);
  });

  it("reads heading2 block content when content is omitted", async () => {
    const block = {
      block_type: 4,
      heading2: {
        elements: [{ text_run: { content: "Chapter Title" } }],
      },
    };
    const client = mockClient(block);
    const result = await updateColorText(client, "doc1", "blk1", undefined, 5);
    expect(result.success).toBe(true);
    // 使用 uniform color 路径
    expect(client.docx.documentBlock.patch).toHaveBeenCalledWith({
      path: { document_id: "doc1", block_id: "blk1" },
      data: {
        update_text_elements: {
          elements: [
            {
              text_run: {
                content: "Chapter Title",
                text_element_style: { text_color: 5 },
              },
            },
          ],
        },
      },
    });
  });

  it("applies uniform text_color and background_color", async () => {
    const block = {
      block_type: 5,
      heading3: {
        elements: [{ text_run: { content: "Section " } }, { text_run: { content: "Title" } }],
      },
    };
    const client = mockClient(block);
    const result = await updateColorText(client, "doc1", "blk1", undefined, 1, 3);
    expect(result.success).toBe(true);
    expect(result.segments).toBe(1);
    expect(client.docx.documentBlock.patch).toHaveBeenCalledWith({
      path: { document_id: "doc1", block_id: "blk1" },
      data: {
        update_text_elements: {
          elements: [
            {
              text_run: {
                content: "Section Title",
                text_element_style: { text_color: 1, background_color: 3 },
              },
            },
          ],
        },
      },
    });
  });

  it("throws when block has no text and content is omitted", async () => {
    const block = { block_type: 99 }; // 不支持的 block 类型
    const client = mockClient(block);
    await expect(updateColorText(client, "doc1", "blk1")).rejects.toThrow(
      "Block has no text content to color",
    );
  });
});
