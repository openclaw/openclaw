// Memory Wiki tests cover index plugin behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "./api.js";
import plugin from "./index.js";
import {
  loadMemoryWikiCompiledCache,
  resolveMemoryWikiCompiledCacheGeneration,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
} from "./src/compiled-cache.js";
import { resolveMemoryWikiConfig } from "./src/config.js";
import { deferred } from "./src/deferred.test-helpers.js";
import {
  appendMemoryWikiLog,
  loadMemoryWikiValidatedVaultIdentity,
  loadMemoryWikiVaultIdentity,
  resolveMemoryWikiVaultSourceGeneration,
} from "./src/log.js";
import { renderWikiMarkdown } from "./src/markdown.js";
import { withMemoryWikiVaultMutation } from "./src/mutation-coordinator.js";
import * as queryReader from "./src/query-reader.js";
import { waitForMemoryWikiImportedSourceSyncs } from "./src/source-sync.js";
import { createMemoryWikiTestHarness } from "./src/test-helpers.js";

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

const { createPluginApi, createTempDir } = createMemoryWikiTestHarness();

function emptyCompiledSnapshot(): MemoryWikiCompiledCacheSnapshot {
  return {
    digest: { claimCount: 0, contradictionCount: 0, pages: [] },
    claims: [],
    dashboards: {
      importInsights: {
        sourceType: "chatgpt",
        totalItems: 0,
        totalClusters: 0,
        clusters: [],
        truncated: false,
      },
      overview: {
        totalItems: 0,
        totalPages: 0,
        pageCounts: { synthesis: 0, entity: 0, concept: 0, source: 0, report: 0 },
        totalClaims: 0,
        totalQuestions: 0,
        totalContradictions: 0,
        clusters: [],
        truncated: false,
      },
    },
  };
}

