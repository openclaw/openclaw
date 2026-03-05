import { describe, expect, it, vi } from "vitest";
import { createOpenClawReadTool } from "./pi-tools.read.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function createMockReadTool(): AnyAgentTool {
  return {
    name: "read",
    description: "Read a file",
    schema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "file contents" }],
    }),
  } as unknown as AnyAgentTool;
}

describe("createOpenClawReadTool: binary document guard (#35406)", () => {
  const binaryExtensions = [
    ".docx",
    ".doc",
    ".xlsx",
    ".xls",
    ".pptx",
    ".ppt",
    ".pdf",
    ".odt",
    ".epub",
  ];

  for (const ext of binaryExtensions) {
    it(`blocks reading of ${ext} files and returns a helpful message`, async () => {
      const base = createMockReadTool();
      const tool = createOpenClawReadTool(base);
      const result = await tool.execute("tc1", { path: `/tmp/report${ext}` }, undefined as never);
      expect(result.content).toHaveLength(1);
      const block = result.content[0] as { type: string; text: string };
      expect(block.type).toBe("text");
      expect(block.text).toContain("binary document");
      expect(block.text).toContain(ext);
      expect((base.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });
  }

  it("allows reading of normal text files", async () => {
    const base = createMockReadTool();
    const tool = createOpenClawReadTool(base);
    const result = await tool.execute("tc1", { path: "/tmp/readme.md" }, undefined as never);
    expect((base.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: string; text: string };
    expect(block.text).toBe("file contents");
  });

  it("allows reading of image files (handled upstream)", async () => {
    const base = createMockReadTool();
    const tool = createOpenClawReadTool(base);
    const result = await tool.execute("tc1", { path: "/tmp/photo.png" }, undefined as never);
    expect((base.execute as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("is case-insensitive for extensions", async () => {
    const base = createMockReadTool();
    const tool = createOpenClawReadTool(base);
    const result = await tool.execute("tc1", { path: "/tmp/report.DOCX" }, undefined as never);
    const block = result.content[0] as { type: string; text: string };
    expect(block.text).toContain("binary document");
    expect((base.execute as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
