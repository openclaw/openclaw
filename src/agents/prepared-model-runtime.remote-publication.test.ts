// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { getPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import * as pricing from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogSnapshot,
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createEnteredGate } from "./entered-gate.test-support.js";
import * as runtimePluginLoadPlan from "./harness/runtime-plugin-load-plan.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import { harnessRegistry } from "./model-catalog-fixtures.test-support.js";
import * as catalogWorker from "./prepared-model-catalog-worker.js";
import { scopePreparedModelRuntimeLease } from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  acquireAgentRunPreparedModelRuntime as acquireRun,
  acquirePublishedPreparedModelRuntime as acquirePublished,
  advancePreparedModelRuntimeConfig,
  applyRemoteModelCatalogUpdate,
  getPreparedModelRuntimeSnapshot as readSnapshot,
  loadPublishedGatewayReplyDispatchRuntime as loadPublishedDispatch,
  getPendingPreparedModelRuntimeReplacement,
  publishPreparedModelRuntimeSnapshot as publish,
  refreshPreparedModelRuntimeSnapshots as refresh,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import * as runtimeOwners from "./prepared-model-runtime.owner.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const fixture = usePreparedModelRuntimeHarness({
  label: "remote-publication",
  scenario: "minimal",
});
const { mocks } = fixture;
const sourceUrl = "https://catalog.openclaw.ai/models/v2/catalog.json";
const stored = vi.fn();
const config: OpenClawConfig = {
  agents: {
    entries: { default: {}, other: {} },
    defaults: { model: "custom/remote-200" },
  },
  ...providerConfig("custom", {
    baseUrl: "https://fixture.invalid",
    api: "openai-completions",
    models: [modelDefinition("remote-200", { reasoning: false })],
  }),
};
function bundle(generatedAt: number) {
  return {
    source_url: sourceUrl,
    bundle_json: JSON.stringify({
      schemaVersion: 1,
      sourceCommit: "fixture",
      generatedAt,
      providers: {
        custom: { models: [{ id: `remote-${generatedAt}`, name: `Remote ${generatedAt}` }] },
      },
      pricing: {
        [`custom/remote-${generatedAt}`]: { input: generatedAt, output: generatedAt * 2 },
      },
    }),
  };
}
async function setup(options: { allowGatewaySubagentBinding?: true } = {}, runtimeConfig = config) {
  stored.mockReturnValue(bundle(200));
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 100,
    readStoredCatalog: stored,
  });
  await prepareRemoteModelCatalogStartupSnapshot();
  mocks.configuredAgentIds = ["default", "other"];
  mocks.buildPreparedModelCatalogSnapshot.mockImplementation(async () => {
    const entries = Object.values(captureRemoteModelCatalogSnapshot()?.providers ?? {}).flatMap(
      (provider) =>
        (provider.models ?? []).map((model) => ({
          id: model.id,
          provider: "custom",
          name: model.name ?? model.id,
        })),
    );
    return { entries, routeVariants: entries };
  });
  await refresh(runtimeConfig, {
    ...options,
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  stored.mockReturnValue(bundle(300));
}
async function listModels(refreshFullCatalog: boolean) {
  const respond = vi.fn();
  const loader = (params: Parameters<typeof loadPreparedGatewayModelCatalogSnapshot>[0]) =>
    loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig: () => config });
  registerGatewayModelCatalogPrivateAccess(loader, {
    loadDeferred: loader,
    readPrepared: (params) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig: () => config }),
  });
  await modelsHandlers["models.list"]!({
    req: { type: "req", id: "list", method: "models.list" },
    params: { agentId: "default", view: "all", refresh: refreshFullCatalog },
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: loader,
      logGateway: { debug: vi.fn(), warn: vi.fn() },
    } as never,
  });
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1];
}
afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

