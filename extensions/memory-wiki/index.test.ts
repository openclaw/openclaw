import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import type { OpenBlobStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { loadMemoryWikiCompiledCache, writeMemoryWikiCompiledCache } from "./src/compiled-cache.js";
import { deferred } from "./src/deferred.test-helpers.js";
import { loadMemoryWikiValidatedVaultIdentity, loadMemoryWikiVaultIdentity } from "./src/log.js";
import { withMemoryWikiVaultMutation } from "./src/mutation-coordinator.js";
import { closeMemoryWikiQueryReader } from "./src/query-reader.js";
import { getMemoryWikiPage } from "./src/query.js";
import { waitForMemoryWikiImportedSourceSyncs } from "./src/source-sync.js";
import {
  createCompiledSnapshot as emptyCompiledSnapshot,
  createMemoryWikiTestHarness,
  publishCompiledSnapshot,
} from "./src/test-helpers.js";

const toolMocks = vi.hoisted(() => {
  const createTool = (name: string) =>
    vi.fn((config: unknown, _appConfig?: unknown, memoryContext?: unknown) => ({
      name,
      testConfig: config,
      testMemoryContext: memoryContext,
    }));
  return {
    createWikiApplyTool: createTool("wiki_apply"),
    createWikiGetTool: createTool("wiki_get"),
    createWikiLintTool: createTool("wiki_lint"),
    createWikiSearchTool: createTool("wiki_search"),
    createWikiStatusTool: createTool("wiki_status"),
  };
});

vi.mock("./src/tool.js", () => toolMocks);

const { createPluginApi, createTempDir, createVault } = createMemoryWikiTestHarness();

async function serviceFixture(initialize = false) {
  const vault = await createVault();
  if (initialize) {
    await vault.write(".openclaw-wiki/log.jsonl", "");
  }
  const registration = createPluginApi();
  registration.api.pluginConfig = { vault: { path: vault.rootDir } };
  // Some tests intercept the store before registering the plugin.
  const register = async () => {
    plugin.register(registration.api);
    const service = registration.registerService.mock.calls[0]?.[0];
    await service?.start?.();
    return service;
  };
  return { ...vault, ...registration, register };
}

describe("memory-wiki plugin", () => {
  it("resolves every tool factory from keyed agent entries", async () => {
    const rootDir = await createTempDir("memory-wiki-index-agents-");
    const appConfig = {
      agents: { entries: { support: {}, marketing: {} } },
    };
    const { api, registerTool } = createPluginApi();
    api.config = appConfig;
    api.pluginConfig = { vault: { scope: "agent", path: rootDir } };
    Object.assign(api.runtime, { config: { current: () => appConfig } });

    plugin.register(api);

    for (const [registered] of registerTool.mock.calls) {
      const factory = typeof registered === "function" ? registered : registered.create;
      expect(factory({})).toBeNull();
      for (const agentId of ["support", "marketing"]) {
        const tool = factory({ agentId });
        expect(tool).toMatchObject({
          testConfig: { agentId, vault: { scope: "agent", path: path.join(rootDir, agentId) } },
          testMemoryContext: { agentId },
        });
      }
      expect(() => factory({ agentId: "finance" })).toThrow("Unknown memory-wiki agentId: finance");
    }
  });

  it("forwards protected recall authorization to wiki search and get", () => {
    const { api, registerTool } = createPluginApi();
    const stateDir = "/tmp/openclaw-memory-wiki-runtime-state";
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => plugin.register(api));
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:direct:owner",
      scope: "same-agent-private",
      corpus: "sessions",
    } as const;
    const sessionKey = "agent:main:telegram:direct:owner:active-memory:abcdef123456";
    const authority = { kind: "session", sessionKey, conversationRecall };

    for (const toolName of ["wiki_search", "wiki_get"]) {
      const registration = registerTool.mock.calls.find((call) => call[1]?.name === toolName);
      const registered = registration?.[0];
      const factory = typeof registered === "function" ? registered : registered?.create;
      expect(
        factory?.({
          agentId: "main",
          sessionKey,
          sandboxed: false,
          conversationRecall,
          assertInvocationCurrent: () => {},
        }),
      ).toMatchObject({
        testConfig: { vault: { path: path.join(stateDir, "wiki", "main") } },
        testMemoryContext: {
          agentId: "main",
          agentSessionKey: sessionKey,
          sandboxed: false,
          conversationRecall,
          memoryContext: { authority },
        },
      });
    }
  });

  it("terminates the query reader workers on service stop and starts fresh ones for later reads", async () => {
    const { config, page, register } = await serviceFixture();
    const service = await register();
    for (const name of ["alpha", "beta"]) {
      await page(`sources/${name}.md`, { pageType: "source", id: `source.${name}`, title: name });
    }
    // An id lookup reads the whole vault, which runs on the reader's workers.
    const lookup = () => getMemoryWikiPage({ config, lookup: "source.alpha" });
    // Start without reader workers, so every worker counted below belongs to this test.
    await closeMemoryWikiQueryReader();
    const workers: Worker[] = [];
    const exited = new Set<Worker>();
    const onWorker = (worker: Worker) => {
      workers.push(worker);
      worker.once("exit", () => exited.add(worker));
    };
    process.on("worker", onWorker);
    try {
      await expect(lookup()).resolves.toMatchObject({ path: "sources/alpha.md" });
      const beforeStop = workers.length;
      expect(beforeStop).toBeGreaterThan(0);
      // Idle workers stay alive until they are retired or the reader closes.
      expect(exited.size).toBe(0);

      await service?.stop?.();

      expect(exited.size).toBe(beforeStop);
      await expect(lookup()).resolves.toMatchObject({ path: "sources/alpha.md" });
      expect(workers.length).toBeGreaterThan(beforeStop);
    } finally {
      process.off("worker", onWorker);
      await service?.stop?.();
    }
  });

  it("fences cache publication when the plugin service stops", async () => {
    const { api, rootDir, config, register } = await serviceFixture(true);
    const registrationEntered = deferred();
    const releaseRegistration = deferred();
    const openBlobStore = api.runtime.state.openBlobStore;
    api.runtime.state.openBlobStore = <T>(options: OpenBlobStoreOptions) => {
      const store = openBlobStore<T>(options);
      const registerBlob = store.register.bind(store);
      store.register = async (...args) => {
        await registerBlob(...args);
        registrationEntered.resolve();
        await releaseRegistration.promise;
      };
      return store;
    };
    const service = await register();
    const identity = await loadMemoryWikiVaultIdentity(rootDir);
    if (!identity.vaultGeneration) {
      throw new Error("Expected an active Memory Wiki vault generation");
    }
    const snapshot = emptyCompiledSnapshot();
    const commitPublication = vi.fn();
    const publicationId = randomUUID();
    const publication = writeMemoryWikiCompiledCache(
      config,
      snapshot,
      publicationId,
      null,
      commitPublication,
      async () => ({
        vaultGeneration: identity.vaultGeneration,
        compiledCachePublicationId: publicationId,
      }),
    );
    await registrationEntered.promise;

    await service?.stop?.();
    releaseRegistration.resolve();

    await expect(publication).rejects.toThrow("cache owner retired before publication");
    expect(commitPublication).not.toHaveBeenCalled();
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it.each(["wiki.importInsights", "wiki.compile"])(
    "closes queued %s source sync before it can activate a vault",
    async (method) => {
      const { rootDir, config, registerGatewayMethod, register } = await serviceFixture();
      const service = await register();

      const mutationEntered = deferred();
      const releaseMutation = deferred();
      const mutation = withMemoryWikiVaultMutation(rootDir, async () => {
        mutationEntered.resolve();
        await releaseMutation.promise;
      });
      await mutationEntered.promise;
      const handler = registerGatewayMethod.mock.calls.find(([name]) => name === method)?.[1];
      if (!handler) {
        throw new Error(`Expected ${method} gateway handler`);
      }
      const request = handler({ params: {}, respond: vi.fn() });
      await vi.waitFor(async () => {
        const drainState = await Promise.race([
          waitForMemoryWikiImportedSourceSyncs().then(() => "settled" as const),
          new Promise<"pending">((resolve) => {
            setImmediate(() => resolve("pending"));
          }),
        ]);
        expect(drainState).toBe("pending");
      });

      const stop = service?.stop?.();
      releaseMutation.resolve();
      await mutation;
      await request;
      await stop;

      const snapshot = emptyCompiledSnapshot();
      await expect(
        writeMemoryWikiCompiledCache(
          config,
          snapshot,
          randomUUID(),
          null,
          async () => {},
          () => loadMemoryWikiValidatedVaultIdentity(rootDir),
        ),
      ).rejects.toThrow("vault is not active");
      await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    },
  );

  it("clears active owners before a fallible lifecycle identity refresh", async () => {
    const { config, register } = await serviceFixture(true);
    const service = await register();

    const snapshot = emptyCompiledSnapshot();
    await publishCompiledSnapshot(config, snapshot);
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toEqual(snapshot);

    vi.spyOn(fs, "open").mockRejectedValueOnce(new Error("transient restore read failure"));
    await expect(service?.start?.()).rejects.toThrow("transient restore read failure");
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });
});
