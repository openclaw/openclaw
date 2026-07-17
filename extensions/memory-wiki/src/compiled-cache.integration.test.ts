// Memory Wiki compiled cache tests cover compile, prepare, query, restart, and owner cleanup.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { OpenBlobStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import {
  activateMemoryWikiCompiledCacheOwner,
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  deactivateMemoryWikiCompiledCacheOwnersExcept,
  loadMemoryWikiCompiledCache,
  resetMemoryWikiCompiledCacheOwnersForTests,
  resolveMemoryWikiCompiledCacheOwnerId,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
} from "./compiled-cache.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import { loadMemoryWikiVaultGeneration } from "./log.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createWikiPromptSectionPreparer } from "./prompt-section.js";
import { getMemoryWikiPage } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { initializeMemoryWikiVault } from "./vault.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
let blobStateDir = "";
let blobStoreEnv: NodeJS.ProcessEnv = {};

function createCacheStore() {
  return createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) =>
    createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv),
  );
}

async function createPersistentVault(
  options?: Parameters<typeof createVault>[0],
): Promise<Awaited<ReturnType<typeof createVault>>> {
  const vault = await createVault(options);
  // The shared unit harness installs its in-memory cache store. These lifecycle
  // tests deliberately switch back to the SQLite-backed plugin Blob test store.
  configureMemoryWikiCompiledCacheStore(createCacheStore());
  return vault;
}

async function activateVault(config: ReturnType<typeof resolveMemoryWikiConfig>): Promise<void> {
  const generation = await loadMemoryWikiVaultGeneration(config.vault.path);
  if (!generation) {
    throw new Error(`Expected vault generation for ${config.vault.path}`);
  }
  activateMemoryWikiCompiledCacheOwner(config, generation);
}

