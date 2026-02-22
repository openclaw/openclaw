import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { expectReadWriteEditTools } from "./test-helpers/pi-tools-fs-helpers.js";

describe("createOpenClawCodingTools", () => {
  it("accepts Claude Code parameter aliases for read/write/edit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-alias-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const { readTool, writeTool, editTool } = expectReadWriteEditTools(tools);

      const filePath = "alias-test.txt";
      await writeTool?.execute("tool-alias-1", {
        file_path: filePath,
        content: "hello world",
      });

      await editTool?.execute("tool-alias-2", {
        file_path: filePath,
        old_string: "world",
        new_string: "universe",
      });

      const result = await readTool?.execute("tool-alias-3", {
        file_path: filePath,
      });

      const textBlocks = result?.content?.filter((block) => block.type === "text") as
        | Array<{ text?: string }>
        | undefined;
      const combinedText = textBlocks?.map((block) => block.text ?? "").join("\n");
      expect(combinedText).toContain("hello universe");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("coerces structured content blocks for write", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-structured-write-"));
    try {
      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const writeTool = tools.find((tool) => tool.name === "write");
      expect(writeTool).toBeDefined();

      await writeTool?.execute("tool-structured-write", {
        path: "structured-write.js",
        content: [
          { type: "text", text: "const path = require('path');\n" },
          { type: "input_text", text: "const root = path.join(process.env.HOME, 'clawd');\n" },
        ],
      });

      const written = await fs.readFile(path.join(tmpDir, "structured-write.js"), "utf8");
      expect(written).toBe(
        "const path = require('path');\nconst root = path.join(process.env.HOME, 'clawd');\n",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("coerces structured old/new text blocks for edit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-structured-edit-"));
    try {
      const filePath = path.join(tmpDir, "structured-edit.js");
      await fs.writeFile(filePath, "const value = 'old';\n", "utf8");

      const tools = createOpenClawCodingTools({ workspaceDir: tmpDir });
      const editTool = tools.find((tool) => tool.name === "edit");
      expect(editTool).toBeDefined();

      await editTool?.execute("tool-structured-edit", {
        file_path: "structured-edit.js",
        old_string: [{ type: "text", text: "old" }],
        new_string: [{ kind: "text", value: "new" }],
      });

      const edited = await fs.readFile(filePath, "utf8");
      expect(edited).toBe("const value = 'new';\n");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
