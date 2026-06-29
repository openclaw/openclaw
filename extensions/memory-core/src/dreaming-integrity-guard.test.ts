// Memory Core tests cover dreaming memory-file integrity diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffMissingMemoryFiles, snapshotMemoryDirFiles } from "./dreaming-integrity-guard.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

describe("dreaming memory-file integrity guard", () => {
  it("reports ok with an empty snapshot when memory/ does not exist yet", async () => {
    const workspaceDir = await createTempWorkspace("integrity-missing-dir-");
    const snapshot = await snapshotMemoryDirFiles(workspaceDir);
    expect(snapshot).toEqual({ ok: true, files: new Map() });
  });

  it("snapshots top-level .md files under memory/ and ignores other entries", async () => {
    const workspaceDir = await createTempWorkspace("integrity-snapshot-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(path.join(memoryDir, "dreaming"), { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-05-15.md"), "hello", "utf-8");
    await fs.writeFile(path.join(memoryDir, "notes.txt"), "ignored", "utf-8");
    await fs.writeFile(path.join(memoryDir, "dreaming", "nested.md"), "ignored", "utf-8");

    const snapshot = await snapshotMemoryDirFiles(workspaceDir);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) {
      throw new Error("expected ok snapshot");
    }
    expect([...snapshot.files.keys()]).toEqual(["2026-05-15.md"]);
    expect(snapshot.files.get("2026-05-15.md")?.sizeBytes).toBe(5);
  });

  it("detects files present before but missing after", async () => {
    const workspaceDir = await createTempWorkspace("integrity-diff-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-05-15.md"), "old", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-05-16.md"), "kept", "utf-8");

    const before = await snapshotMemoryDirFiles(workspaceDir);
    await fs.rm(path.join(memoryDir, "2026-05-15.md"));
    const after = await snapshotMemoryDirFiles(workspaceDir);

    const missing = diffMissingMemoryFiles(before, after);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.name).toBe("2026-05-15.md");
  });

  it("reports no missing files when nothing changed", async () => {
    const workspaceDir = await createTempWorkspace("integrity-stable-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-05-15.md"), "stable", "utf-8");

    const before = await snapshotMemoryDirFiles(workspaceDir);
    const after = await snapshotMemoryDirFiles(workspaceDir);

    expect(diffMissingMemoryFiles(before, after)).toEqual([]);
  });

  it("never reports missing files when either snapshot failed", async () => {
    const failed = { ok: false as const, reason: "boom" };
    const okEmpty = { ok: true as const, files: new Map() };
    expect(diffMissingMemoryFiles(failed, okEmpty)).toEqual([]);
    expect(diffMissingMemoryFiles(okEmpty, failed)).toEqual([]);
  });
});
