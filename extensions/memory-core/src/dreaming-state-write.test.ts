// Contract tests for writeMemoryCoreWorkspaceEntries skip-unchanged behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  configureMemoryCoreDreamingState,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { resetMemoryCoreDreamingStateForTests } from "./test-helpers.js";

const MEMORY_CORE_PLUGIN_ID = "memory-core";
const tempDirs: string[] = [];

type WriteCounts = {
  register: number;
  delete: number;
};

let writeCounts: WriteCounts = { register: 0, delete: 0 };

function resetWriteCounts(): void {
  writeCounts = { register: 0, delete: 0 };
}

function wrapStoreWithWriteCounts<T>(store: PluginStateKeyedStore<T>): PluginStateKeyedStore<T> {
  return {
    ...store,
    register: async (key, value, opts) => {
      writeCounts.register += 1;
      await store.register(key, value, opts);
    },
    delete: async (key) => {
      writeCounts.delete += 1;
      return store.delete(key);
    },
  };
}

beforeAll(() => {
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    wrapStoreWithWriteCounts(
      createPluginStateKeyedStoreForTests<T>(MEMORY_CORE_PLUGIN_ID, {
        ...options,
        env: process.env,
      }),
    ),
  );
});

afterAll(() => {
  resetMemoryCoreDreamingStateForTests();
});

afterEach(async () => {
  resetWriteCounts();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dreaming-state-write-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

describe("writeMemoryCoreWorkspaceEntries", () => {
  it("writes all rows on first run, then skips unchanged rows on identical second run", async () => {
    const workspaceDir = await createWorkspace();
    const entries = [
      { key: "a.txt", value: { path: "a.txt", mtime: 1 } },
      { key: "b.txt", value: { path: "b.txt", mtime: 2 } },
      { key: "c.txt", value: { path: "c.txt", mtime: 3 } },
    ];

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries,
    });
    expect(writeCounts.register).toBe(3);
    expect(writeCounts.delete).toBe(0);

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries,
    });
    expect(writeCounts.register).toBe(0);
    expect(writeCounts.delete).toBe(0);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toEqual(expect.arrayContaining(entries));
    expect(stored).toHaveLength(3);
  });

  it("registers only the changed row when one value updates", async () => {
    const workspaceDir = await createWorkspace();
    const initial = [
      { key: "a.txt", value: { path: "a.txt", mtime: 1 } },
      { key: "b.txt", value: { path: "b.txt", mtime: 2 } },
    ];
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: initial,
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [
        { key: "a.txt", value: { path: "a.txt", mtime: 1 } },
        { key: "b.txt", value: { path: "b.txt", mtime: 99 } },
      ],
    });
    expect(writeCounts.register).toBe(1);
    expect(writeCounts.delete).toBe(0);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored.find((row) => row.key === "b.txt")?.value).toEqual({
      path: "b.txt",
      mtime: 99,
    });
  });

  it("deletes only rows absent from the desired set", async () => {
    const workspaceDir = await createWorkspace();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [
        { key: "keep.txt", value: { path: "keep.txt", mtime: 1 } },
        { key: "drop.txt", value: { path: "drop.txt", mtime: 2 } },
      ],
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [{ key: "keep.txt", value: { path: "keep.txt", mtime: 1 } }],
    });
    expect(writeCounts.register).toBe(0);
    expect(writeCounts.delete).toBe(1);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toEqual([{ key: "keep.txt", value: { path: "keep.txt", mtime: 1 } }]);
  });

  it("does not rewrite rows belonging to a different workspace", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceA,
      entries: [{ key: "a.txt", value: { path: "a.txt", mtime: 1 } }],
    });
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceB,
      entries: [{ key: "b.txt", value: { path: "b.txt", mtime: 2 } }],
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceA,
      entries: [{ key: "a.txt", value: { path: "a.txt", mtime: 1 } }],
    });
    expect(writeCounts.register).toBe(0);
    expect(writeCounts.delete).toBe(0);

    const storedB = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir: workspaceB,
    });
    expect(storedB).toEqual([{ key: "b.txt", value: { path: "b.txt", mtime: 2 } }]);
  });
});
