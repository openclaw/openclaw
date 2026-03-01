import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("FS tools with workspaceOnly=false", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let outsideFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir);
    outsideFile = path.join(tmpDir, "outside.txt");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should allow write outside workspace when workspaceOnly=false", async () => {
    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: {
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      },
    });

    const writeTool = tools.find((t) => t.name === "write");
    expect(writeTool).toBeDefined();

    const result = await writeTool!.execute("test-call-1", {
      path: outsideFile,
      content: "test content",
    });

    // Check if the operation succeeded (no error in content)
    const hasError = result.content.some(
      (c) => c.type === "text" && c.text.toLowerCase().includes("error"),
    );
    expect(hasError).toBe(false);
    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("test content");
  });

  it("should allow write outside workspace via ../ path when workspaceOnly=false", async () => {
    const relativeOutsidePath = path.join("..", "outside-relative-write.txt");
    const outsideRelativeFile = path.join(tmpDir, "outside-relative-write.txt");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: {
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      },
    });

    const writeTool = tools.find((t) => t.name === "write");
    expect(writeTool).toBeDefined();

    const result = await writeTool!.execute("test-call-1b", {
      path: relativeOutsidePath,
      content: "relative test content",
    });

    const hasError = result.content.some(
      (c) => c.type === "text" && c.text.toLowerCase().includes("error"),
    );
    expect(hasError).toBe(false);
    const content = await fs.readFile(outsideRelativeFile, "utf-8");
    expect(content).toBe("relative test content");
  });

  it("should allow edit outside workspace when workspaceOnly=false", async () => {
    await fs.writeFile(outsideFile, "old content");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: {
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      },
    });

    const editTool = tools.find((t) => t.name === "edit");
    expect(editTool).toBeDefined();

    const result = await editTool!.execute("test-call-2", {
      path: outsideFile,
      oldText: "old content",
      newText: "new content",
    });

    // Check if the operation succeeded (no error in content)
    const hasError = result.content.some(
      (c) => c.type === "text" && c.text.toLowerCase().includes("error"),
    );
    expect(hasError).toBe(false);
    const content = await fs.readFile(outsideFile, "utf-8");
    expect(content).toBe("new content");
  });

  it("should allow edit outside workspace via ../ path when workspaceOnly=false", async () => {
    const relativeOutsidePath = path.join("..", "outside-relative-edit.txt");
    const outsideRelativeFile = path.join(tmpDir, "outside-relative-edit.txt");
    await fs.writeFile(outsideRelativeFile, "old relative content");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: {
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      },
    });

    const editTool = tools.find((t) => t.name === "edit");
    expect(editTool).toBeDefined();

    const result = await editTool!.execute("test-call-2b", {
      path: relativeOutsidePath,
      oldText: "old relative content",
      newText: "new relative content",
    });

    const hasError = result.content.some(
      (c) => c.type === "text" && c.text.toLowerCase().includes("error"),
    );
    expect(hasError).toBe(false);
    const content = await fs.readFile(outsideRelativeFile, "utf-8");
    expect(content).toBe("new relative content");
  });

  it("should allow read outside workspace when workspaceOnly=false", async () => {
    await fs.writeFile(outsideFile, "test read content");

    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: {
        tools: {
          fs: {
            workspaceOnly: false,
          },
        },
      },
    });

    const readTool = tools.find((t) => t.name === "read");
    expect(readTool).toBeDefined();

    const result = await readTool!.execute("test-call-3", {
      path: outsideFile,
    });

    // Check if the operation succeeded (no error in content)
    const hasError = result.content.some(
      (c) => c.type === "text" && c.text.toLowerCase().includes("error"),
    );
    expect(hasError).toBe(false);
  });

  it("should block write outside workspace when workspaceOnly=true", async () => {
    const tools = createOpenClawCodingTools({
      workspaceDir,
      config: {
        tools: {
          fs: {
            workspaceOnly: true,
          },
        },
      },
    });

    const writeTool = tools.find((t) => t.name === "write");
    expect(writeTool).toBeDefined();

    // When workspaceOnly=true, the guard throws an error
    await expect(
      writeTool!.execute("test-call-4", {
        path: outsideFile,
        content: "test content",
      }),
    ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
  });
});
