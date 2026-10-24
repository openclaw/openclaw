import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenBlobStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  deactivateMemoryWikiCompiledCacheOwnersExcept,
  loadMemoryWikiCompiledCache,
  readMemoryWikiDashboardState,
  MEMORY_WIKI_DASHBOARD_ITEM_LIMIT,
  resolveMemoryWikiCompiledCacheOwnerId,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
  type MemoryWikiImportInsightItem,
  type MemoryWikiOverviewItem,
} from "./compiled-cache.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import { buildMemoryWikiImportInsights } from "./import-insights.js";
import {
  appendMemoryWikiLog,
  hashMemoryWikiVaultSources,
  loadMemoryWikiValidatedVaultIdentity,
  loadMemoryWikiVaultIdentity,
} from "./log.js";
import { withMemoryWikiVaultMutation } from "./mutation-coordinator.js";
import { createWikiPromptSectionPreparer } from "./prompt-section.js";
import { getMemoryWikiPage } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import {
  createCompiledDigestPage,
  createCompiledSnapshot,
  createMemoryWikiTestHarness,
  publishCompiledSnapshot as publishSnapshot,
} from "./test-helpers.js";
import { activateExistingMemoryWikiVault, initializeMemoryWikiVault } from "./vault.js";
import { buildMemoryWikiOverview } from "./wiki-overview.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
// Publication fixtures below have no vault source pages.
const EMPTY_SOURCE_GENERATION = hashMemoryWikiVaultSources([]);
let blobStateDir = "";
let blobStoreEnv: NodeJS.ProcessEnv = {};

function createCacheStore() {
  return createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
    createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv),
  );
}

async function createPersistentVault(
  options: Parameters<typeof createVault>[0] = { initialize: true },
): Promise<Awaited<ReturnType<typeof createVault>>> {
  const vault = await createVault(options);
  // The shared unit harness installs its in-memory cache store. These lifecycle
  // tests deliberately switch back to the SQLite-backed plugin Blob test store.
  configureMemoryWikiCompiledCacheStore(createCacheStore());
  return vault;
}

function snapshot(text: string): MemoryWikiCompiledCacheSnapshot {
  return {
    ...createCompiledSnapshot({
      claimCount: 1,
      contradictionCount: 0,
      pages: [
        createCompiledDigestPage({
          claimCount: 1,
          topClaims: [{ text, status: "supported", freshnessLevel: "fresh" }],
        }),
      ],
    }),
    claims: [
      {
        pageTitle: "Snapshot",
        pageKind: "entity",
        pagePath: "entities/snapshot.md",
        text,
      },
    ],
  };
}

type Config = ReturnType<typeof resolveMemoryWikiConfig>;
type CompileDetails = Parameters<typeof appendMemoryWikiLog>[1]["details"];
function recordCompile(root: string, details: CompileDetails) {
  return appendMemoryWikiLog(root, {
    type: "compile",
    timestamp: "2026-07-17T00:00:00.000Z",
    details,
  });
}

function publication(
  compiledCachePublicationId: string,
  compiledCacheParentPublicationId: string | null | undefined,
  compiledCacheReservationId: string,
  compiledCacheSourceGeneration = EMPTY_SOURCE_GENERATION,
) {
  return {
    compiledCachePublicationId,
    compiledCacheParentPublicationId,
    compiledCacheReservationId,
    compiledCacheSourceGeneration,
  };
}

function restartCache(store = createCacheStore()) {
  configureMemoryWikiCompiledCacheStore(undefined);
  configureMemoryWikiCompiledCacheStore(store);
}

function candidate(
  config: Config,
  value: MemoryWikiCompiledCacheSnapshot,
  parentId: string | null,
) {
  const id = randomUUID();
  const reservationId = randomUUID();
  const details = publication(id, parentId, reservationId);
  return {
    reservation: { compiledCacheReservationId: reservationId },
    commit: () => recordCompile(config.vault.path, details),
    write: (commit = async () => {}) =>
      writeMemoryWikiCompiledCache(config, value, id, parentId, commit, () =>
        loadMemoryWikiValidatedVaultIdentity(config.vault.path),
      ),
  };
}

