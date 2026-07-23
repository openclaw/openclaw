// Contract tests for writeMemoryCoreWorkspaceEntries skip-unchanged behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runDreamingSweepPhases } from "./dreaming-phases.js";
import {
  configureMemoryCoreDreamingState,
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_WORKSPACE_STATE_MAX_ENTRIES,
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
const writeCountsByNamespace = new Map<string, WriteCounts>();

function resetWriteCounts(): void {
  writeCounts = { register: 0, delete: 0 };
  writeCountsByNamespace.clear();
}

function incrementNamespaceWriteCount(namespace: string, operation: keyof WriteCounts): void {
  const counts = writeCountsByNamespace.get(namespace) ?? { register: 0, delete: 0 };
  counts[operation] += 1;
  writeCountsByNamespace.set(namespace, counts);
}

function namespaceWriteCounts(namespace: string): WriteCounts {
  return writeCountsByNamespace.get(namespace) ?? { register: 0, delete: 0 };
}

function wrapStoreWithWriteCounts<T>(
  store: PluginStateKeyedStore<T>,
  namespace: string,
): PluginStateKeyedStore<T> {
  return {
    ...store,
    register: async (key, value, opts) => {
      writeCounts.register += 1;
      incrementNamespaceWriteCount(namespace, "register");
      await store.register(key, value, opts);
    },
    delete: async (key) => {
      writeCounts.delete += 1;
      incrementNamespaceWriteCount(namespace, "delete");
      return store.delete(key);
    },
  };
}

function configureCountedDreamingState(params?: {
  maxEntriesByNamespace?: Readonly<Record<string, number>>;
}): void {
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    wrapStoreWithWriteCounts(
      createPluginStateKeyedStoreForTests<T>(MEMORY_CORE_PLUGIN_ID, {
        ...options,
        // Capacity tests override maxEntries for a dedicated namespace so
        // eviction can be proven without writing
        // DREAMING_WORKSPACE_STATE_MAX_ENTRIES rows or reopening production
        // namespaces with a conflicting limit signature.
        maxEntries: params?.maxEntriesByNamespace?.[options.namespace] ?? options.maxEntries,
        env: process.env,
      }),
      options.namespace,
    ),
  );
}

beforeAll(() => {
  configureCountedDreamingState();
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
  it("writes only new daily state through the production light Dreaming sweep", async () => {
    const workspaceDir = await createWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "2026-04-04.md"), "Alpha memory.\n", "utf-8");
    await fs.writeFile(path.join(memoryDir, "2026-04-05.md"), "Beta memory.\n", "utf-8");
    const pluginConfig = {
      dreaming: {
        enabled: true,
        timezone: "UTC",
        storage: { mode: "separate", separateReports: false },
        phases: {
          light: { enabled: true, limit: 20, lookbackDays: 7 },
          rem: { enabled: false, limit: 0, lookbackDays: 7 },
        },
      },
    };
    const runSweep = () =>
      runDreamingSweepPhases({
        workspaceDir,
        pluginConfig,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        nowMs: Date.parse("2026-04-05T10:05:00.000Z"),
      });

    resetWriteCounts();
    await runSweep();
    expect(namespaceWriteCounts(DREAMING_DAILY_INGESTION_NAMESPACE)).toEqual({
      register: 2,
      delete: 0,
    });

    await fs.writeFile(path.join(memoryDir, "2026-04-03.md"), "Gamma memory.\n", "utf-8");
    resetWriteCounts();
    await runSweep();
    expect(namespaceWriteCounts(DREAMING_DAILY_INGESTION_NAMESPACE)).toEqual({
      register: 1,
      delete: 0,
    });

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toHaveLength(3);
  });

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

  it("preserves last-write-wins when duplicate keys return to the original value", async () => {
    const workspaceDir = await createWorkspace();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [{ key: "same.txt", value: { path: "same.txt", mtime: 1 } }],
    });

    resetWriteCounts();
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
      entries: [
        { key: "same.txt", value: { path: "same.txt", mtime: 2 } },
        { key: "same.txt", value: { path: "same.txt", mtime: 1 } },
      ],
    });
    expect(writeCounts.register).toBe(2);

    const stored = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
      workspaceDir,
    });
    expect(stored).toEqual([{ key: "same.txt", value: { path: "same.txt", mtime: 1 } }]);
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

  it("at namespace capacity, skips unchanged rows and lets oldest created_at rows evict", async () => {
    // Production opens at DREAMING_WORKSPACE_STATE_MAX_ENTRIES (50_000). This
    // test uses a small cap on a dedicated namespace so the same skip +
    // created_at eviction policy is proven without writing tens of thousands
    // of rows or reopening a production namespace with a different limit.
    expect(DREAMING_WORKSPACE_STATE_MAX_ENTRIES).toBe(50_000);
    const capacity = 3;
    const capacityNamespace = "dreaming-workspace-capacity-retention";
    configureCountedDreamingState({
      maxEntriesByNamespace: { [capacityNamespace]: capacity },
    });
    vi.useFakeTimers();
    try {
      const workspaceDir = await createWorkspace();
      const oldest = { key: "oldest.txt", value: { path: "oldest.txt", mtime: 1 } };
      const mid = { key: "mid.txt", value: { path: "mid.txt", mtime: 2 } };
      const newest = { key: "newest.txt", value: { path: "newest.txt", mtime: 3 } };
      const incoming = { key: "incoming.txt", value: { path: "incoming.txt", mtime: 4 } };

      vi.setSystemTime(1_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest],
      });
      vi.setSystemTime(2_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid],
      });
      vi.setSystemTime(3_000);
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, newest],
      });

      resetWriteCounts();
      vi.setSystemTime(4_000);
      // Unchanged pass must not refresh created_at via register().
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, newest],
      });
      expect(writeCounts.register).toBe(0);
      expect(writeCounts.delete).toBe(0);

      resetWriteCounts();
      vi.setSystemTime(5_000);
      // One new row at capacity: only the new key registers; the oldest
      // unchanged row keeps its earlier created_at and is the eviction victim.
      await writeMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
        entries: [oldest, mid, newest, incoming],
      });
      expect(writeCounts.register).toBe(1);

      const stored = await readMemoryCoreWorkspaceEntries({
        namespace: capacityNamespace,
        workspaceDir,
      });
      expect(stored).toHaveLength(capacity);
      expect(stored.map((row) => row.key).sort()).toEqual(
        ["incoming.txt", "mid.txt", "newest.txt"].sort(),
      );
      expect(stored.some((row) => row.key === "oldest.txt")).toBe(false);
    } finally {
      vi.useRealTimers();
      configureCountedDreamingState();
    }
  });
});
