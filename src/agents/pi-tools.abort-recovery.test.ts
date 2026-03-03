import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  writeMode: "commitThenAbort" as "commitThenAbort" | "abortOnly",
  editMode: "commitThenAbort" as "commitThenAbort" | "abortOnly",
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createWriteTool: (_cwd: string) => ({
      name: "write",
      description: "test write tool",
      parameters: { type: "object", properties: {} },
      execute: async (_toolCallId: string, args: { path: string; content: string }) => {
        if (mockState.writeMode === "commitThenAbort") {
          await fs.mkdir(path.dirname(args.path), { recursive: true });
          await fs.writeFile(args.path, args.content, "utf8");
        }
        throw new Error("Operation aborted");
      },
    }),
    createEditTool: (_cwd: string) => ({
      name: "edit",
      description: "test edit tool",
      parameters: { type: "object", properties: {} },
      execute: async (
        _toolCallId: string,
        args: { path: string; oldText: string; newText: string },
      ) => {
        if (mockState.editMode === "commitThenAbort") {
          const current = await fs.readFile(args.path, "utf8");
          await fs.writeFile(args.path, current.replace(args.oldText, args.newText), "utf8");
        }
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
    mockState.writeMode = "commitThenAbort";
    mockState.editMode = "commitThenAbort";
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("treats write as success when write committed before abort", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-abort-"));
    const file = path.join(tmpDir, "note.txt");
    const content = "hello world";

    const tool = createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    const result = await tool.execute("tc-1", { path: file, content }, undefined, undefined);
    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("Successfully wrote");
  });

  it("treats edit as success when replacement committed before abort", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-abort-"));
    const file = path.join(tmpDir, "note.txt");
    await fs.writeFile(file, "before\n", "utf8");

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
    await fs.writeFile(file, "foo\n", "utf8");

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

  it("keeps edit aborted error when no commit happened", async () => {
    mockState.editMode = "abortOnly";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-abort-fail-"));
    const file = path.join(tmpDir, "note.txt");
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
    mockState.editMode = "abortOnly";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-abort-empty-new-"));
    const file = path.join(tmpDir, "note.txt");
    await fs.writeFile(file, "something else\n", "utf8");

    const tool = createHostWorkspaceEditTool(tmpDir, { workspaceOnly: false });
    await expect(
      tool.execute("tc-5", { path: file, oldText: "before", newText: "" }, undefined, undefined),
    ).rejects.toThrow("Operation aborted");
  });

  it("keeps write aborted error when no write happened", async () => {
    mockState.writeMode = "abortOnly";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-abort-fail-"));
    const file = path.join(tmpDir, "note.txt");

    const tool = createHostWorkspaceWriteTool(tmpDir, { workspaceOnly: false });
    await expect(
      tool.execute("tc-6", { path: file, content: "hello" }, undefined, undefined),
    ).rejects.toThrow("Operation aborted");
  });
});
