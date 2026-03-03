/**
 * Tests for edit tool post-write recovery: when the upstream library throws after
 * having already written the file (e.g. generateDiffString fails), we catch and
 * if the file on disk contains the intended newText we return success (#32333).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeThrows: true,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createEditTool: (cwd: string, options?: Parameters<typeof actual.createEditTool>[1]) => {
      const base = actual.createEditTool(cwd, options);
      return {
        ...base,
        execute: async (...args: Parameters<typeof base.execute>) => {
          if (mocks.executeThrows) {
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
    await fs.writeFile(filePath, `\n\n${newText}\n`, "utf-8");

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

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute("call-1", { path: filePath, oldText: "x", newText: "never-written" }, undefined),
    ).rejects.toThrow("Simulated post-write failure");
  });

  it("rethrows when file still contains oldText (pre-write failure; avoid false success)", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edit-recovery-"));
    const filePath = path.join(tmpDir, "pre-write-fail.md");
    const oldText = "replace me";
    const newText = "new content";
    await fs.writeFile(filePath, `before ${oldText} after ${newText}`, "utf-8");

    const tool = createHostWorkspaceEditTool(tmpDir);
    await expect(
      tool.execute("call-1", { path: filePath, oldText, newText }, undefined),
    ).rejects.toThrow("Simulated post-write failure");
  });
});
