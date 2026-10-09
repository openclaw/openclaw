// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import { createGatewayUpdateCheck } from "../infra/update-startup.js";
import * as pricing from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogSnapshot,
  captureRemoteModelCatalogStartupSnapshot,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import * as remoteRefresh from "../model-catalog/remote-refresh.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import * as nativeAdmission from "../plugins/plugin-native-admission-state.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryActive, quiescePluginRegistry } from "../plugins/registry-lifecycle.js";
import { createPluginRegistryOwner } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import * as catalogWorker from "./prepared-model-catalog-worker.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  applyRemoteModelCatalogUpdate,
  beginPreparedModelRuntimePluginDrain,
  getPreparedModelRuntimeSnapshot,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import { PreparedModelRuntimePublicationQueue } from "./prepared-model-runtime.publication-queue.js";

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
async function setup() {
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

it("keeps downloaded catalogs pending while plugin work drains", async ({ signal }) => {
  await setup();
  const preparing = createDeferred();
  const releasePricing = createDeferred();
  const preparePricing = pricing.prepareModelPricingContext;
  const pricingSpy = vi
    .spyOn(pricing, "prepareModelPricingContext")
    .mockImplementationOnce(async (...args) => {
      preparing.resolve();
      await releasePricing.promise;
      return await preparePricing(...args);
    });
  const attempted = createDeferred();
  const queueSpy = vi.spyOn(PreparedModelRuntimePublicationQueue.prototype, "enqueue");
  queueSpy.mockImplementationOnce(function (this: PreparedModelRuntimePublicationQueue, ...args) {
    queueSpy.mockRestore();
    const publication = this.enqueue(...args);
    void publication.then(
      () => attempted.resolve(),
      () => attempted.resolve(),
    );
    return publication;
  });
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  let drain: ReturnType<typeof beginPreparedModelRuntimePluginDrain> | undefined;
  try {
    await withinTest(preparing.promise, signal);
    drain = beginPreparedModelRuntimePluginDrain();
    releasePricing.resolve();
    await withinTest(attempted.promise, signal);
    const active = await withinTest(
      loadPreparedGatewayModelCatalogSnapshot({ agentId: "default", getConfig: () => config }),
      signal,
    );
    expect(active.entries.map((entry) => entry.id)).toContain("remote-200");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    // Lifecycle publication must not queue behind adoption's pending drain wait.
    await withinTest(
      refreshPreparedModelRuntimeSnapshots(config, { catalogMode: "static" }),
      signal,
    );
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    drain.release();
    expect(await withinTest(adoption, signal)).toBe("published");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    drain?.release();
    releasePricing.resolve();
    await adoption;
    queueSpy.mockRestore();
    pricingSpy.mockRestore();
  }
});

it("does not reuse a dynamic build captured before a remote publication", async () => {
  await setup();
  const preparing = createDeferred();
  const commit = createDeferred();
  const preparePricing = pricing.prepareModelPricingContext;
  const pricingSpy = vi
    .spyOn(pricing, "prepareModelPricingContext")
    .mockImplementation(async (...args) => {
      const result = await preparePricing(...args);
      preparing.resolve();
      await commit.promise;
      return result;
    });
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  await preparing.promise;
  const captured = createDeferred();
  const release = createDeferred();
  const original = mocks.buildPreparedModelCatalogSnapshot.getMockImplementation()!;
  let held = false;
  mocks.buildPreparedModelCatalogSnapshot.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!held) {
      held = true;
      captured.resolve();
      await release.promise;
    }
    return result;
  });
  const input = { ...fixture.agentInput("default", config), loadRuntimePlugins: true };
  const pending = acquireReadOnlyPreparedModelRuntime(input, { catalogMode: "live" });
  try {
    await Promise.race([
      captured.promise,
      pending.then(() => {
        throw new Error("Dynamic build did not reach capture");
      }),
    ]);
    commit.resolve();
    expect(await adoption).toBe("published");
  } finally {
    commit.resolve();
    release.resolve();
    pricingSpy.mockRestore();
    await adoption;
  }
  const first = await pending.catch((error: unknown) => {
    expect(error).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
    return undefined;
  });
  await first?.[Symbol.asyncDispose]();
  await using next = await acquireReadOnlyPreparedModelRuntime(input, { catalogMode: "live" });
  expect(next.pluginGeneration?.remoteCatalog?.generatedAt).toBe(300);
  expect(next.pluginGeneration?.remoteCatalog?.pricing["custom/remote-300"]?.cost.input).toBe(300);
  expect(next.snapshot.modelCatalog.entries.map((row) => row.id)).toContain("remote-300");
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
  held = true;
  const adoption = applyRemoteModelCatalogUpdate(() => config);
  try {
    await withinTest(discovering.promise, signal);
    // Readers keep the accepted catalog's rows and prices while its successor discovers.
    expect(await withinTest(rows(), signal)).toContain("discovered-200");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
    release.resolve();
    expect(await withinTest(adoption, signal)).toBe("published");
    const adopted = await rows();
    expect(adopted).toContain("discovered-300");
    expect(adopted).not.toContain("discovered-200");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    release.resolve();
    await adoption.catch(() => undefined);
  }
});

