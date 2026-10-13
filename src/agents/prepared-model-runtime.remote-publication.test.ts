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
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryActive, quiescePluginRegistry } from "../plugins/registry-lifecycle.js";
import { createPluginRegistryOwner } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import * as runtimePluginLoadPlan from "./harness/runtime-plugin-load-plan.js";
import * as catalogWorker from "./prepared-model-catalog-worker.js";
import { scopePreparedModelRuntimeLease } from "./prepared-model-runtime-generation-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
  applyRemoteModelCatalogUpdate,
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
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
  models: {
    providers: {
      custom: {
        baseUrl: "https://fixture.invalid",
        api: "openai-completions",
        models: [
          {
            id: "remote-200",
            name: "Remote 200",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 4096,
          },
        ],
      },
    },
  },
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
async function setup(options: { allowGatewaySubagentBinding?: true } = {}) {
  stored.mockReturnValue(bundle(200));
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 100,
    readStoredCatalog: stored,
  });
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
  await refreshPreparedModelRuntimeSnapshots(config, {
    ...options,
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  stored.mockReturnValue(bundle(300));
}
async function listModels(refresh: boolean) {
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
    params: { agentId: "default", view: "all", refresh },
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

it("delivers the first reply when catalog adoption retires its captured dispatch publication", async () => {
  await setup({ allowGatewaySubagentBinding: true });
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
        await using lease = await acquireAgentRunPreparedModelRuntime(
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
  await using configured = await acquirePublishedPreparedModelRuntime(input);
  const selected = {
    ...input,
    workspaceDir: configured.snapshot.workspaceDir,
    runtimePluginSelections: [{ provider: "custom", modelId: "selected", runtime: "first" }],
  };
  // Each selection resolves its own harness owner; the parent registry holds only "first".
  const ownersSpy = vi
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
  try {
    await using parent = scopePreparedModelRuntimeLease(
      await acquireAgentRunPreparedModelRuntime(selected, {
        catalogMode: "static",
        pluginGeneration: configured.pluginGeneration,
      }),
    );
    expect(parent.pluginGeneration).not.toBe(configured.pluginGeneration);
    expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
    await expect(
      parent.run(() =>
        acquireAgentRunPreparedModelRuntime(
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
  } finally {
    ownersSpy.mockRestore();
  }
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
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: "native-test",
    source: "fixture",
    harness: {
      id: "native-test",
      label: "Native test",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
      loadModelCatalog: native,
    },
  });
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  await setup();
  const owner = getPreparedModelRuntimeSnapshot(fixture.agentInput("default", config))!;
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
  const preparing = createDeferred();
  const held = createDeferred();
  const pricingSpy = vi
    .spyOn(pricing, "prepareModelPricingContext")
    .mockImplementation(async () => {
      preparing.resolve();
      await held.promise;
    });
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  try {
    await preparing.promise;
    // Pricing stays held until `finally`; shutdown that joined it never settles.
    await withinTest(closePreparedModelRuntimeSnapshots(), signal);
    expect(await adoption).toBe("superseded");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
  } finally {
    held.resolve();
    pricingSpy.mockRestore();
  }
});

it("recovers adopted owners when their borrowed Gateway plugin retires after commit", async ({
  signal,
}) => {
  const lender = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "gateway-lender" });
  lender.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry: lender });
  markPluginRegistryActive(lender);
  const gateway = createPluginRegistryOwner(lender);
  // Only the adoption candidates borrow the lender, so its retirement does not also
  // retire the claimed predecessors (whose own watchers would abort the attempt).
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());
  const nextRegistry = createEmptyPluginRegistry();
  const input = fixture.agentInput("default", config);
  try {
    await setup();
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(lender);
    const adoption = applyRemoteModelCatalogUpdate(() => config);
    expect(await adoption).toBe("published");
    expect(instance.owner?.registry).toBe(lender);
    const adopted = await prepareModelRuntimeSnapshot(input);
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear().mockReturnValue(nextRegistry);
    quiescePluginRegistry(lender);
    expect(adopted.isCurrent()).toBe(false);
    // A lost loan never leaves the adopted catalog's owners unusable until a restart.
    const replacement = await withinTest(prepareModelRuntimeSnapshot(input), signal);
    expect(replacement.pluginRegistry).toBe(nextRegistry);
    expect(replacement.isCurrent()).toBe(true);
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    await gateway.close();
  }
});
