import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectMemorySourceState, loadMemorySourceFileState } from "./manager-source-state.js";

let db: DatabaseSync;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: false });
});
afterEach(() => db.close());
const load = (paths?: string[]) => loadMemorySourceFileState({ db, source: "memory", paths });
const inspect = (workspaceDir: string, extraPaths: { path: string; pattern?: string }[]) =>
  inspectMemorySourceState({
    readIndexedRows: async () => load(),
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

describe("memory source state", () => {
  beforeEach(() => {
    const insert = db.prepare(
      "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("memory/one.md", "memory", "hash-1", 100.25, 10);
    insert.run("memory/two.md", "memory", "hash-2", 200.5, 20);
    insert.run("memory/one.md", "sessions", "session-hash", 300.75, 30);
  });

  it("loads complete indexed rows for the requested source", () => {
    expect(load()).toEqual([
      { path: "memory/one.md", hash: "hash-1", mtime: 100.25, size: 10 },
      { path: "memory/two.md", hash: "hash-2", mtime: 200.5, size: 20 },
    ]);
    db.prepare("DELETE FROM memory_index_sources WHERE source = ?").run("memory");
    expect(load()).toEqual([]);
  });

  it.each([
    [[], []],
    [["memory/one.md", "memory/one.md", "missing' OR 1=1 --"], ["hash-1"]],
    [[...Array.from({ length: 33_000 }, (_, i) => `missing-${i}`), "memory/one.md"], ["hash-1"]],
  ])("restricts source snapshots to requested paths", (paths, expected) => {
    expect(load(paths).map((row) => row.hash)).toEqual(expected);
  });
});

describe("memory source inspection extra-path diagnostics", () => {
  it.skipIf(process.platform === "win32").each([true, false])(
    "reports skipped roots with canonical memory present: %s",
    async (canonicalMemory) => {
      const { workspaceDir, vaultDir } = await fixture(canonicalMemory);
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

  it.skipIf(process.platform === "win32")(
    "keeps canonical extra roots eligible while skipping nested symlinks without a root warning",
    async () => {
      const { workspaceDir, vaultDir } = await fixture();
      const nestedTarget = tempDirs.make("openclaw-memory-nested-");
      await fs.writeFile(path.join(nestedTarget, "excluded.md"), "# Excluded\n");
      await fs.symlink(nestedTarget, path.join(vaultDir, "nested"), "dir");

      await expect(inspect(workspaceDir, [{ path: vaultDir }])).resolves.toMatchObject({
        eligible: 2,
        issues: [],
      });
    },
  );
});
