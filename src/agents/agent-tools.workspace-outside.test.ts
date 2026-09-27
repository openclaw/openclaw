/** Host filesystem opt-out and memory-write behavior. */
import fs from "node:fs/promises";
import path from "node:path";
import { createReadTool } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import {
  createHostWorkspaceEditTool,
  createHostWorkspaceWriteTool,
  createOpenClawReadTool,
  wrapToolMemoryFlushAppendOnlyWrite,
  wrapToolWorkspaceRootGuardWithOptions,
} from "./agent-tools.read.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return { ...mod, getShellPathFromLoginShell: () => null };
});

describe("FS tools with workspaceOnly=false", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let outsideFile: string;

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const hasToolError = (result: { content: Array<{ type: string; text?: string }> }) =>
    result.content.some(
      (content) => content.type === "text" && content.text?.toLowerCase().includes("error"),
    );
  const readTool = () =>
    createOpenClawReadTool(createReadTool(workspaceDir) as unknown as AnyAgentTool);
  const memoryWriteTool = (relativePath: string) =>
    wrapToolMemoryFlushAppendOnlyWrite(createHostWorkspaceWriteTool(workspaceDir), {
      root: workspaceDir,
      relativePath,
    });

  beforeEach(async () => {
    tmpDir = tempDirs.make("openclaw-workspace-outside-");
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir);
    outsideFile = path.join(tmpDir, "outside.txt");
  });

  it("should allow edit outside workspace via ../ path when workspaceOnly=false", async () => {
    const relativeOutsidePath = path.join("..", "outside-relative-edit.txt");
    const outsideRelativeFile = path.join(tmpDir, "outside-relative-edit.txt");
    await fs.writeFile(outsideRelativeFile, "old relative content");

    const result = await createHostWorkspaceEditTool(workspaceDir, {
      workspaceOnly: false,
    }).execute("edit-outside", {
      path: relativeOutsidePath,
      edits: [{ oldText: "old relative content", newText: "new relative content" }],
    });
    expect(hasToolError(result)).toBe(false);
    const content = await fs.readFile(outsideRelativeFile, "utf-8");
    expect(content).toBe("new relative content");
  });

  it("should allow read outside workspace when workspaceOnly=false", async () => {
    await fs.writeFile(outsideFile, "test read content");

    const result = await readTool().execute("read-outside", { path: outsideFile });
    expect(hasToolError(result)).toBe(false);
    expect(JSON.stringify(result.content)).toContain("test read content");
  });

  it("makes only missing canonical daily-memory reads implicitly optional", async () => {
    const read = readTool();
    for (const filePath of [
      "memory/2026-05-15.md",
      "./memory/2026-05-16.md",
      "././memory/2026-05-18.md",
      ...(process.platform === "win32" ? ["memory\\2026-05-19.md"] : []),
    ]) {
      expect(
        await read.execute("test-call-missing-daily-memory", { path: filePath }),
      ).toStrictEqual({
        content: [{ type: "text", text: `Optional file not found: ${filePath}.` }],
        details: { kind: "not_found", status: "not_found", path: filePath, optional: true },
      });
    }
    const existingPath = "memory/2026-05-17.md";
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, existingPath), "present daily memory");
    expect(
      getTextContent(await read.execute("test-call-existing-daily-memory", { path: existingPath })),
    ).toBe("present daily memory");
    for (const filePath of [
      "notes/missing.md",
      "memory/2026-05-15-session.md",
      "../memory/2026-05-15.md",
      " memory/2026-05-15.md",
      "memory/2026-05-15.md ",
      ...(process.platform === "win32" ? [] : ["memory\\2026-05-15.md"]),
    ]) {
      await expect(
        read.execute("test-call-missing-ordinary-file", { path: filePath }),
      ).rejects.toThrow(/ENOENT|no such file|not found/i);
    }
  });

  it("should allow write outside workspace when workspaceOnly is unset", async () => {
    const outsideUnsetFile = path.join(tmpDir, "outside-unset-write.txt");
    const result = await createHostWorkspaceWriteTool(workspaceDir).execute("write-outside", {
      path: outsideUnsetFile,
      content: "unset write content",
    });
    expect(hasToolError(result)).toBe(false);
    const content = await fs.readFile(outsideUnsetFile, "utf-8");
    expect(content).toBe("unset write content");
  });

  it("should block write outside workspace when workspaceOnly=true", async () => {
    const writeTool = wrapToolWorkspaceRootGuardWithOptions(
      createHostWorkspaceWriteTool(workspaceDir, { workspaceOnly: true }),
      workspaceDir,
    );

    await expect(
      writeTool.execute("test-call-4", {
        path: outsideFile,
        content: "test content",
      }),
    ).rejects.toThrow(/Path escapes (workspace|sandbox) root/);
  });

  it("restricts memory-triggered writes to append-only canonical memory files", async () => {
    const allowedRelativePath = "memory/2026-03-07.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);
    await fs.mkdir(path.dirname(allowedAbsolutePath), { recursive: true });
    await fs.writeFile(allowedAbsolutePath, "seed");

    const writeTool = memoryWriteTool(allowedRelativePath);

    await expect(
      writeTool.execute("test-call-memory-deny", {
        path: outsideFile,
        content: "should not write here",
      }),
    ).rejects.toThrow(/Memory flush writes are restricted to memory\/2026-03-07\.md/);

    const result = await writeTool.execute("test-call-memory-append", {
      path: allowedRelativePath,
      content: "new note",
    });
    expect(hasToolError(result)).toBe(false);
    expect(result).toStrictEqual({
      content: [{ type: "text", text: "Appended content to memory/2026-03-07.md." }],
      details: { changed: true },
    });
    await expect(fs.readFile(allowedAbsolutePath, "utf-8")).resolves.toBe("seed\nnew note");
  });

  it("accepts memory-triggered append-only writes with malformed XML arg-value path suffixes", async () => {
    const allowedRelativePath = "memory/2026-03-08.md";
    const allowedAbsolutePath = path.join(workspaceDir, allowedRelativePath);

    const writeTool = memoryWriteTool(allowedRelativePath);

    const result = await writeTool.execute("test-call-memory-suffix", {
      path: `${allowedRelativePath}</arg_value>>`,
      content: "new note",
    });

    expect(hasToolError(result)).toBe(false);
    expect(result).toStrictEqual({
      content: [{ type: "text", text: "Appended content to memory/2026-03-08.md." }],
      details: { changed: true },
    });
    await expect(fs.readFile(allowedAbsolutePath, "utf-8")).resolves.toBe("new note");
  });

  it("rejects memory-triggered append-only paths that become empty after suffix stripping", async () => {
    const writeTool = memoryWriteTool("memory/2026-03-09.md");

    await expect(
      writeTool.execute("test-call-memory-empty-suffix", {
        path: "</arg_value>>",
        content: "new note",
      }),
    ).rejects.toThrow(/Missing required parameter: path/);
  });
});
