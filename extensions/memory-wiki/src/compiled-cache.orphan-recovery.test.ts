import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenBlobStoreOptions,
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobKernelStore,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  loadMemoryWikiCompiledCache,
  resolveMemoryWikiCompiledCacheGeneration,
} from "./compiled-cache.js";
import { loadMemoryWikiVaultIdentity } from "./log.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { activateExistingMemoryWikiVault } from "./vault.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
let env: NodeJS.ProcessEnv;
let abortAfterRegistration: AbortController | undefined;
let entries: () => Promise<PluginBlobEntryInfo<unknown>[]>;
let lookup: (key: string) => Promise<PluginBlobEntry<unknown> | undefined>;

function configureStore() {
  const cacheStore = createMemoryWikiCompiledCacheStore(<T>(options: OpenBlobStoreOptions) => {
    const blobs = createPluginBlobKernelStore<T>("memory-wiki", { ...options, env });
    entries = () => blobs.entries();
    lookup = (key) => blobs.lookup(key);
    const store: PluginBlobStore<T> = {
      ...blobs,
      async register(key, bytes, metadata) {
        const entry = await blobs.register(key, bytes, metadata);
        abortAfterRegistration?.abort(new Error("synthetic interrupted compile"));
        return entry;
      },
    };
    return store;
  });
  configureMemoryWikiCompiledCacheStore(cacheStore);
  return cacheStore;
}

it("reclaims an abandoned persisted candidate after a successful cold compile", async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginBlobStoreForTests({ closeDatabase: false });
  configureMemoryWikiCompiledCacheStore(undefined);
  try {
    const stateDir = await createTempDir("wiki-orphan-state-");
    const { rootDir, config } = await createVault({
      initialize: true,
      config: {
        vaultMode: "isolated",
        obsidian: { enabled: false },
        bridge: { enabled: false },
      },
    });
    env = { OPENCLAW_STATE_DIR: stateDir };
    const cacheStore = configureStore();
    await fs.writeFile(
      path.join(rootDir, "entities", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "entity", id: "alpha", title: "Alpha" },
        body: "# Alpha\n\nA synthetic recovery fixture.\n",
      }),
    );
    await compileMemoryWikiVault(config);
    const acceptedBefore = await loadMemoryWikiVaultIdentity(rootDir);
    expect(acceptedBefore.compiledCachePublicationId).toBeTruthy();
    const initialEntries = await entries();
    expect(initialEntries).toHaveLength(1);
    const snapshot = await loadMemoryWikiCompiledCache(config);
    if (!snapshot) {
      throw new Error("Expected the first compiler publication to be readable");
    }
    const logPath = path.join(rootDir, ".openclaw-wiki", "log.jsonl");
    const acceptedJournal = await fs.readFile(logPath, "utf8");

    // Seed the durable state left by an interrupted writer through its real store.
    // This does not execute SIGKILL or claim process-crash coverage.
    await cacheStore.write(
      config,
      snapshot,
      resolveMemoryWikiCompiledCacheGeneration(snapshot),
      "orphan-B",
    );
    const withOrphan = await entries();
    expect(withOrphan).toHaveLength(2);
    const orphan = withOrphan.find(
      (entry) => !initialEntries.some((initial) => initial.key === entry.key),
    );
    if (!orphan) {
      throw new Error("Expected a separately persisted candidate");
    }
    expect(await fs.readFile(logPath, "utf8")).toBe(acceptedJournal);
    expect((await loadMemoryWikiVaultIdentity(rootDir)).compiledCachePublicationId).toBe(
      acceptedBefore.compiledCachePublicationId,
    );

    // Recovery must publish changed input, independently of unchanged-compile reuse.
    await fs.appendFile(
      path.join(rootDir, "entities", "alpha.md"),
      "\nA changed source awaiting successful publication.\n",
    );

    // A failed compiler must retire only its own candidate, retaining the
    // accepted publication and the abandoned row until a successor commits.
    abortAfterRegistration = new AbortController();
    try {
      await expect(
        compileMemoryWikiVault(config, { signal: abortAfterRegistration.signal }),
      ).rejects.toThrow("synthetic interrupted compile");
    } finally {
      abortAfterRegistration = undefined;
    }
    expect((await entries()).map((entry) => entry.key).toSorted()).toEqual(
      withOrphan.map((entry) => entry.key).toSorted(),
    );
    await expect(lookup(orphan.key)).resolves.toBeDefined();
    expect((await loadMemoryWikiVaultIdentity(rootDir)).compiledCachePublicationId).toBe(
      acceptedBefore.compiledCachePublicationId,
    );
    expect((await loadMemoryWikiCompiledCache(config))?.digest.pages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "alpha", title: "Alpha" })]),
    );

    configureMemoryWikiCompiledCacheStore(undefined);
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests({ closeDatabase: false });
    configureStore();
    await compileMemoryWikiVault(config);
    const acceptedAfter = await loadMemoryWikiVaultIdentity(rootDir);
    expect(acceptedAfter.compiledCachePublicationId).toBeTruthy();
    expect(acceptedAfter.compiledCachePublicationId).not.toBe("orphan-B");
    expect(acceptedAfter.compiledCachePublicationId).not.toBe(
      acceptedBefore.compiledCachePublicationId,
    );

    configureMemoryWikiCompiledCacheStore(undefined);
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests({ closeDatabase: false });
    configureStore();
    await activateExistingMemoryWikiVault(config);
    const recovered = await loadMemoryWikiCompiledCache(config);
    expect(recovered?.digest.pages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "alpha", title: "Alpha" })]),
    );
    await expect(lookup(orphan.key)).resolves.toBeUndefined();
  } finally {
    abortAfterRegistration = undefined;
    configureMemoryWikiCompiledCacheStore(undefined);
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests({ closeDatabase: false });
  }
});