it("keeps headless catalog adoption lazy until inventory is requested", async () => {
  const headless: OpenClawConfig = {
    ...config,
    gateway: { controlUi: { enabled: false } },
  };
  await setup({}, headless);
  expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();

  expect(await applyRemoteModelCatalogUpdate(() => headless)).toBe("published");
  expect(mocks.runPreparedModelCatalogWorker).not.toHaveBeenCalled();
  const input = fixture.agentInput("default", headless);
  await using run = await acquireRun(input, { catalogMode: "static" });
  expect(run.pluginGeneration.remoteCatalog?.generatedAt).toBe(300);
  expect(run.snapshot.modelCatalog.entries.map((row) => row.id)).toContain("remote-200");

  const discovering = createDeferred();
  const release = createDeferred();
  mocks.runPreparedModelCatalogWorker.mockImplementationOnce(async () => {
    discovering.resolve();
    await release.promise;
    return { entries: [], routeVariants: [] };
  });
  const first = readSnapshot(input)!.loadFullModelCatalog!({ refresh: true, wait: true });
  void first.catch(() => undefined);
  await discovering.promise;
  const { preparing, commit, pricingSpy } = holdPricing();
  stored.mockReturnValue(bundle(400));
  const adoption = applyRemoteModelCatalogUpdate(() => headless);
  try {
    await preparing.promise;
    commit.resolve();
    // Let adoption reach the held acquisition before releasing its first request.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    release.resolve();
    await first;
    expect(await adoption).toBe("published");
  } finally {
    commit.resolve();
    release.resolve();
    await Promise.allSettled([first, adoption]);
    pricingSpy.mockRestore();
  }
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(2);
  expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(400);
  stored.mockReturnValue(bundle(500));
  expect(await applyRemoteModelCatalogUpdate(() => headless)).toBe("published");
  expect(mocks.runPreparedModelCatalogWorker).toHaveBeenCalledTimes(3);
});

function holdPricing() {
  const preparing = createDeferred();
  const commit = createDeferred();
  const preparePricing = pricing.prepareModelPricingContext;
  const pricingSpy = vi
    .spyOn(pricing, "prepareModelPricingContext")
    .mockImplementationOnce(async (...args) => {
      preparing.resolve();
      await commit.promise;
      return await preparePricing(...args);
    });
  return { preparing, commit, pricingSpy };
}

it("shares catalog adoption without sharing observer cancellation and accepts the next update", async ({
  signal,
}) => {
  await setup();
  const { preparing, commit, pricingSpy } = holdPricing();
  const observer = new AbortController();
  const cancelled = applyRemoteModelCatalogUpdate(() => config, observer.signal);
  const reason = new Error("catalog observer closed");
  const cancelledResult = expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
    cause: reason,
  });
  let adoption: ReturnType<typeof applyRemoteModelCatalogUpdate> | undefined;
  try {
    await withinTest(preparing.promise, signal);
    adoption = applyRemoteModelCatalogUpdate(() => config);
    observer.abort(reason);
    await withinTest(cancelledResult, signal);
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    commit.resolve();
    expect(await withinTest(adoption, signal)).toBe("published");
    expect(pricingSpy).toHaveBeenCalledTimes(1);
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
    stored.mockReturnValue(bundle(400));
    expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(400);
  } finally {
    observer.abort(reason);
    commit.resolve();
    await Promise.allSettled([cancelledResult, adoption]);
    pricingSpy.mockRestore();
  }
});

it("preserves prospective tool and sandbox policy across catalog adoption", async () => {
  await setup();
  const { preparing, commit, pricingSpy } = holdPricing();
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  try {
    await preparing.promise;
    advancePreparedModelRuntimeConfig({
      ...config,
      tools: { deny: ["exec"] },
      agents: {
        ...config.agents,
        defaults: { ...config.agents?.defaults, sandbox: { mode: "all" } },
      },
    });
    commit.resolve();
    expect(await adoption).toBe("published");
    await expect(loadPublishedDispatch({ agentId: "default" })).resolves.toMatchObject({
      config: {
        tools: { deny: ["exec"] },
        agents: { defaults: { sandbox: { mode: "all" } } },
      },
    });
  } finally {
    commit.resolve();
    await Promise.allSettled([adoption]);
    pricingSpy.mockRestore();
  }
});

