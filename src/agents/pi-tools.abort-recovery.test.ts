import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createWriteTool: (_cwd: string) => ({
      name: "write",
      description: "test write tool",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("Operation aborted");
      },
    }),
    createEditTool: (_cwd: string) => ({
      name: "edit",
      description: "test edit tool",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("Operation aborted");
      },
    }),
  };
});

const { createHostWorkspaceWriteTool, createHostWorkspaceEditTool } =
  await import("./pi-tools.read.js");

describe("host tool abort-after-commit recovery", () => {
  let tmpDir = "";

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("treats write as success when file already has intended content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-abort-"));
    const file = path.join(tmpDir, "note.txt");
    const content = "hello world";
    await fs.writeFile(file, content, "utf8");

    const tool = createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    const result = await tool.execute("tc-1", { path: file, content }, undefined, undefined);
    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("Successfully wrote");
  });

  it("treats edit as success when file already reflects committed replacement", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-abort-"));
    const file = path.join(tmpDir, "note.txt");
    // Simulate post-commit file state after replacing `before` -> `after`
    await fs.writeFile(file, "after\n", "utf8");

    const tool = createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    const result = await tool.execute(
      "tc-2",
      { path: file, oldText: "before", newText: "after" },
      undefined,
      undefined,
    );
    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("Successfully replaced text");
  });

  it("recovers committed edit when newText contains oldText", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-abort-embed-"));
    const file = path.join(tmpDir, "note.txt");
    // Simulate post-commit state for oldText="foo" -> newText="foobar"
    await fs.writeFile(file, "foobar\n", "utf8");

    const tool = createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    const result = await tool.execute(
      "tc-3",
      { path: file, oldText: "foo", newText: "foobar" },
      undefined,
      undefined,
    );
    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("Successfully replaced text");
  });

  it("keeps edit aborted error when oldText still exists (no committed replacement)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-abort-fail-"));
    const file = path.join(tmpDir, "note.txt");
    // Simulate pre-commit state where replacement did not happen
    await fs.writeFile(file, "before\nafter\n", "utf8");

    const tool = createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    await expect(
      tool.execute(
        "tc-4",
        { path: file, oldText: "before", newText: "after" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("Operation aborted");
  });

  it("keeps edit aborted error for empty newText to avoid false positives", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-abort-empty-new-"));
    const file = path.join(tmpDir, "note.txt");
    await fs.writeFile(file, "something else\n", "utf8");

    const tool = createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    await expect(
      tool.execute("tc-5", { path: file, oldText: "before", newText: "" }, undefined, undefined),
    ).rejects.toThrow("Operation aborted");
  });
});