it("retries a scheduled adoption when its pending auth owner settles", async ({
  signal: testSignal,
}) => {
  await setup();
  const rebuilding = createDeferred();
  const releaseRebuild = createDeferred();
  const settleAdmissions = nativeAdmission.settlePluginNativeAdmissions;
  const admissionSpy = vi
    .spyOn(nativeAdmission, "settlePluginNativeAdmissions")
    .mockImplementationOnce(async (...args) => {
      rebuilding.resolve();
      await releaseRebuild.promise;
      return await settleAdmissions(...args);
    });
  const refreshSpy = vi.spyOn(remoteRefresh, "refreshRemoteModelCatalog").mockResolvedValue({
    status: "updated",
    providers: 1,
    models: 1,
    generatedAt: 300,
  });
  const checked = createDeferred<string>();
  const log = {
    info: vi.fn((message: string) => {
      if (message.startsWith("remote model catalog")) {
        checked.resolve(message);
      }
    }),
  };
  const check = createGatewayUpdateCheck({
    lifecycle: createGatewayUpdateLifecycle(createTestGatewayScheduler("fake-timers")),
    getConfig: () => config,
    applyRemoteCatalogUpdate: (signal) => {
      const adoption = applyRemoteModelCatalogUpdate(() => config, signal);
      // The stored-catalog read and owner claim settle in microtasks; the auth build
      // settles only after this turn, so adoption first observes the pending owner.
      setImmediate(() => releaseRebuild.resolve());
      return adoption;
    },
    log,
    isNixMode: false,
  });
  try {
    mocks.mutationListener?.({
      agentDir: fixture.agentInput("default", config).agentDir,
      affectsInheritedStores: false,
    });
    await withinTest(rebuilding.promise, testSignal);
    check.start();
    expect(await withinTest(checked.promise, testSignal)).toBe("remote model catalog applied");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    releaseRebuild.resolve();
    await check.stop();
    refreshSpy.mockRestore();
    admissionSpy.mockRestore();
  }
});

it("does not let a read under a superseded config cancel the current adoption", async () => {
  await setup();
  const mirrorUrl = "https://mirror.example.test/catalog.json";
  const mirrorConfig: OpenClawConfig = {
    ...config,
    models: { ...config.models, catalogRefresh: { url: mirrorUrl } },
  };
  let currentConfig = config;
  const staleRead = createDeferred<{ source_url: string; bundle_json: string }>();
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
  let current: Promise<string> | undefined;
  stored.mockImplementationOnce(() => {
    // The configured source changes while this caller's read is still in flight.
    currentConfig = mirrorConfig;
    stored.mockReturnValue({ ...bundle(400), source_url: mirrorUrl });
    current = applyRemoteModelCatalogUpdate(() => currentConfig);
    return staleRead.promise;
  });
  try {
    const stale = applyRemoteModelCatalogUpdate(() => currentConfig);
    await preparing.promise;
    staleRead.resolve(bundle(300));
    // The stale caller's config check and pending join settle in microtasks.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    commit.resolve();
    expect(await Promise.all([stale, current])).toEqual(["published", "published"]);
    expect(captureRemoteModelCatalogStartupSnapshot()).toMatchObject({
      sourceUrl: mirrorUrl,
      generatedAt: 400,
    });
  } finally {
    commit.resolve();
    staleRead.resolve(bundle(300));
    pricingSpy.mockRestore();
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

it.for(["after", "before"] as const)(
  "recovers adopted owners when their borrowed Gateway plugin retires %s commit",
  async (phase, { signal }) => {
    const lender = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "gateway-lender" });
    lender.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry: lender });
    markPluginRegistryActive(lender);
    const gateway = createPluginRegistryOwner(lender);
    // Only the adoption candidates borrow the lender, so its retirement does not also
    // retire the claimed predecessors (whose own watchers would abort the attempt).
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(createEmptyPluginRegistry());
    const preparing = createDeferred();
    const commit = createDeferred();
    const preparePricing = pricing.prepareModelPricingContext;
    const pricingSpy = vi
      .spyOn(pricing, "prepareModelPricingContext")
      .mockImplementation(async (...args) => {
        if (phase === "before") {
          preparing.resolve();
          await commit.promise;
        }
        return await preparePricing(...args);
      });
    const nextRegistry = createEmptyPluginRegistry();
    const input = fixture.agentInput("default", config);
    try {
      await setup();
      mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(lender);
      const adoption = applyRemoteModelCatalogUpdate(() => config);
      if (phase === "before") {
        // The staged candidate holds the loan; no reader can observe it yet.
        await preparing.promise;
        expect(instance.owner?.registry).toBe(lender);
        mocks.loadAgentRuntimePluginRegistryHandle.mockClear().mockReturnValue(nextRegistry);
        quiescePluginRegistry(lender);
        commit.resolve();
        expect(await withinTest(adoption, signal)).toBe("published");
      } else {
        expect(await adoption).toBe("published");
        expect(instance.owner?.registry).toBe(lender);
        const adopted = await prepareModelRuntimeSnapshot(input);
        mocks.loadAgentRuntimePluginRegistryHandle.mockClear().mockReturnValue(nextRegistry);
        quiescePluginRegistry(lender);
        expect(adopted.isCurrent()).toBe(false);
      }
      // A lost loan never leaves the adopted catalog's owners unusable until a restart.
      const replacement = await withinTest(prepareModelRuntimeSnapshot(input), signal);
      expect(replacement.pluginRegistry).toBe(nextRegistry);
      expect(replacement.isCurrent()).toBe(true);
      expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
    } finally {
      commit.resolve();
      pricingSpy.mockRestore();
      await gateway.close();
    }
  },
);