it("delivers the first reply when catalog adoption retires its captured dispatch publication", async () => {
  await setup({ allowGatewaySubagentBinding: true });
  const { preparing, commit, pricingSpy } = holdPricing();
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  await preparing.promise;
  const deliver = vi.fn(async (_payload: ReplyPayload) => undefined);
  const dispatcher = createReplyDispatcher({ deliver });
  try {
    const result = await dispatchLowLevelChannelReplyFromConfig({
      cfg: config,
      ctx: finalizeInboundContext({
        Body: "hello",
        From: "synthetic-user",
        To: "synthetic-bot",
        AgentId: "default",
        SessionKey: "agent:default:main",
        MessageSid: "catalog-adoption-first-reply",
        Provider: "synthetic-channel",
        Surface: "synthetic-channel",
        ChatType: "direct",
        InboundAccessAuthorized: true,
      }),
      dispatcher,
      replyResolver: async () => {
        const runtime = getPreparedReplyDispatchRuntime()!;
        commit.resolve();
        expect(await adoption).toBe("published");
        await using lease = await acquireRun(
          {
            config: runtime.config,
            agentId: runtime.agentId,
            agentDir: runtime.agentDir,
            workspaceDir: runtime.workspaceDir,
            allowGatewaySubagentBinding: true,
            runtimePluginSelections: [
              { provider: "custom", modelId: "remote-200", runtime: "openclaw" },
            ],
          },
          { catalogMode: "static", pluginGeneration: runtime.pluginGeneration },
        );
        expect(runtime.readFullModelCatalog?.()?.entries.map((row) => row.id)).toContain(
          "remote-200",
        );
        expect(lease.pluginGeneration.remoteCatalog?.generatedAt).toBe(200);
        expect(lease.snapshot.modelCatalog.entries.map((row) => row.id)).toContain("remote-200");
        expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
        return { text: "first reply completed" };
      },
    });
    expect(result.queuedFinal).toBe(true);
  } finally {
    commit.resolve();
    await Promise.allSettled([adoption]);
    pricingSpy.mockRestore();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }
  expect(deliver.mock.calls.map(([payload]) => payload.text)).toEqual(["first reply completed"]);
});

it("keeps derived parents confined to their selections after a catalog publication", async () => {
  await setup();
  const input = fixture.agentInput("default", config);
  await using configured = await acquirePublished(input);
  const selected = {
    ...input,
    workspaceDir: configured.snapshot.workspaceDir,
    runtimePluginSelections: [{ provider: "custom", modelId: "selected", runtime: "first" }],
  };
  // Each selection resolves its own harness owner; the parent registry holds only "first".
  using _ = vi
    .spyOn(runtimePluginLoadPlan, "resolveAgentRuntimePluginSelectionOwners")
    .mockImplementation(({ selections }) => {
      const pluginIds = selections.map((selection) =>
        selection.provider === "openai" ? "openai" : "first",
      );
      return { pluginIds, forceActivatedPluginIds: pluginIds };
    });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "first", status: "loaded" }));
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  await using parent = scopePreparedModelRuntimeLease(
    await acquireRun(selected, {
      catalogMode: "static",
      pluginGeneration: configured.pluginGeneration,
    }),
  );
  expect(parent.pluginGeneration).not.toBe(configured.pluginGeneration);
  expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
  await expect(
    parent.run(() =>
      acquireRun(
        {
          ...selected,
          runtimePluginSelections: [
            { provider: "openai", modelId: "gpt-5.6-luna", runtime: "openclaw" },
          ],
        },
        { catalogMode: "static", pluginGeneration: parent.pluginGeneration },
      ),
    ),
  ).rejects.toThrow(PreparedModelRuntimePublicationSupersededError);
});

