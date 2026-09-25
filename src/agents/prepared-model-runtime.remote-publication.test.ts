// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import {
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "../gateway/server-model-catalog.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import * as pricing from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogSnapshot,
  captureRemoteModelCatalogStartupSnapshot,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import * as catalogWorker from "./prepared-model-catalog-worker.js";
import {
  acquireReadOnlyPreparedModelRuntime,
  applyRemoteModelCatalogUpdate,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";

const fixture = usePreparedModelRuntimeHarness({ label: "remote-publication", scenario: "minimal" });
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
        models: [{ id: "remote-200", name: "Remote 200" }],
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
          ...model,
          provider: "custom",
          name: model.name ?? model.id,
        })),
    );
    return { entries, routeVariants: entries };
  });
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true, catalogMode: "static" });
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
  await using _first = await pending.catch((error: unknown) => {
    expect(error).toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
    return undefined;
  });
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
    if (event.phase === "published" && captureRemoteModelCatalogStartupSnapshot()?.generatedAt === 300) {
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
    const result = await withTestTimeout(pending, 6_000, "refresh exceeded the foreground fallback");
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
  expect(captureRemoteModelCatalogStartupSnapshot()?.pricing["custom/remote-300"]?.cost.input).toBe(300);
});
