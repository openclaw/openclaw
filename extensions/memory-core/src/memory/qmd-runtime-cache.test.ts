import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  configureMemoryCoreDreamingState,
  configureMemoryCoreDreamingStateForTests,
  openMemoryCoreStateStore,
  memoryCoreWorkspaceEntryKey,
  resetMemoryCoreDreamingStateForTests,
} from "../dreaming-state.js";
import {
  QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE,
  QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_TTL_MS,
  QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE,
  QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_TTL_MS,
  buildQmdMultiCollectionProbeCacheContextHash,
  clearQmdCollectionValidationCache,
  clearQmdMultiCollectionProbeCache,
  readQmdCollectionValidationCache,
  readQmdMultiCollectionProbeCache,
  type QmdRuntimeCollectionValidationCacheContext,
  type QmdRuntimeManagedCollection,
  type QmdRuntimeMultiCollectionProbeCacheContext,
  writeQmdCollectionValidationCache,
  writeQmdMultiCollectionProbeCache,
} from "./qmd-runtime-cache.js";

const tempRoots: string[] = [];

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
});

afterAll(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  resetMemoryCoreDreamingStateForTests();
});

async function clearStore(namespace: string): Promise<void> {
  try {
    await openMemoryCoreStateStore({
      namespace,
      maxEntries: 1_000,
    }).clear();
  } catch {
    // fail open
  }
}

afterEach(async () => {
  await clearStore(QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE);
  await clearStore(QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE);
});

function makeWorkspace(): Promise<string> {
  const prefix = path.join(os.tmpdir(), `qmd-runtime-cache-${Date.now()}-`);
  return fs.mkdtemp(prefix).then((workspaceDir) => {
    tempRoots.push(workspaceDir);
    return workspaceDir;
  });
}

function managedCollections(): QmdRuntimeManagedCollection[] {
  return [
    {
      name: "project-notes",
      kind: "memory",
      path: "/repo/project-notes",
      pattern: "*.md",
    },
    {
      name: "sessions",
      kind: "sessions",
      path: "/repo/sessions",
      pattern: "*",
    },
  ];
}

function collectionValidationContext(
  workspaceDir: string,
): QmdRuntimeCollectionValidationCacheContext {
  return {
    workspaceDir,
    agentId: "agent-a",
    qmdCommand: "qmd",
    qmdIndexPath: path.join(workspaceDir, ".openclaw", "index.sqlite"),
    searchMode: "search",
    collections: managedCollections(),
    sources: ["memory", "sessions"],
  };
}

function multiCollectionProbeContext(
  workspaceDir: string,
): QmdRuntimeMultiCollectionProbeCacheContext {
  return {
    workspaceDir,
    agentId: "agent-a",
    qmdCommand: "qmd",
    qmdIndexPath: path.join(workspaceDir, ".openclaw", "index.sqlite"),
    searchMode: "search",
    sources: ["memory", "sessions"],
  };
}

