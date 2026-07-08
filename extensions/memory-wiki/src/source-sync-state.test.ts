// Memory Wiki tests cover source sync state plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  pruneImportedSourceEntries,
  readLegacyMemoryWikiSourceSyncState,
  readMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-sync-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(env: NodeJS.ProcessEnv) {
  return createMemoryWikiSourceSyncStateStore(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
  );
}

describe("memory wiki source sync state", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    configureMemoryWikiSourceSyncStateStore(undefined);
  });

  afterEach(async () => {
    configureMemoryWikiSourceSyncStateStore(undefined);
    resetPluginStateStoreForTests();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists source sync entries in plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });

    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: {
          alpha: {
            group: "bridge",
            pagePath: "sources/alpha.md",
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 123,
            sourceSize: 456,
            renderFingerprint: "fingerprint",
          },
        },
      },
      store,
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        alpha: {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/source.md",
          sourceUpdatedAtMs: 123,
          sourceSize: 456,
          renderFingerprint: "fingerprint",
        },
      },
    });
    await expect(fs.stat(resolveMemoryWikiSourceSyncStatePath(vaultRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps legacy file reads separate for doctor migration", async () => {
    const vaultRoot = await makeTempDir();
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          beta: {
            group: "unsafe-local",
            pagePath: "sources/beta.md",
            sourcePath: "/tmp/beta.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "beta",
          },
        },
      })}\n`,
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {},
    });
    await expect(readLegacyMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {
        beta: {
          group: "unsafe-local",
          pagePath: "sources/beta.md",
          sourcePath: "/tmp/beta.md",
          sourceUpdatedAtMs: 10,
          sourceSize: 20,
          renderFingerprint: "beta",
        },
      },
    });
  });

  it("rejects writes beyond the source-sync state row cap", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    const entries = Object.fromEntries(
      Array.from({ length: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES + 1 }, (_, index) => [
        `source-${index}`,
        {
          group: "bridge" as const,
          pagePath: `sources/source-${index}.md`,
          sourcePath: `/tmp/source-${index}.md`,
          sourceUpdatedAtMs: index,
          sourceSize: index,
          renderFingerprint: `fingerprint-${index}`,
        },
      ]),
    );

    await expect(
      writeMemoryWikiSourceSyncState(vaultRoot, { version: 1, entries }, store),
    ).rejects.toThrow("Memory Wiki source sync state exceeds SQLite entry limit");
  });

  it("salvages human Notes before pruning an imported page", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/salvage-test.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(
      pageAbsPath,
      [
        "# Memory Bridge (test)",
        "## Bridge Source",
        "## Content",
        "```",
        "generated content",
        "```",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "my durable annotations",
        "<!-- openclaw:human:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );

    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    expect(removed).toBe(1);
    await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });

    const salvagePath = path.join(
      vaultRoot,
      ".salvage",
      `${pagePath.replace(/\//g, "_")}.notes.md`,
    );
    const salvaged = await fs.readFile(salvagePath, "utf-8");
    expect(salvaged).toContain("<!-- openclaw:human:start -->");
    expect(salvaged).toContain("my durable annotations");
    expect(salvaged).toContain("<!-- openclaw:human:end -->");
  });

  it("does not create salvage files for pages without human Notes", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/no-notes.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);
    await fs.mkdir(path.dirname(pageAbsPath), { recursive: true });
    await fs.writeFile(pageAbsPath, "# Memory Bridge\n\n## Content\n\nNo notes here.\n", "utf-8");

    await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    const salvageDir = path.join(vaultRoot, ".salvage");
    await expect(fs.access(salvageDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("prunes pages even when the page file is already missing", async () => {
    const vaultRoot = await makeTempDir();
    const pagePath = "sources/missing.md";
    const pageAbsPath = path.join(vaultRoot, pagePath);

    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set(),
      state: {
        version: 1,
        entries: {
          "sync-key": {
            group: "bridge",
            pagePath,
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 0,
            sourceSize: 0,
            renderFingerprint: "fp",
          },
        },
      },
    });

    expect(removed).toBe(1);
    await expect(fs.access(pageAbsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects projected imports that would exceed the source-sync row cap", () => {
    expect(() =>
      assertMemoryWikiSourceSyncStateCapacity({
        state: {
          version: 1,
          entries: {
            retained: {
              group: "unsafe-local",
              pagePath: "sources/retained.md",
              sourcePath: "/tmp/retained.md",
              sourceUpdatedAtMs: 1,
              sourceSize: 1,
              renderFingerprint: "retained",
            },
          },
        },
        group: "bridge",
        incomingCount: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      }),
    ).toThrow("Memory Wiki source sync state exceeds SQLite entry limit");
  });
});