describe("memory-wiki plugin", () => {
  it("registers prompt supplement, gateway methods, tools, and wiki cli surface", () => {
    const {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptPreparation,
      registerMemoryPromptSupplement,
      registerService,
      registerTool,
    } = createPluginApi();

    plugin.register(api);

    expect(registerMemoryCorpusSupplement).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptPreparation).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptSupplement).toHaveBeenCalledTimes(1);
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "memory-wiki-compiled-cache-owner-cleanup" }),
    );
    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "wiki.status",
      "wiki.importRuns",
      "wiki.importInsights",
      "wiki.overview",
      "wiki.init",
      "wiki.doctor",
      "wiki.compile",
      "wiki.ingest",
      "wiki.lint",
      "wiki.bridge.import",
      "wiki.unsafeLocal.import",
      "wiki.search",
      "wiki.apply",
      "wiki.get",
      "wiki.obsidian.status",
      "wiki.obsidian.search",
      "wiki.obsidian.open",
      "wiki.obsidian.command",
      "wiki.obsidian.daily",
    ]);
    expect(registerTool).toHaveBeenCalledTimes(5);
    expect(registerTool.mock.calls.map((call) => call[1]?.name)).toEqual([
      "wiki_status",
      "wiki_lint",
      "wiki_apply",
      "wiki_search",
      "wiki_get",
    ]);
    for (const [registration] of registerTool.mock.calls) {
      expect(registration).toMatchObject({ contextVersion: 2, create: expect.any(Function) });
    }
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toStrictEqual({
      descriptors: [
        {
          name: "wiki",
          description: "Inspect and initialize the memory wiki vault",
          hasSubcommands: true,
        },
      ],
    });
  });

  it("registers default-vault tools inside the configured state directory", () => {
    const stateDir = "/tmp/openclaw-memory-wiki-runtime-state";
    const { api, registerTool } = createPluginApi();

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      plugin.register(api);
      const registered = registerTool.mock.calls.find(
        ([, registration]) => registration.name === "wiki_status",
      )?.[0];
      const statusFactory = typeof registered === "function" ? registered : registered?.create;

      expect(statusFactory?.({ agentId: "main" })).toMatchObject({
        testConfig: { vault: { path: path.join(stateDir, "wiki", "main") } },
      });
    });
  });

  it("resolves every tool factory from keyed agent entries", async () => {
    const rootDir = await createTempDir("memory-wiki-index-agents-");
    const appConfig = {
      agents: { entries: { support: {}, marketing: {} } },
    } as OpenClawConfig;
    const { api, registerTool } = createPluginApi();
    api.config = appConfig;
    api.pluginConfig = {
      vault: { scope: "agent", path: rootDir },
    };
    Object.assign(api.runtime, {
      config: {
        current: () => appConfig,
      },
    });

    plugin.register(api);

    for (const [registered, registration] of registerTool.mock.calls) {
      const factory = typeof registered === "function" ? registered : registered.create;
      expect(factory).toEqual(expect.any(Function));
      expect(factory({})).toBeNull();
      const supportTool = factory({ agentId: "support" });
      const marketingTool = factory({ agentId: "marketing" });
      expect(supportTool).toMatchObject({
        name: registration.name,
        testConfig: {
          agentId: "support",
          vault: { scope: "agent", path: path.join(rootDir, "support") },
        },
      });
      expect(marketingTool).toMatchObject({
        name: registration.name,
        testConfig: {
          agentId: "marketing",
          vault: { scope: "agent", path: path.join(rootDir, "marketing") },
        },
      });
      if (registration.name === "wiki_status") {
        expect(supportTool).toMatchObject({ testMemoryContext: { agentId: "support" } });
        expect(marketingTool).toMatchObject({ testMemoryContext: { agentId: "marketing" } });
      }
      expect(() => factory({ agentId: "finance" })).toThrow("Unknown memory-wiki agentId: finance");
    }
  });

  it("forwards protected recall authorization to wiki search and get", () => {
    const { api, registerTool } = createPluginApi();
    plugin.register(api);
    const conversationRecall = {
      anchorSessionKey: "agent:main:telegram:direct:owner",
      scope: "same-agent-private",
      corpus: "sessions",
    } as const;

    for (const toolName of ["wiki_search", "wiki_get"]) {
      const registration = registerTool.mock.calls.find((call) => call[1]?.name === toolName);
      const registered = registration?.[0];
      const factory = typeof registered === "function" ? registered : registered?.create;
      expect(
        factory?.({
          agentId: "main",
          sessionKey: "agent:main:telegram:direct:owner:active-memory:abcdef123456",
          sandboxed: false,
          conversationRecall,
          assertInvocationCurrent: () => {},
        }),
      ).toMatchObject({
        testMemoryContext: {
          agentId: "main",
          agentSessionKey: "agent:main:telegram:direct:owner:active-memory:abcdef123456",
          sandboxed: false,
          conversationRecall,
          memoryContext: {
            authority: {
              kind: "session",
              sessionKey: "agent:main:telegram:direct:owner:active-memory:abcdef123456",
              conversationRecall,
            },
          },
        },
      });
    }
  });

  it("activates an initialized legacy vault before an external compile", async () => {
    const rootDir = await createTempDir("memory-wiki-index-legacy-vault-");
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki"), { recursive: true });
    await fs.writeFile(path.join(rootDir, ".openclaw-wiki", "log.jsonl"), "", "utf8");
    const { api, registerService } = createPluginApi();
    api.pluginConfig = { vault: { path: rootDir } };

    plugin.register(api);
    const service = registerService.mock.calls[0]?.[0];
    await service?.start?.();

    await expect(loadMemoryWikiVaultIdentity(rootDir)).resolves.toMatchObject({
      vaultGeneration: expect.any(String),
    });
  });

  it("terminates the query reader worker when the plugin service stops", async () => {
    const rootDir = await createTempDir("memory-wiki-index-stop-reader-");
    const { api, registerService } = createPluginApi();
    api.pluginConfig = { vault: { path: rootDir } };
    plugin.register(api);
    const service = registerService.mock.calls[0]?.[0];
    await service?.start?.();
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
    );
    // Start from a closed reader so the lookup below creates the pool's workers.
    await queryReader.closeMemoryWikiQueryReader();
    let workersCreated = 0;
    let workersExited = 0;
    const onWorker = (worker: Worker) => {
      workersCreated += 1;
      worker.once("exit", () => {
        workersExited += 1;
      });
    };
    process.on("worker", onWorker);
    try {
      // A basename lookup is a whole-vault scan, so it runs on the reader's worker.
      const read = await queryReader.readMemoryWikiPages({
        rootDir,
        visibility: null,
        select: "lookup",
        lookup: "alpha",
      });
      expect(read.page?.relativePath).toBe("sources/alpha.md");
      expect(workersCreated).toBeGreaterThan(0);
      // The idle worker stays alive until it is retired or the pool closes.
      expect(workersExited).toBe(0);

      await service?.stop?.();

      expect(workersExited).toBe(workersCreated);
    } finally {
      process.off("worker", onWorker);
    }
  });

  it("fences cache publication when the plugin service stops", async () => {
    const rootDir = await createTempDir("memory-wiki-index-stop-fence-");
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki"), { recursive: true });
    await fs.writeFile(path.join(rootDir, ".openclaw-wiki", "log.jsonl"), "", "utf8");
    const { api, registerService } = createPluginApi();
    api.pluginConfig = { vault: { path: rootDir } };
    plugin.register(api);
    const config = resolveMemoryWikiConfig(api.pluginConfig);
    const service = registerService.mock.calls[0]?.[0];
    await service?.start?.();
    const identity = await loadMemoryWikiVaultIdentity(rootDir);
    if (!identity.vaultGeneration) {
      throw new Error("Expected an active Memory Wiki vault generation");
    }
    const snapshot = emptyCompiledSnapshot();
    const validationEntered = deferred();
    const releaseValidation = deferred();
    const commitPublication = vi.fn();
    const publicationId = randomUUID();
    const publication = writeMemoryWikiCompiledCache(
      config,
      snapshot,
      resolveMemoryWikiCompiledCacheGeneration(snapshot),
      publicationId,
      null,
      async () => {
        validationEntered.resolve();
        await releaseValidation.promise;
      },
      commitPublication,
      async () => ({
        vaultGeneration: identity.vaultGeneration,
        compiledCachePublicationId: publicationId,
      }),
    );
    await validationEntered.promise;

    await service?.stop?.();
    releaseValidation.resolve();

    await expect(publication).rejects.toThrow("cache owner retired before publication");
    expect(commitPublication).not.toHaveBeenCalled();
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });

  it.each(["wiki.importInsights", "wiki.compile"])(
    "closes queued %s source sync before it can activate a vault",
    async (method) => {
      const rootDir = await createTempDir("memory-wiki-index-stop-sync-");
      const { api, registerGatewayMethod, registerService } = createPluginApi();
      api.pluginConfig = { vault: { path: rootDir } };
      plugin.register(api);
      const config = resolveMemoryWikiConfig(api.pluginConfig);
      const service = registerService.mock.calls[0]?.[0];
      await service?.start?.();

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
          resolveMemoryWikiCompiledCacheGeneration(snapshot),
          randomUUID(),
          null,
          async () => {},
          async () => {},
          () => loadMemoryWikiValidatedVaultIdentity(rootDir),
        ),
      ).rejects.toThrow("vault is not active");
      await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
    },
  );

  it("clears active owners before a fallible lifecycle identity refresh", async () => {
    const rootDir = await createTempDir("memory-wiki-index-refresh-failure-");
    const { api, registerService } = createPluginApi();
    api.pluginConfig = { vault: { path: rootDir } };
    plugin.register(api);
    const config = resolveMemoryWikiConfig(api.pluginConfig);
    await fs.mkdir(path.join(rootDir, ".openclaw-wiki"), { recursive: true });
    await fs.writeFile(path.join(rootDir, ".openclaw-wiki", "log.jsonl"), "", "utf8");
    const service = registerService.mock.calls[0]?.[0];
    await service?.start?.();

    const snapshot = emptyCompiledSnapshot();
    const publicationId = randomUUID();
    const reservationId = randomUUID();
    const parentPublicationId = (await loadMemoryWikiVaultIdentity(rootDir))
      .compiledCachePublicationId;
    await appendMemoryWikiLog(rootDir, {
      type: "compile",
      timestamp: "2026-07-17T00:00:00.000Z",
      details: { compiledCacheReservationId: reservationId },
    });
    const sourceGeneration = await resolveMemoryWikiVaultSourceGeneration(rootDir);
    await appendMemoryWikiLog(rootDir, {
      type: "compile",
      timestamp: "2026-07-17T00:00:00.000Z",
      details: {
        compiledCachePublicationId: publicationId,
        compiledCacheParentPublicationId: parentPublicationId,
        compiledCacheReservationId: reservationId,
        compiledCacheSourceGeneration: sourceGeneration,
      },
    });
    await writeMemoryWikiCompiledCache(
      config,
      snapshot,
      resolveMemoryWikiCompiledCacheGeneration(snapshot),
      publicationId,
      parentPublicationId,
      async () => {},
      async () => {},
      () => loadMemoryWikiValidatedVaultIdentity(rootDir),
    );
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toEqual(snapshot);

    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("transient restore read failure"));
    await expect(service?.start?.()).rejects.toThrow("transient restore read failure");
    await expect(loadMemoryWikiCompiledCache(config)).resolves.toBeNull();
  });
});
