// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  getPreparedModelRuntimeTestApi,
  usePreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
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
    list: [{ id: "default", default: true }, { id: "other" }],
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
async function refresh() {
  const respond = vi.fn();
  const loader = (params: Parameters<typeof loadPreparedGatewayModelCatalogSnapshot>[0]) =>
    loadPreparedGatewayModelCatalogSnapshot({ ...params, getConfig: () => config });
  registerGatewayModelCatalogPrivateAccess(loader, {
    loadDeferred: loader,
    readPrepared: (params) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({ ...params, getConfig: () => config }),
  });
  await modelsHandlers["models.list"]!({
    req: { type: "req", id: "refresh", method: "models.list" },
    params: { agentId: "default", view: "all", refresh: true },
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

it("returns usable refresh rows when the saved remote bundle is corrupt", async () => {
  await setup();
  stored.mockReturnValue({ source_url: sourceUrl, bundle_json: "{" });
  const result = await refresh();
  expect(result.models.map((row: { id: string }) => row.id)).toContain("remote-200");
  expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
});

it("bounds refresh with two agents while another discovery is held and publishes later", async () => {
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
  const pending = refresh();
  try {
    const result = await withTestTimeout(
      pending,
      6_000,
      "refresh exceeded the foreground fallback",
    );
    expect(result.models.map((row: { id: string }) => row.id)).toContain("remote-200");
    await withTestTimeout(published.promise, 6_000, "background adoption waited for another agent");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    release.resolve();
    await Promise.allSettled([pending, other]);
    stop();
    workerSpy.mockRestore();
  }
});

it("publishes the accepted bundle despite a provider discovery failure", async () => {
  await setup();
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({
    entries: [],
    routeVariants: [],
    authoritative: false,
    refreshFailed: true,
  });
  expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
  expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  expect(captureRemoteModelCatalogStartupSnapshot()?.pricing["custom/remote-300"]?.cost.input).toBe(
    300,
  );
});

it("retries a scheduled adoption when its pending auth owner settles", async () => {
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
    await withTestTimeout(rebuilding.promise, 10_000, "auth mutation did not start a rebuild");
    check.start();
    expect(await withTestTimeout(checked.promise, 10_000, "catalog check did not settle")).toBe(
      "remote model catalog applied",
    );
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

it("does not hold Gateway shutdown on an adoption's pricing preparation", async () => {
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
    await withTestTimeout(
      closePreparedModelRuntimeSnapshots(),
      5_000,
      "shutdown waited for held pricing preparation",
    );
    expect(await adoption).toBe("superseded");
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(200);
  } finally {
    held.resolve();
    pricingSpy.mockRestore();
  }
});

it("republishes adopted owners when their borrowed Gateway plugin retires", async () => {
  const lender = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "gateway-lender" });
  lender.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry: lender });
  markPluginRegistryActive(lender);
  const gateway = createPluginRegistryOwner(lender);
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(lender);
  try {
    await setup();
    expect(await applyRemoteModelCatalogUpdate(() => config)).toBe("published");
    expect(instance.owner?.registry).toBe(lender);
    const input = fixture.agentInput("default", config);
    const adopted = await prepareModelRuntimeSnapshot(input);
    const nextRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear().mockReturnValue(nextRegistry);
    quiescePluginRegistry(lender);
    expect(adopted.isCurrent()).toBe(false);
    // Recovery republishes the adopted catalog's owners; it does not wait for a restart.
    const replacement = await withTestTimeout(
      prepareModelRuntimeSnapshot(input),
      10_000,
      "adopted owner was not republished after its Gateway lender retired",
    );
    expect(replacement.pluginRegistry).toBe(nextRegistry);
    expect(replacement.isCurrent()).toBe(true);
    expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
  } finally {
    await gateway.close();
  }
});