it("bounds refresh with two agents while another discovery is held and adopts after it", async ({
  signal,
}) => {
  const release = createDeferred();
  const discovering = createDeferred();
  const published = createDeferred();
  const createWorker = catalogWorker.createPreparedModelCatalogWorker;
  const workerSpy = vi
    .spyOn(catalogWorker, "createPreparedModelCatalogWorker")
    .mockImplementation((params) => {
      const worker = createWorker(params);
      return {
        ...worker,
        loadCatalog: async (...args) => {
          if (params.agentFacts.input.agentId === "other") {
            discovering.resolve();
            await release.promise;
          }
          return await worker.loadCatalog(...args);
        },
      };
    });
  await setup();
  const stop = registerPreparedModelRuntimePublicationListener((event) => {
    if (
      event.phase === "published" &&
      captureRemoteModelCatalogStartupSnapshot()?.generatedAt === 300
    ) {
      published.resolve();
    }
  });
  const other = loadPreparedGatewayModelCatalogSnapshot({
    agentId: "other",
    getConfig: () => config,
    refreshFullCatalog: true,
  });
  void other.catch(() => undefined);
  await discovering.promise;
  const pending = listModels(true);
  try {
    // The refresh stays bounded while discovery is held; adoption publishes after it completes.
    const result = await withinTest(pending, signal);
    expect(result.models.map((row: { id: string }) => row.id)).toContain("remote-200");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    release.resolve();
    await withinTest(published.promise, signal);
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    release.resolve();
    await Promise.allSettled([pending, other]);
    stop();
    workerSpy.mockRestore();
  }
});

it("keeps discovered rows published until the adopted catalog's discovery completes", async ({
  signal,
}) => {
  const native = vi.fn(async () => []);
  const registry = harnessRegistry("native-test", {
    label: "Native test",
    runAttempt: vi.fn(),
    loadModelCatalog: native,
  });
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  await setup();
  const owner = readSnapshot(fixture.agentInput("default", config))!;
  // Settle startup's full discovery so the refresh below runs with this test's worker.
  await owner.loadFullModelCatalog!();
  const discovering = createDeferred();
  const release = createDeferred();
  let held = false;
  mocks.runPreparedModelCatalogWorker.mockImplementation(async () => {
    // Discovery observes the catalog version of the generation that runs it.
    const id = `discovered-${captureRemoteModelCatalogSnapshot()?.generatedAt}`;
    if (held) {
      discovering.resolve();
      await release.promise;
    }
    const row = { id, provider: "custom", name: id };
    return { entries: [row], routeVariants: [row] };
  });
  const rows = async () =>
    (await listModels(false)).models.map((row: { id: string }) => row.id) as string[];
  await owner.loadFullModelCatalog!({ refresh: true });
  expect(await rows()).toContain("discovered-200");
  const nativeAcquisitions = native.mock.calls.length;
  held = true;
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  try {
    await withinTest(discovering.promise, signal);
    // Readers keep the accepted catalog's rows and prices while its successor discovers.
    expect(await withinTest(rows(), signal)).toContain("discovered-200");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    release.resolve();
    expect(await withinTest(adoption, signal)).toBe("published");
    expect(native).toHaveBeenCalledTimes(nativeAcquisitions);
    const adopted = await rows();
    expect(adopted).toContain("discovered-300");
    expect(adopted).not.toContain("discovered-200");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    release.resolve();
    await adoption.catch(() => undefined);
  }
});

it("ends adoption instead of joining a timed-out owner build", async () => {
  await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(1);
  const started = createDeferred();
  const finish = createDeferred();
  mocks.resolveAmbientCredentials.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    return {};
  });
  const failed = createDeferred();
  const stop = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "failed") {
      failed.resolve();
    }
  });
  try {
    mocks.mutationListener?.({
      agentDir: fixture.agentInput("default", config).agentDir,
      affectsInheritedStores: false,
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(1);
    await failed.promise;
    let result: string | undefined;
    void applyRemoteModelCatalogUpdate(() => config).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result).toBe("superseded");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
  } finally {
    stop();
    finish.resolve();
    vi.useRealTimers();
  }
});