describe("qmd-runtime-cache", () => {
  it("writes and reads collection validation cache entries", async () => {
    const workspaceDir = await makeWorkspace();
    const context = collectionValidationContext(workspaceDir);
    const writeStartedAtMs = 1_000;

    const writeOk = await writeQmdCollectionValidationCache(context, writeStartedAtMs);
    expect(writeOk).toBe(true);

    const read = await readQmdCollectionValidationCache(
      { ...context, sources: ["sessions", "memory"] },
      writeStartedAtMs + 1,
    );
    expect(read).toMatchObject({
      state: "hit",
      value: {
        validation: {
          ok: true,
          collectionCount: context.collections.length,
        },
      },
    });
  });

  it("writes and reads multi-collection probe cache entries", async () => {
    const workspaceDir = await makeWorkspace();
    const context = multiCollectionProbeContext(workspaceDir);
    const writeStartedAtMs = 2_000;

    const writeOk = await writeQmdMultiCollectionProbeCache(context, true, writeStartedAtMs);
    expect(writeOk).toBe(true);

    const read = await readQmdMultiCollectionProbeCache(context, writeStartedAtMs + 1);
    expect(read).toMatchObject({
      state: "hit",
      value: {
        multiCollectionProbe: {
          supported: true,
        },
      },
    });
  });

  it("scopes cache entries by workspace", async () => {
    const firstWorkspace = await makeWorkspace();
    const secondWorkspace = await makeWorkspace();
    const context = collectionValidationContext(firstWorkspace);

    expect(await writeQmdCollectionValidationCache(context, 3_000)).toBe(true);

    const sameLogicalDifferentWorkspace: QmdRuntimeCollectionValidationCacheContext = {
      ...context,
      workspaceDir: secondWorkspace,
      qmdIndexPath: path.join(secondWorkspace, ".openclaw", "index.sqlite"),
    };

    const miss = await readQmdCollectionValidationCache(sameLogicalDifferentWorkspace, 3_001);
    expect(miss).toStrictEqual({ state: "miss" });
  });

  it("misses collection validation cache when managed collection paths change", async () => {
    const workspaceDir = await makeWorkspace();
    const context = collectionValidationContext(workspaceDir);

    expect(await writeQmdCollectionValidationCache(context, 3_500)).toBe(true);

    const changedContext: QmdRuntimeCollectionValidationCacheContext = {
      ...context,
      collections: context.collections.map((collection) =>
        collection.name === "project-notes"
          ? {
              name: collection.name,
              kind: collection.kind,
              path: `${collection.path}-moved`,
              pattern: collection.pattern,
            }
          : collection,
      ),
    };

    expect(await readQmdCollectionValidationCache(changedContext, 3_501)).toStrictEqual({
      state: "miss",
    });
  });

  it("misses validation and probe caches when qmd runtime environment changes", async () => {
    const workspaceDir = await makeWorkspace();
    const validationContext = {
      ...collectionValidationContext(workspaceDir),
      qmdEnvironmentHash: "env-a",
    };
    const probeContext = {
      ...multiCollectionProbeContext(workspaceDir),
      qmdEnvironmentHash: "env-a",
    };

    expect(await writeQmdCollectionValidationCache(validationContext, 3_600)).toBe(true);
    expect(await writeQmdMultiCollectionProbeCache(probeContext, true, 3_600)).toBe(true);

    expect(
      await readQmdCollectionValidationCache(
        { ...validationContext, qmdEnvironmentHash: "env-b" },
        3_601,
      ),
    ).toStrictEqual({ state: "miss" });
    expect(
      await readQmdMultiCollectionProbeCache(
        { ...probeContext, qmdEnvironmentHash: "env-b" },
        3_601,
      ),
    ).toStrictEqual({ state: "miss" });
  });

  it("treats cache misses for malformed values and expired entries", async () => {
    const workspaceDir = await makeWorkspace();
    const context = multiCollectionProbeContext(workspaceDir);
    const nowMs = 4_000;
    await writeQmdMultiCollectionProbeCache(context, false, nowMs);

    const key = memoryCoreWorkspaceEntryKey(
      workspaceDir,
      `qmd-runtime-cache.multi-collection-probe:${buildQmdMultiCollectionProbeCacheContextHash(context)}`,
    );
    const store = openMemoryCoreStateStore({
      namespace: QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE,
      maxEntries: 1_000,
    });

    await store.register(key, {
      version: 1,
      createdAtMs: "bad",
      expiresAtMs: 0,
      keyHash: "bad",
      multiCollectionProbe: { supported: true },
    });

    const malformed = await readQmdMultiCollectionProbeCache(context, nowMs + 1);
    expect(malformed).toStrictEqual({ state: "miss" });

    const expired = await readQmdMultiCollectionProbeCache(
      context,
      nowMs + QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_TTL_MS + 1,
    );
    expect(expired).toStrictEqual({ state: "miss" });
  });

  it("uses separate namespaces for validation and probe entries", async () => {
    const workspaceDir = await makeWorkspace();
    const validationContext = collectionValidationContext(workspaceDir);
    const probeContext = multiCollectionProbeContext(workspaceDir);

    expect(await writeQmdCollectionValidationCache(validationContext, 5_000)).toBe(true);
    expect(await writeQmdMultiCollectionProbeCache(probeContext, true, 5_000)).toBe(true);

    const validationStore = openMemoryCoreStateStore({
      namespace: QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE,
      maxEntries: 1_000,
    });
    const probeStore = openMemoryCoreStateStore({
      namespace: QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE,
      maxEntries: 1_000,
    });

    expect((await validationStore.entries()).length).toBeGreaterThan(0);
    expect((await probeStore.entries()).length).toBeGreaterThan(0);
  });

  it("fails open when state store is unavailable", async () => {
    const workspaceDir = await makeWorkspace();
    const validationContext = collectionValidationContext(workspaceDir);
    const probeContext = multiCollectionProbeContext(workspaceDir);

    configureMemoryCoreDreamingState(() => {
      throw new Error("state store unavailable");
    });

    try {
      expect(await readQmdCollectionValidationCache(validationContext)).toStrictEqual({
        state: "miss",
      });
      expect(await writeQmdCollectionValidationCache(validationContext)).toBe(false);
      expect(await readQmdMultiCollectionProbeCache(probeContext)).toStrictEqual({ state: "miss" });
      expect(await writeQmdMultiCollectionProbeCache(probeContext, true)).toBe(false);
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }
  });

  it("exposes bounded TTL windows", () => {
    expect(QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_TTL_MS).toBe(5 * 60_000);
    expect(QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_TTL_MS).toBe(10 * 60_000);
  });

  it("can clear cache keys explicitly", async () => {
    const workspaceDir = await makeWorkspace();
    const validationContext = collectionValidationContext(workspaceDir);
    const probeContext = multiCollectionProbeContext(workspaceDir);

    expect(await writeQmdCollectionValidationCache(validationContext)).toBe(true);
    expect(await writeQmdMultiCollectionProbeCache(probeContext, true)).toBe(true);

    await clearQmdCollectionValidationCache(validationContext);
    await clearQmdMultiCollectionProbeCache(probeContext);

    expect(await readQmdCollectionValidationCache(validationContext)).toStrictEqual({
      state: "miss",
    });
    expect(await readQmdMultiCollectionProbeCache(probeContext)).toStrictEqual({ state: "miss" });
  });
});