function snapshot(text: string): MemoryWikiCompiledCacheSnapshot {
  return {
    digest: {
      claimCount: 1,
      contradictionCount: 0,
      pages: [
        {
          title: "Snapshot",
          kind: "entity",
          path: "entities/snapshot.md",
          aliases: [],
          sourceIds: [],
          questions: [],
          contradictions: [],
          bestUsedFor: [],
          notEnoughFor: [],
          relationshipCount: 0,
          topRelationships: [],
          claimCount: 1,
          topClaims: [{ text, status: "supported", freshnessLevel: "fresh" }],
        },
      ],
    },
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

async function preparePrompt(config: ReturnType<typeof resolveMemoryWikiConfig>): Promise<string> {
  return (
    await createWikiPromptSectionPreparer({ config, resolveConfig: () => config })({
      availableTools: new Set(),
    })
  ).join("\n");
}

describe("Memory Wiki compiled cache lifecycle", () => {
  beforeEach(async () => {
    resetPluginBlobStoreForTests();
    resetMemoryWikiCompiledCacheOwnersForTests();
    blobStateDir = await createTempDir("memory-wiki-compiled-cache-state-");
    blobStoreEnv = { ...process.env, OPENCLAW_STATE_DIR: blobStateDir };
    configureMemoryWikiCompiledCacheStore(createCacheStore());
  });

  afterEach(async () => {
    configureMemoryWikiCompiledCacheStore(undefined);
    resetMemoryWikiCompiledCacheOwnersForTests();
    resetPluginBlobStoreForTests();
    blobStateDir = "";
    blobStoreEnv = {};
  });

  it("round-trips compile through async preparation and claim query after restart", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: {
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
        body: "# Alpha\n\nDatabase notes.\n",
      }),
      "utf8",
    );

    await compileMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.toContain(
      "Alpha uses PostgreSQL for production writes.",
    );
    await expect(getMemoryWikiPage({ config, lookup: "claim.alpha.db" })).resolves.toMatchObject({
      path: "entities/alpha.md",
      title: "Alpha",
    });

    configureMemoryWikiCompiledCacheStore(undefined);
    resetMemoryWikiCompiledCacheOwnersForTests();
    configureMemoryWikiCompiledCacheStore(createCacheStore());
    await activateVault(config);

    await expect(preparePrompt(config)).resolves.toContain(
      "Alpha uses PostgreSQL for production writes.",
    );
  });

  it("ignores legacy files and rebuilds only on compile", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    const legacyPath = path.join(rootDir, ".openclaw-wiki", "cache", "agent-digest.json");
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, JSON.stringify({ claimCount: 1, pages: [] }), "utf8");
    await fs.writeFile(
      path.join(rootDir, "entities", "fresh.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "entity",
          id: "entity.fresh",
          title: "Fresh",
          claims: [{ text: "Fresh cache content.", status: "supported" }],
        },
        body: "# Fresh\n",
      }),
      "utf8",
    );

    await expect(preparePrompt(config)).resolves.not.toContain("Fresh cache content.");
    await compileMemoryWikiVault(config);

    await expect(preparePrompt(config)).resolves.toContain("Fresh cache content.");
    await expect(fs.readFile(legacyPath, "utf8")).resolves.toContain("claimCount");
  });

  it("persists snapshots beyond the keyed-state value limit", async () => {
    const { config } = await createPersistentVault({ initialize: true });
    const text = Array.from({ length: 4096 }, (_, index) =>
      createHash("sha256").update(String(index)).digest("hex"),
    ).join("");
    expect(gzipSync(text).byteLength).toBeGreaterThan(65_536);
    await writeMemoryWikiCompiledCache(config, snapshot(text));

    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiCompiledCacheStore(createCacheStore());

    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe(text);
  });

  it("loads an externally compiled generation on the next async preparation", async () => {
    const { config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await writeMemoryWikiCompiledCache(config, snapshot("before"));
    await expect(preparePrompt(config)).resolves.toContain("before");

    await createCacheStore().write(config, snapshot("after"));

    await expect(preparePrompt(config)).resolves.toContain("after");
  });

  it("reads the stable owner row directly without enumerating stale metadata", async () => {
    const { config } = await createPersistentVault({ initialize: true });
    const reader = createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) => {
      const store = createPluginBlobStoreForTests<T>("memory-wiki", options, blobStoreEnv);
      return {
        ...store,
        async entries() {
          throw new Error("read must not enumerate owner rows");
        },
      };
    });
    configureMemoryWikiCompiledCacheStore(reader);
    await writeMemoryWikiCompiledCache(config, snapshot("authoritative"));

    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("authoritative");
  });

  it("preserves vault identity across atomic edits to user-managed scaffold files", async () => {
    const { rootDir, config } = await createPersistentVault({ initialize: true });
    await writeMemoryWikiCompiledCache(config, snapshot("still current"));
    const replacement = path.join(rootDir, "WIKI.md.replacement");
    await fs.writeFile(replacement, "# Edited wiki\n", "utf8");
    await fs.rename(replacement, path.join(rootDir, "WIKI.md"));

    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("still current");
  });

  it("rejects a predecessor generation after an in-place vault restore", async () => {
    const { rootDir, config } = await createPersistentVault({ initialize: true });
    await writeMemoryWikiCompiledCache(config, snapshot("predecessor"));
    await fs.writeFile(
      path.join(rootDir, ".openclaw-wiki", "log.jsonl"),
      `${JSON.stringify({
        type: "vault-generation",
        timestamp: "2026-07-17T00:00:00.000Z",
        details: { vaultGeneration: "restored-vault" },
      })}\n`,
      "utf8",
    );

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it("revalidates vault identity while loading a prepared snapshot", async () => {
    const { config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await writeMemoryWikiCompiledCache(config, snapshot("prepared"));
    const stat = vi.spyOn(fs, "stat");
    const readFile = vi.spyOn(fs, "readFile");

    await expect(preparePrompt(config)).resolves.toContain("prepared");
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith(
      path.join(config.vault.path, ".openclaw-wiki", "log.jsonl"),
      "utf8",
    );
  });

  it("treats transient SQLite read failures as a recoverable cache miss", async () => {
    const { config } = await createPersistentVault({ initialize: true });
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
    await writeMemoryWikiCompiledCache(config, snapshot("recoverable"));
    failNextRead = true;

    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    expect(errors).toHaveLength(1);
    expect((await loadMemoryWikiCompiledCache(config))?.claims[0]?.text).toBe("recoverable");
  });

  it("rejects a predecessor snapshot when a vault path is reused", async () => {
    const { rootDir, config } = await createPersistentVault({
      initialize: true,
      config: { context: { includeCompiledDigestPrompt: true } },
    });
    await writeMemoryWikiCompiledCache(config, snapshot("Private predecessor content."));
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

  it("atomically replaces one stable owner row when the configured vault moves", async () => {
    const { config: firstConfig } = await createPersistentVault({ initialize: true });
    const { config: secondConfig } = await createPersistentVault({ initialize: true });
    const store = createCacheStore();
    configureMemoryWikiCompiledCacheStore(store);

    await activateVault(firstConfig);
    await writeMemoryWikiCompiledCache(firstConfig, snapshot("first"));
    await activateVault(secondConfig);
    await writeMemoryWikiCompiledCache(secondConfig, snapshot("second"));

    await expect(loadMemoryWikiCompiledCache(firstConfig)).resolves.toBeNull();
    expect((await loadMemoryWikiCompiledCache(secondConfig))?.claims[0]?.text).toBe("second");
  });

  it("deletes cache rows when their agent owner is removed", async () => {
    const rootDir = path.join((await createPersistentVault()).rootDir, "agents");
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
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
      await writeMemoryWikiCompiledCache(config, snapshot(config.agentId ?? "unknown"));
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
