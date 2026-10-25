import fs from "node:fs/promises";
import path from "node:path";
import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
  OpenBlobStoreOptions,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginBlobKernelStore,
  resetPluginBlobStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  deactivateMemoryWikiCompiledCacheOwnersExcept,
  loadMemoryWikiCompiledCache,
  readMemoryWikiDashboardState,
} from "./compiled-cache.js";
import { loadMemoryWikiVaultIdentity } from "./log.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { activateExistingMemoryWikiVault } from "./vault.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
let env: NodeJS.ProcessEnv;
let entries: () => Promise<PluginBlobEntryInfo<unknown>[]>;
let lookup: (key: string) => Promise<PluginBlobEntry<unknown> | undefined>;
let deleteRow: (key: string) => Promise<boolean>;
let corruptRow: (key: string) => Promise<void>;
let onNextLookup: (() => Promise<void>) | undefined;
let readErrors: unknown[] = [];

function configureStore() {
  configureMemoryWikiCompiledCacheStore(
    createMemoryWikiCompiledCacheStore(
      <T>(options: OpenBlobStoreOptions) => {
        const store = createPluginBlobKernelStore<T>("memory-wiki", { ...options, env });
        entries = () => store.entries();
        lookup = (key) => store.lookup(key);
        deleteRow = (key) => store.delete(key);
        corruptRow = async (key) => {
          const entry = await store.lookup(key);
          if (!entry) {
            throw new Error("Expected persisted publication");
          }
          await store.register(key, Buffer.from("corrupt gzip"), entry.metadata);
        };
        return {
          ...store,
          async lookup(key) {
            const entry = await store.lookup(key);
            const action = onNextLookup;
            onNextLookup = undefined;
            await action?.();
            return entry;
          },
        };
      },
      { onReadError: (error) => readErrors.push(error) },
    ),
  );
}

async function publishedVault() {
  const vault = await createVault({ initialize: true });
  configureStore();
  const page = path.join(vault.rootDir, "entities", "alpha.md");
  await fs.writeFile(
    page,
    renderWikiMarkdown({
      frontmatter: { pageType: "entity", id: "alpha", title: "Alpha" },
      body: "# Alpha\n\nOriginal overview.\n",
    }),
  );
  await compileMemoryWikiVault(vault.config);
  const identity = await loadMemoryWikiVaultIdentity(vault.rootDir);
  const [row] = await entries();
  if (!identity.compiledCachePublicationId || !row) {
    throw new Error("Expected first durable publication");
  }
  return { ...vault, page, identity, row };
}

beforeEach(async () => {
  onNextLookup = undefined;
  readErrors = [];
  await closeOpenClawStateDatabaseAsync();
  resetPluginBlobStoreForTests({ closeDatabase: false });
  configureMemoryWikiCompiledCacheStore(undefined);
  env = { ...process.env, OPENCLAW_STATE_DIR: await createTempDir("wiki-publication-state-") };
});
afterEach(async () => {
  configureMemoryWikiCompiledCacheStore(undefined);
  await closeOpenClawStateDatabaseAsync();
  resetPluginBlobStoreForTests({ closeDatabase: false });
});

describe("explicit compile publication reuse", () => {
  it.each([false, true])(
    "retains the durable publication and row across an identical compile (cold owner: %s)",
    async (cold) => {
      const { rootDir, config, identity, row } = await publishedVault();
      const persisted = await lookup(row.key);
      expect(persisted).toBeDefined();
      await loadMemoryWikiCompiledCache(config);
      if (cold) {
        deactivateMemoryWikiCompiledCacheOwnersExcept(new Set());
      }
      const result = await compileMemoryWikiVault(config);
      expect(result.updatedFiles).toEqual([]);
      expect((await loadMemoryWikiVaultIdentity(rootDir)).compiledCachePublicationId).toBe(
        identity.compiledCachePublicationId,
      );
      expect(await entries()).toEqual([row]);
      expect(await lookup(row.key)).toEqual(persisted);
      expect(await readMemoryWikiDashboardState(config)).toMatchObject({ state: "ready" });
    },
  );

  it.each(["missing", "corrupt", "changed"] as const)(
    "rebuilds a %s publication even with a warm owner",
    async (change) => {
      const { rootDir, config, identity, row, page } = await publishedVault();
      await loadMemoryWikiCompiledCache(config);
      if (change === "missing") {
        await deleteRow(row.key);
      } else if (change === "corrupt") {
        await corruptRow(row.key);
      } else {
        await fs.writeFile(
          page,
          renderWikiMarkdown({
            frontmatter: { pageType: "entity", id: "alpha", title: "Alpha revised" },
            body: "# Alpha revised\n\nChanged overview.\n",
          }),
        );
      }
      await compileMemoryWikiVault(config);
      expect((await loadMemoryWikiVaultIdentity(rootDir)).compiledCachePublicationId).not.toBe(
        identity.compiledCachePublicationId,
      );
      expect(await lookup(row.key)).toBeUndefined();
      expect(await readMemoryWikiDashboardState(config)).toMatchObject({ state: "ready" });
    },
  );

  it("republishes unchanged output when its recorded source identity is no longer valid", async () => {
    const { rootDir, config, identity, page } = await publishedVault();
    const original = await loadMemoryWikiCompiledCache(config);
    await fs.appendFile(page, "\n");
    await compileMemoryWikiVault(config, { sourcePageWrites: "preserve" });
    const current = await loadMemoryWikiVaultIdentity(rootDir);
    expect(await loadMemoryWikiCompiledCache(config)).toEqual(original);
    expect(current.compiledCacheSourceGeneration).not.toBe(identity.compiledCacheSourceGeneration);
    expect(current.compiledCachePublicationId).not.toBe(identity.compiledCachePublicationId);
  });

  it("cancels reuse after a persisted read without replacing its accepted row", async () => {
    const { rootDir, config, identity, row } = await publishedVault();
    const persisted = await lookup(row.key);
    const controller = new AbortController();
    onNextLookup = async () => controller.abort(new Error("synthetic cancelled compile"));
    await expect(compileMemoryWikiVault(config, { signal: controller.signal })).rejects.toThrow(
      "synthetic cancelled compile",
    );
    expect((await loadMemoryWikiVaultIdentity(rootDir)).compiledCachePublicationId).toBe(
      identity.compiledCachePublicationId,
    );
    expect(await entries()).toEqual([row]);
    expect(await lookup(row.key)).toEqual(persisted);
  });

  it("reports a persisted read error through the configured observer", async () => {
    const { config } = await publishedVault();
    deactivateMemoryWikiCompiledCacheOwnersExcept(new Set());
    await activateExistingMemoryWikiVault(config);
    const error = new Error("Synthetic storage read failure");
    onNextLookup = async () => {
      throw error;
    };
    await expect(loadMemoryWikiCompiledCache(config)).rejects.toBe(error);
    expect(readErrors).toEqual([error]);
  });
});
