import assert from "node:assert/strict";
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
let cacheStoreOptions: OpenBlobStoreOptions;

function createCacheStore() {
  return createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) => {
    cacheStoreOptions = options;
    return createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv);
  });
}

async function createPersistentVault(
  options: Parameters<typeof createVault>[0] = { initialize: true },
) {
  const vault = await createVault(options);
  // The shared unit harness installs its in-memory cache store. These lifecycle
  // tests deliberately switch back to the SQLite-backed plugin Blob test store.
  configureMemoryWikiCompiledCacheStore(createCacheStore());
  return vault;
}

async function createBackedUpVault() {
  const vault = await createPersistentVault();
  const parentId = await publishSnapshot(vault.config, snapshot("backup"));
  const logPath = path.join(vault.rootDir, ".openclaw-wiki", "log.jsonl");
  const backupLog = await fs.readFile(logPath, "utf8");
  return { ...vault, parentId, restore: () => fs.writeFile(logPath, backupLog, "utf8") };
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
    claims: [{ pageTitle: "Snapshot", pageKind: "entity", pagePath: "entities/snapshot.md", text }],
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

async function expectClaim(config: Config, text: string) {
  expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe(text);
}

async function createSourceVault(options: Parameters<typeof createPersistentVault>[0] = {}) {
  const vault = await createPersistentVault({ ...options, initialize: true });
  const sourcePath = path.join(vault.rootDir, "sources", "alpha.md");
  await fs.writeFile(sourcePath, "# Alpha\n\nRequested source.\n");
  await compileMemoryWikiVault(vault.config);
  return { ...vault, sourcePath };
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

  it("reuses a publication across active initialization, exact reads and inactive source sync", async () => {
    const { rootDir, config } = await createSourceVault({
      config: { vaultMode: "isolated", ingest: { autoCompile: true } },
    });
    const before = await loadMemoryWikiVaultIdentity(rootDir);
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

  it.each(["warm", "cold", "source", "unprojected-source", "missing", "corrupt", "output"])(
    "retains only valid unchanged publications on explicit compile (%s)",
    async (change) => {
      const { rootDir, config, sourcePath } = await createSourceVault();
      const blobs = createPluginBlobStoreForTests<unknown>(
        "memory-wiki",
        cacheStoreOptions,
        blobStoreEnv,
      );
      const before = await loadMemoryWikiVaultIdentity(rootDir);
      const [row] = await blobs.entries();
      assert(row && before.compiledCachePublicationId);
      const persisted = await blobs.lookup(row.key);
      const compiled = await loadMemoryWikiCompiledCache(config);
      if (change === "cold") {
        restartCache();
      } else if (change === "source") {
        await fs.writeFile(sourcePath, "# Alpha changed\n\nUpdated source.\n");
      } else if (change === "unprojected-source") {
        await fs.appendFile(sourcePath, "\n");
      } else if (change === "missing") {
        await blobs.delete(row.key);
      } else if (change === "corrupt") {
        await blobs.register(row.key, Buffer.from("invalid gzip"), row.metadata);
      } else if (change === "output") {
        await createCacheStore().write(
          config,
          snapshot("outdated output"),
          before.compiledCachePublicationId,
        );
      }

      const result = await compileMemoryWikiVault(config);
      const after = await loadMemoryWikiVaultIdentity(rootDir);
      if (change === "warm" || change === "cold") {
        expect(result.updatedFiles).toEqual([]);
        expect(after.compiledCachePublicationId).toBe(before.compiledCachePublicationId);
        expect(await blobs.entries()).toEqual([row]);
        expect(await blobs.lookup(row.key)).toEqual(persisted);
      } else {
        expect(after.compiledCachePublicationId).not.toBe(before.compiledCachePublicationId);
        expect(await blobs.lookup(row.key)).toBeUndefined();
        if (change === "source") {
          expect(await loadMemoryWikiCompiledCache(config)).not.toEqual(compiled);
        } else {
          expect(await loadMemoryWikiCompiledCache(config)).toEqual(compiled);
        }
      }
      await expect(readMemoryWikiDashboardState(config)).resolves.toMatchObject({ state: "ready" });
    },
  );

  it.each([false, true])(
    "reconciles an external publication before source sync (source changed: %s)",
    async (sourceChanged) => {
      const { rootDir, config, sourcePath } = await createSourceVault({
        config: {
          vaultMode: "bridge",
          bridge: { enabled: true, readMemoryArtifacts: false },
        },
      });
      const compiled = await loadMemoryWikiCompiledCache(config);
      const parent = await loadMemoryWikiVaultIdentity(rootDir);
      assert(compiled && parent.compiledCachePublicationId);
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
      expect((await fs.readFile(logPath, "utf8")) === before).toBe(!sourceChanged);
      await expect(readMemoryWikiDashboardState(config)).resolves.toMatchObject({ state: "ready" });
    },
  );

  it("round-trips compile through async preparation and claim query after restart", async () => {
    const { rootDir, config, page } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    const legacyPath = path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ claimCount: 1, pages: [] }), "utf8");
    await page(
      "entities/alpha.md",
      {
        pageType: "entity",
        id: "entity.alpha",
        title: "Alpha",
        claims: [
          {
            id: "claim.alpha.db",
            text: "Alpha claim.",
            status: "supported",
          },
        ],
      },
      "# Alpha\n\nDatabase notes.\n",
    );

    await expect(preparePrompt(config)).resolves.not.toContain("Alpha claim.");
    await compileMemoryWikiVault(config);
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toContain("claimCount");

    const expectCompiledClaim = async () => {
      await expect(preparePrompt(config)).resolves.toContain("Alpha claim.");
      await expect(getMemoryWikiPage({ config, lookup: "claim.alpha.db" })).resolves.toMatchObject({
        path: "entities/alpha.md",
        title: "Alpha",
      });
    };
    await expectCompiledClaim();

    restartCache();
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const mutation = withMemoryWikiVaultMutation(rootDir, async () => {
      entered.resolve();
      await released.promise;
    });
    await entered.promise;
    const readFile = vi.spyOn(fs, "readFile");
    let activationReads: number;
    const open = vi.spyOn(fs, "open");
    const activation = activateExistingMemoryWikiVault(config);
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(open).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await mutation;
      await activation;
      activationReads = readFile.mock.calls.filter(
        ([file]) => file === path.join(rootDir, "entities", "alpha.md"),
      ).length;
      open.mockRestore();
      readFile.mockRestore();
    }
    expect(activationReads).toBe(1);
    await expectCompiledClaim();
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

  it("rejects claims newer than a restored vault after lifecycle refresh", async () => {
    const { config, restore } = await createBackedUpVault();
    const newerSnapshot = snapshot("Private post-backup claim.");
    const preRestorePublicationId = await publishSnapshot(config, newerSnapshot);
    await restore();

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
    const { rootDir, config, parentId, restore } = await createBackedUpVault();
    const reserved = candidate(config, snapshot("Private content scanned after backup."), parentId);
    await recordCompile(rootDir, {
      ...reserved.reservation,
      compiledCacheParentPublicationId: parentId,
    });
    await restore();

    await expect(reserved.write(reserved.commit)).rejects.toThrow("vault changed");
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    await activateExistingMemoryWikiVault(config);
    await expectClaim(config, "backup");
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
    await expectClaim(config, "accepted successor");
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
    await expectClaim(config, "recoverable");
  });

  it("keeps a restored owner closed when its durable identity cannot be loaded", async () => {
    const { config, restore } = await createBackedUpVault();
    await publishSnapshot(config, snapshot("Private newer claim."));
    await restore();

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
    await fs.writeFile(path.join(rootDir, "WIKI.md"), "# Replacement\n", "utf8");
    await appendMemoryWikiLog(rootDir, {
      type: "vault-generation",
      timestamp: "2026-07-17T00:00:00.000Z",
      details: { vaultGeneration: "replacement-generation" },
    });
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
    const forAgent = (agentId: string) =>
      resolveMemoryWikiAgentConfig({ config: baseConfig, appConfig, agentId });
    const support = forAgent("support");
    const marketing = forAgent("marketing");
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