async function preparePrompt(config: Config): Promise<string> {
  return (
    await createWikiPromptSectionPreparer({ config, resolveConfig: () => config })({
      availableTools: new Set(),
    })
  ).join("\n");
}

describe("Memory Wiki compiled cache lifecycle", () => {
  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests();
    configureMemoryWikiCompiledCacheStore(undefined);
    blobStateDir = await createTempDir("memory-wiki-compiled-cache-state-");
    blobStoreEnv = { ...process.env, OPENCLAW_STATE_DIR: blobStateDir };
    configureMemoryWikiCompiledCacheStore(createCacheStore());
  });

  afterEach(async () => {
    configureMemoryWikiCompiledCacheStore(undefined);
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests();
    blobStateDir = "";
    blobStoreEnv = {};
  });

  it("reuses an existing publication when local source sync starts with an inactive owner", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { vaultMode: "isolated", ingest: { autoCompile: true } },
    });
    await fs.writeFile(path.join(rootDir, "sources", "alpha.md"), "# Alpha\n\nLocal source.\n");
    await compileMemoryWikiVault(config);
    const before = await loadMemoryWikiVaultIdentity(rootDir);
    deactivateMemoryWikiCompiledCacheOwnersExcept(new Set());

    const result = await syncMemoryWikiImportedSources({ config });

    expect(result).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      removedCount: 0,
      indexesRefreshed: false,
      indexRefreshReason: "no-import-changes",
    });
    expect((await loadMemoryWikiVaultIdentity(rootDir)).compiledCachePublicationId).toBe(
      before.compiledCachePublicationId,
    );
    await expect(loadMemoryWikiCompiledCache(config)).resolves.not.toBeNull();
  });

  it.each([false, true])(
    "reconciles an external publication before source sync (source changed: %s)",
    async (sourceChanged) => {
      const { rootDir, config } = await createPersistentVault({
        initialize: true,
        config: {
          vaultMode: "bridge",
          bridge: { enabled: true, readMemoryArtifacts: false },
        },
      });
      const sourcePath = path.join(rootDir, "sources", "alpha.md");
      await fs.writeFile(sourcePath, "# Alpha\n\nOriginal source.\n");
      await compileMemoryWikiVault(config);
      const compiled = await loadMemoryWikiCompiledCache(config);
      if (!compiled) {
        throw new Error("Expected the initial compiled snapshot");
      }
      const parent = await loadMemoryWikiVaultIdentity(rootDir);
      if (!parent.compiledCachePublicationId) {
        throw new Error("Expected the initial publication");
      }
      restartCache();
      await activateExistingMemoryWikiVault(config);

      // A separate compiler replaces the durable publication without updating
      // this process's activated owner or warming its snapshot.
      const publicationId = randomUUID();
      const reservationId = randomUUID();
      const externalStore = createCacheStore();
      await externalStore.write(config, compiled, publicationId);
      await recordCompile(rootDir, { compiledCacheReservationId: reservationId });
      await recordCompile(
        rootDir,
        publication(
          publicationId,
          parent.compiledCachePublicationId,
          reservationId,
          parent.compiledCacheSourceGeneration ?? undefined,
        ),
      );
      await externalStore.deletePublication(config, parent.compiledCachePublicationId);
      if (sourceChanged) {
        await fs.writeFile(sourcePath, "# Alpha\n\nChanged source.\n");
      }
      const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
      const before = await fs.readFile(logPath, "utf8");

      const result = await syncMemoryWikiImportedSources({ config });

      expect(result.indexesRefreshed).toBe(sourceChanged);
      expect(result.indexRefreshReason).toBe(
        sourceChanged ? "missing-compiled-cache" : "no-import-changes",
      );
      const after = await fs.readFile(logPath, "utf8");
      if (sourceChanged) {
        expect(after).not.toBe(before);
      } else {
        expect(after).toBe(before);
      }
      await expect(readMemoryWikiDashboardState(config)).resolves.toMatchObject({ state: "ready" });
    },
  );

  it("reuses an active compiled owner during repeated initialization and exact page reads", async () => {
    const { rootDir, config } = await createPersistentVault();
    await fs.writeFile(path.join(rootDir, "sources", "alpha.md"), "# Alpha\n\nRequested source.\n");
    await fs.writeFile(path.join(rootDir, "sources", "unrelated.md"), "# Unrelated\n");
    await compileMemoryWikiVault(config);
    const readdir = vi.spyOn(fs, "readdir");
    try {
      await initializeMemoryWikiVault(config);
      await expect(
        getMemoryWikiPage({ config, lookup: "sources/alpha.md" }),
      ).resolves.toMatchObject({
        path: "sources/alpha.md",
        content: expect.stringContaining("Requested source."),
      });
      expect(readdir).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
    }
  });

  it("round-trips compile through async preparation and claim query after restart", async () => {
    const { rootDir, config, page } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await page(
      "entities/alpha.md",
      {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        claims: [
          {
            id: "claim.alpha.db",
            text: "Alpha uses PostgreSQL for production writes.",
            status: "supported",
            confidence: 0.91,
            evidence: [{ sourceId: "source.alpha", lines: "1-2" }],
          },
        ],
      },
      "# Alpha\n\nDatabase notes.\n",
    );

    await compileMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.toContain(
      "Alpha uses PostgreSQL for production writes.",
    );
    await expect(getMemoryWikiPage({ config, lookup: "claim.alpha.db" })).resolves.toMatchObject({
      path: "entities/alpha.md",
      title: "Alpha",
    });

    restartCache();
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const mutation = withMemoryWikiVaultMutation(rootDir, async () => {
      entered.resolve();
      await released.promise;
    });
    await entered.promise;
    const readFile = vi.spyOn(fs, "readFile");
    const open = vi.spyOn(fs, "open");
    const activation = activateExistingMemoryWikiVault(config);
    try {
      try {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(open).not.toHaveBeenCalled();
      } finally {
        released.resolve();
        await mutation;
        await activation;
        open.mockRestore();
      }
      expect(
        readFile.mock.calls.filter(([file]) => file === path.join(rootDir, "entities", "alpha.md")),
      ).toHaveLength(1);
    } finally {
      readFile.mockRestore();
    }

    await expect(preparePrompt(config)).resolves.toContain(
      "Alpha uses PostgreSQL for production writes.",
    );
    await expect(getMemoryWikiPage({ config, lookup: "claim.alpha.db" })).resolves.toMatchObject({
      path: "entities/alpha.md",
      title: "Alpha",
    });
  });

  it("bounds dashboard projections below the compiled-cache entry limit", () => {
    const oversized = "x".repeat(10_000);
    const importItem: MemoryWikiImportInsightItem = {
      pagePath: "sources/oversized.md",
      title: oversized,
      riskLevel: "low",
      riskReasons: Array(16).fill(oversized),
      labels: Array(16).fill(oversized),
      topicKey: oversized,
      topicLabel: oversized,
      digestStatus: "available",
      activeBranchMessages: 1,
      userMessageCount: 1,
      assistantMessageCount: 1,
      firstUserLine: oversized,
      lastUserLine: oversized,
      assistantOpener: oversized,
      summary: oversized,
      candidateSignals: Array(8).fill(oversized),
      correctionSignals: Array(8).fill(oversized),
      preferenceSignals: Array(16).fill(oversized),
      createdAt: oversized,
      updatedAt: oversized,
    };
    const overviewItem: MemoryWikiOverviewItem = {
      pagePath: "concepts/oversized.md",
      title: oversized,
      kind: "concept",
      id: oversized,
      updatedAt: oversized,
      sourceType: oversized,
      claimCount: 3,
      questionCount: 3,
      contradictionCount: 3,
      claims: Array(6).fill(oversized),
      questions: Array(6).fill(oversized),
      contradictions: Array(6).fill(oversized),
      snippet: oversized,
    };
    const count = MEMORY_WIKI_DASHBOARD_ITEM_LIMIT + 1;
    const dashboards = {
      importInsights: buildMemoryWikiImportInsights(
        Array.from({ length: count }, (_, index) => ({
          ...importItem,
          pagePath: `sources/oversized-${index}.md`,
        })),
      ),
      overview: buildMemoryWikiOverview(
        [],
        Array.from({ length: count }, (_, index) => ({
          ...overviewItem,
          pagePath: `concepts/oversized-${index}.md`,
        })),
      ),
    };

    expect(dashboards.importInsights).toMatchObject({ totalItems: count, truncated: true });
    expect(dashboards.overview).toMatchObject({ totalItems: count, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(dashboards))).toBeLessThan(32 * 1024 * 1024);
  });

  it("ignores legacy files and rebuilds only on compile", async () => {
    const { rootDir, config, page } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    const legacyPath = path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ claimCount: 1, pages: [] }), "utf8");
    await page(
      "entities/fresh.md",
      {
        pageType: "entity",
        id: "entity.fresh",
        title: "Fresh",
        claims: [{ text: "Fresh cache content.", status: "supported" }],
      },
      "# Fresh\n",
    );

    await expect(preparePrompt(config)).resolves.not.toContain("Fresh cache content.");
    await compileMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.toContain("Fresh cache content.");
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toContain("claimCount");
  });

  it("rejects claims newer than a restored vault after lifecycle refresh", async () => {
    const { rootDir, config } = await createPersistentVault();
    await publishSnapshot(config, snapshot("backup"));
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const backupLog = await fs.readFile(logPath, "utf8");
    const newerSnapshot = snapshot("Private post-backup claim.");
    const preRestorePublicationId = await publishSnapshot(config, newerSnapshot);
    await fs.writeFile(logPath, backupLog, "utf8");

    restartCache();
    await activateExistingMemoryWikiVault(config);

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();

    const delayedSnapshot = snapshot("Private delayed pre-restore claim.");
    await createCacheStore().write(config, delayedSnapshot, randomUUID());
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();

    const republished = candidate(config, newerSnapshot, preRestorePublicationId);
    await republished.commit();
    await expect(republished.write()).rejects.toThrow("vault changed");

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await activateExistingMemoryWikiVault(config);
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it("rejects a reserved publication when its identical parent was restored", async () => {
    const { rootDir, config } = await createPersistentVault();
    await publishSnapshot(config, snapshot("backup"));
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const backupLog = await fs.readFile(logPath, "utf8");
    const parentPublicationId = (await loadMemoryWikiVaultIdentity(rootDir))
      .compiledCachePublicationId;
    const reserved = candidate(
      config,
      snapshot("Private content scanned after backup."),
      parentPublicationId,
    );
    await recordCompile(rootDir, {
      ...reserved.reservation,
      compiledCacheParentPublicationId: parentPublicationId,
    });
    await fs.writeFile(logPath, backupLog, "utf8");

    await expect(reserved.write(reserved.commit)).rejects.toThrow("vault changed");
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await activateExistingMemoryWikiVault(config);
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("backup");
  });

  it("keeps a committed publication when an older writer is rejected", async () => {
    const { config } = await createPersistentVault();
    const parentPublicationId = await publishSnapshot(config, snapshot("parent"));
    const stale = candidate(config, snapshot("stale candidate"), parentPublicationId);
    await recordCompile(config.vault.path, stale.reservation);
    const callbackEntered = createDeferred<void>();
    const releaseCallback = createDeferred<void>();
    const staleWrite = stale.write(async () => {
      callbackEntered.resolve();
      await releaseCallback.promise;
      await stale.commit();
    });
    await callbackEntered.promise;
    await publishSnapshot(config, snapshot("accepted successor"));
    releaseCallback.resolve();

    await expect(staleWrite).rejects.toThrow("vault changed");
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("accepted successor");
  });

  it("reports transient SQLite read failures as failed dashboard state", async () => {
    const { config } = await createPersistentVault();
    const errors: unknown[] = [];
    let failNextRead = false;
    const store = createMemoryWikiCompiledCacheStore(
      <T>(options: OpenBlobStoreOptions) => {
        const blobStore = createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv);
        return {
          ...blobStore,
          async lookup(key) {
            if (failNextRead) {
              failNextRead = false;
              throw new Error("transient SQLite failure");
            }
            return await blobStore.lookup(key);
          },
        };
      },
      { onReadError: (error) => errors.push(error) },
    );
    configureMemoryWikiCompiledCacheStore(store);
    await publishSnapshot(config, snapshot("recoverable"));
    restartCache(store);
    await activateExistingMemoryWikiVault(config);
    failNextRead = true;

    await expect(readMemoryWikiDashboardState(config)).resolves.toMatchObject({
      state: "failed",
    });
    expect(errors).toHaveLength(1);
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("recoverable");
  });

  it("keeps a restored owner closed when its durable identity cannot be loaded", async () => {
    const { rootDir, config } = await createPersistentVault();
    await publishSnapshot(config, snapshot("backup"));
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const backupLog = await fs.readFile(logPath, "utf8");
    await publishSnapshot(config, snapshot("Private newer claim."));
    await fs.writeFile(logPath, backupLog, "utf8");

    restartCache();
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("transient journal failure"));
    try {
      await expect(activateExistingMemoryWikiVault(config)).rejects.toThrow(
        "transient journal failure",
      );
    } finally {
      open.mockRestore();
    }

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it("rejects a predecessor snapshot when a vault path is reused", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await publishSnapshot(config, snapshot("Private predecessor content."));
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(rootDir, "WIKI.md"), "# Replacement\n", "utf8"),
      fs.writeFile(
        path.join(rootDir, ".openclaw-wiki", "log.jsonl"),
        `${JSON.stringify({
          type: "vault-generation",
          timestamp: "2026-07-17T00:00:00.000Z",
          details: { vaultGeneration: "replacement-generation" },
        })}\n`,
        "utf8",
      ),
    ]);
    await initializeMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.not.toContain("Private predecessor content.");
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it("deletes cache rows when their agent owner is removed", async () => {
    const rootDir = path.join((await createPersistentVault({})).rootDir, "agents");
    const appConfig = {
      agents: { entries: { support: {}, marketing: {} } },
    };
    const baseConfig = resolveMemoryWikiConfig({ vault: { scope: "agent", path: rootDir } });
    const support = resolveMemoryWikiAgentConfig({
      config: baseConfig,
      appConfig,
      agentId: "support",
    });
    const marketing = resolveMemoryWikiAgentConfig({
      config: baseConfig,
      appConfig,
      agentId: "marketing",
    });
    for (const config of [support, marketing]) {
      await initializeMemoryWikiVault(config);
      await publishSnapshot(config, snapshot(config.agentId ?? "unknown"));
    }
    const store = createCacheStore();
    configureMemoryWikiCompiledCacheStore(store);

    const activeOwners = new Set([resolveMemoryWikiCompiledCacheOwnerId(support)]);
    deactivateMemoryWikiCompiledCacheOwnersExcept(activeOwners);
    await store.deleteOwnersExcept(activeOwners);

    await expect(loadMemoryWikiCompiledCache(marketing)).resolves.toBeNull();
    await expect(loadMemoryWikiCompiledCache(support)).resolves.not.toBeNull();
  });
});
