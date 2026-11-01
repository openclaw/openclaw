import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { inspectMemorySourceState, loadMemorySourceFileState } from "./manager-source-state.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const inspect = (workspaceDir: string, extraPaths: { path: string; pattern?: string }[]) =>
  inspectMemorySourceState({
    readIndexedRows: async () => [],
    workspaceDir,
    settings: { extraPaths, multimodal: { enabled: false, modalities: [], maxFileBytes: 0 } },
    concurrency: 2,
  });
async function fixture(canonicalMemory = true) {
  const workspaceDir = tempDirs.make("openclaw-memory-source-");
  const vaultDir = tempDirs.make("openclaw-memory-vault-");
  await fs.mkdir(path.join(workspaceDir, "memory"));
  if (canonicalMemory) {
    await fs.writeFile(path.join(workspaceDir, "memory", "notes.md"), "# Canonical\n");
  }
  await fs.writeFile(path.join(vaultDir, "vault-note.md"), "# Vault\n");
  return { workspaceDir, vaultDir };
}

const first = { path: "memory/one.md", hash: "hash-1", mtime: 100.25, size: 10 };
const second = { path: "memory/two.md", hash: "hash-2", mtime: 200.5, size: 20 };
it.each([
  [undefined, [first, second]],
  [[], []],
  [["memory/one.md", "memory/one.md", "missing' OR 1=1 --"], [first]],
  [[...Array.from({ length: 33_000 }, (_, i) => `missing-${i}`), "memory/one.md"], [first]],
] as const)("loads complete source snapshots with path filters", (paths, expected) => {
  using db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
  const insert = db.prepare(
    "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("memory/one.md", "memory", "hash-1", 100.25, 10);
  insert.run("memory/two.md", "memory", "hash-2", 200.5, 20);
  insert.run("memory/one.md", "sessions", "session-hash", 300.75, 30);
  const load = () => loadMemorySourceFileState({ db, source: "memory", paths });
  expect(load()).toEqual(expected);
  if (paths === undefined) {
    db.prepare("DELETE FROM memory_index_sources WHERE source = ?").run("memory");
    expect(load()).toEqual([]);
  }
});
it.skipIf(process.platform === "win32").each(["canonical", "empty", "nested"])(
  "diagnoses symlink roots and nested links with %s memory",
  async (mode) => {
    const canonicalMemory = mode !== "empty";
    const { workspaceDir, vaultDir } = await fixture(canonicalMemory);
    if (mode === "nested") {
      const nestedTarget = tempDirs.make("openclaw-memory-nested-");
      await fs.writeFile(path.join(nestedTarget, "excluded.md"), "# Excluded\n");
      await fs.symlink(nestedTarget, path.join(vaultDir, "nested"), "dir");
      await expect(inspect(workspaceDir, [{ path: vaultDir }])).resolves.toMatchObject({
        eligible: 2,
        issues: [],
      });
      return;
    }
    const linkedRoot = path.join(workspaceDir, "obsidian");
    await fs.symlink(vaultDir, linkedRoot, "dir");
    await fs.mkdir(path.join(workspaceDir, ".openclaw-repair"));
    await fs.symlink(vaultDir, path.join(workspaceDir, ".openclaw-repair", "root-memory"), "dir");

    const inspection = await inspect(workspaceDir, [
      { path: "obsidian" },
      { path: "./obsidian", pattern: "*.md" },
      { path: ".openclaw-repair/root-memory" },
      { path: "missing" },
    ]);

    expect(inspection).toMatchObject({
      eligible: canonicalMemory ? 1 : 0,
      issues: [
        ...(canonicalMemory ? [] : ["no eligible memory files found"]),
        expect.stringContaining('extra path "' + linkedRoot + '" is a symlink root'),
      ],
    });
    expect(inspection.issues.at(-1)).toContain("configure its resolved absolute directory");
  },
);