it("does not hold Gateway shutdown on an adoption's pricing preparation", async ({ signal }) => {
  await setup();
  const pricingGate = createEnteredGate();
  const pricingSpy = vi
    .spyOn(pricing, "prepareModelPricingContext")
    .mockImplementation(pricingGate.wait);
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  try {
    await pricingGate.entered;
    // Pricing stays held until `finally`; shutdown that joined it never settles.
    await withinTest(closePreparedModelRuntimeSnapshots(), signal);
    expect(await adoption).toBe("superseded");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
  } finally {
    pricingGate.release();
    pricingSpy.mockRestore();
  }
});

it("keeps staged registration current but recovers retirement only after commit", async () => {
  await setup({ allowGatewaySubagentBinding: true });
  using batches = vi.spyOn(runtimeOwners, "publishPreparedModelRuntimeOwnerBatch");
  const { preparing, commit, pricingSpy } = holdPricing();
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  let recovery: Promise<void> | undefined;
  try {
    await preparing.promise;
    const candidate = batches.mock.calls.at(-1)![0].ownersToPublish[0]!;
    const snapshot = candidate.snapshot!;
    expect(snapshot.isCurrent()).toBe(true);
    expect(getPendingPreparedModelRuntimeReplacement()).toBeUndefined();
    candidate.onPluginGenerationRetired!();
    expect(getPendingPreparedModelRuntimeReplacement()).toBeUndefined();

    commit.resolve();
    expect(await adoption).toBe("published");
    expect(snapshot.isCurrent()).toBe(true);
    candidate.onPluginGenerationRetired!();
    recovery = getPendingPreparedModelRuntimeReplacement();
    expect(recovery).toBeDefined();
    await recovery;
    expect(snapshot.isCurrent()).toBe(false);
    expect(readSnapshot(candidate.input)?.isCurrent()).toBe(true);
  } finally {
    commit.resolve();
    await Promise.allSettled([adoption, recovery]);
    pricingSpy.mockRestore();
  }
});

it("releases the pricing deadline when preparation settles", async () => {
  await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { preparing, commit, pricingSpy } = holdPricing();
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  try {
    await preparing.promise;
    expect(vi.getTimerCount()).toBe(1);
    commit.resolve();
    expect(await adoption).toBe("published");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    commit.resolve();
    await Promise.allSettled([adoption]);
    pricingSpy.mockRestore();
    vi.useRealTimers();
  }
});

it("shares one pricing deadline across configs without starting later work after timeout", async () => {
  await setup();
  for (const agentId of ["other", "last"]) {
    await publish(
      fixture.agentInput(agentId, {
        ...config,
        messages: { responsePrefix: agentId },
      }),
      { provenance: "configured", catalogMode: "static" },
    );
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  getPreparedModelRuntimeTestApi().setModelRuntimeBuildTimeoutMsForTest(100);
  const started = [createDeferred(), createDeferred()];
  const finished = [createDeferred(), createDeferred()];
  const preparePricing = pricing.prepareModelPricingContext;
  const pendingPricing: ReturnType<typeof preparePricing>[] = [];
  let calls = 0;
  const pricingSpy = vi
    .spyOn(pricing, "prepareModelPricingContext")
    .mockImplementation((...args) => {
      const index = calls++;
      const pending = (async () => {
        started[index]?.resolve();
        await finished[index]?.promise;
        return preparePricing(...args);
      })();
      pendingPricing.push(pending);
      return pending;
    });
  let settled = false;
  const adoption = applyRemoteModelCatalogUpdate(() => config).catch((error: unknown) => {
    settled = true;
    return error;
  });
  try {
    await started[0]!.promise;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(80);
    finished[0]!.resolve();
    await started[1]!.promise;
    await vi.advanceTimersByTimeAsync(19);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await adoption).toMatchObject({
      name: "AbortError",
      message: "Operation aborted",
      cause: { name: "TimeoutError", message: "The operation was aborted due to timeout" },
    });
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    expect(readSnapshot(fixture.agentInput("default", config))?.isCurrent()).toBe(true);
  } finally {
    for (const gate of finished) {
      gate.resolve();
    }
    await Promise.allSettled([adoption, ...pendingPricing]);
    pricingSpy.mockRestore();
    vi.useRealTimers();
  }
  expect(calls).toBe(2);
});
