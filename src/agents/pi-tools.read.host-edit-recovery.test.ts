/**
 * Tests for edit tool post-write recovery: when the upstream library throws after
 * having already written the file (e.g. generateDiffString fails), we catch and
 * if the file on disk contains the intended newText we return success (#32333).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EditToolOptions } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeThrows: true,
  /** When true the mock writes the file (replacing oldText with newText) before throwing,
   *  simulating a failure that happens *after* the file was already modified on disk
   *  (e.g. generateDiffString). When false the mock throws without touching the file,
   *  simulating a failure that happens *before* writing (e.g. oldText not found). */
  writeBeforeThrow: true,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  const _fs = await import("node:fs/promises");
  const _path = await import("node:path");
  return {
    ...actual,
    createEditTool: (cwd: string, options?: EditToolOptions) => {
      const base = actual.createEditTool(cwd, options);
      return {
        ...base,
        execute: async (...args: Parameters<typeof base.execute>) => {
          if (mocks.executeThrows) {
            if (mocks.writeBeforeThrow) {
              // Simulate the upstream tool writing the replacement before crashing.
              const params = args[1] as Record<string, string> | undefined;
              if (params?.path && params.oldText && params.newText) {
                const abs = _path.default.isAbsolute(params.path)
                  ? params.path
                  : _path.default.resolve(cwd, params.path);
                const cur = await _fs.default.readFile(abs, "utf-8");
                if (cur.includes(params.oldText)) {
                  await _fs.default.writeFile(
                    abs,
                    cur.replace(params.oldText, params.newText),
                    "utf-8",
                  );
                }
              }
            }
            throw new Error("Simulated post-write failure (e.g. generateDiffString)");
          }
          return base.execute(...args);
        },
      };
    },
  };
});

const { createHostWorkspaceEditTool } = await import("./pi-tools.read.js");

describe("createHostWorkspaceEditTool post-write recovery", () => {
  let tmpDir = "";

  afterEach(async () => {
    mocks.executeThrows = true;
    mocks.writeBeforeThrow = true;
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = "";
    }
  });

  it("returns success when upstream throws but file has newText and no longer has oldText", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "MEMORY.md");
    const oldText = "# Memory";
    const newText = "Blog Writing";
    // Start with oldText in the file; the mock will replace it with newText before throwing.
    await fs.writeFile(filePath, `\n\n${oldText}\n`, "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    const result = await tool.execute("call-1", { path: filePath, oldText, newText }, undefined);

    expect(result).toBeDefined();
    const content = Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: Array<{ type?: string; text?: string }> }).content
      : [];
    const textBlock = content.find((b) => b?.type === "text" && typeof b.text === "string");
    expect(textBlock?.text).toContain("Successfully replaced text");
  });

  it("rethrows when file on disk does not contain newText", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "other.md");
    await fs.writeFile(filePath, "unchanged content", "utf-8");
    mocks.writeBeforeThrow = false;

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute("call-1", { path: filePath, oldText: "x", newText: "never-written" }, undefined),
    ).rejects.toThrow("Simulated post-write failure");
  });

  it("returns success when oldText is a substring of newText (e.g. appending/wrapping) (#49363)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "wrap.md");
    const oldText = "foo";
    const newText = "foobar";
    // Start with oldText in the file; the mock will replace it with newText before throwing.
    await fs.writeFile(filePath, `before ${oldText} after`, "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    const result = await tool.execute("call-1", { path: filePath, oldText, newText }, undefined);

    expect(result).toBeDefined();
    const content = Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: Array<{ type?: string; text?: string }> }).content
      : [];
    const textBlock = content.find((b) => b?.type === "text" && typeof b.text === "string");
    expect(textBlock?.text).toContain("Successfully replaced text");
  });

  it("rethrows when oldText is substring of newText but oldText also appears outside newText", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "partial.md");
    const oldText = "foo";
    const newText = "foobar";
    // The mock replaces the first "foo" with "foobar", but a second "foo" remains
    // separately — the edit did not fully succeed so recovery should rethrow.
    await fs.writeFile(filePath, `${oldText} and also foo here`, "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute("call-1", { path: filePath, oldText, newText }, undefined),
    ).rejects.toThrow("Simulated post-write failure");
  });

  it("rethrows when file still contains oldText (pre-write failure; avoid false success)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "pre-write-fail.md");
    const oldText = "replace me";
    const newText = "new content";
    // Simulate a pre-write failure: file was not modified (threw before writing).
    mocks.writeBeforeThrow = false;
    await fs.writeFile(filePath, `before ${oldText} after ${newText}`, "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute("call-1", { path: filePath, oldText, newText }, undefined),
    ).rejects.toThrow("Simulated post-write failure");
  });

  it("rethrows when oldText is substring of newText and file already had newText (pre-write failure)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "pre-existing-new.md");
    const oldText = "foo";
    const newText = "foobar";
    // File already contains newText but no standalone oldText. The upstream tool threw
    // before writing (e.g. oldText not found as exact match). Without the pre-state
    // comparison this would be a false success.
    mocks.writeBeforeThrow = false;
    await fs.writeFile(filePath, `before ${newText} after`, "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute("call-1", { path: filePath, oldText, newText }, undefined),
    ).rejects.toThrow("Simulated post-write failure");
  });
});
