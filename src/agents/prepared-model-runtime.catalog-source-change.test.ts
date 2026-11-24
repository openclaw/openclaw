// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayUpdateLifecycle } from "../infra/update-check-lifecycle.js";
import { createGatewayUpdateCheck } from "../infra/update-startup-scheduler.js";
import * as pricing from "../model-catalog/pricing.js";
import {
  captureRemoteModelCatalogSnapshot,
  captureRemoteModelCatalogStartupSnapshot,
  prepareRemoteModelCatalogStartupSnapshot,
  type RemoteCatalogPublicationResult,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import * as remoteRefresh from "../model-catalog/remote-refresh.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { modelDefinition, providerConfig } from "./model-auth.fixtures.test-support.js";
import {
  applyRemoteModelCatalogUpdate,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots as refresh,
  type PreparedModelRuntimeLease,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness(undefined, async () => {
  vi.restoreAllMocks();
});
const { mocks } = fixture;

const sourceUrl = "https://catalog.openclaw.ai/models/v2/catalog.json";
const stored = vi.fn();
const config: OpenClawConfig = {
  agents: { entries: { default: {}, other: {} }, defaults: { model: "custom/remote-200" } },
  ...providerConfig("custom", {
    baseUrl: "https://fixture.invalid",
    api: "openai-completions",
    models: [modelDefinition("remote-200", { reasoning: false })],
  }),
};
function bundle(generatedAt: number, url = sourceUrl) {
  return {
    source_url: url,
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
/** A running Gateway serves the catalog published at startup (generation 200). */
async function startGateway() {
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
  await refresh(config, {
    allowGatewaySubagentBinding: true,
    gatewayLifecycle: true,
    catalogMode: "static",
  });
}
function holdPricing() {
  const entered = createDeferred();
  const release = createDeferred();
  const preparePricing = pricing.prepareModelPricingContext;
  vi.spyOn(pricing, "prepareModelPricingContext").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return await preparePricing(...args);
  });
  return { entered: entered.promise, release: () => release.resolve() };
}
/** Admits a turn the way reply dispatch does: the runtime and its owner's lease together. */
async function replyDispatchAgent() {
  let lease: PreparedModelRuntimeLease | undefined;
  const runtime = await loadPublishedGatewayReplyDispatchRuntime({
    agentId: "default",
    onRuntimeLease: (admitted) => {
      lease = admitted;
    },
  });
  await lease?.[Symbol.asyncDispose]();
  return runtime?.agentId;
}
afterEach(() => setRemoteModelCatalogOverlaySourcesForTest());

describe("catalog source change on a running Gateway", () => {
  const mirror = "https://catalog-mirror.example.test/models/v3/catalog.json";
  const changed: OpenClawConfig = {
    ...config,
    models: { ...config.models, catalogRefresh: { url: mirror } },
  };

  /** Starts the Gateway's catalog check owner, then changes its source inside a reload operation. */
  async function changeSourceDuringReload() {
    await startGateway();
    // Like the metadata loader, a snapshot belongs to the plugin inventory that read it.
    const metadata = await pluginMetadata.resolvePluginMetadataSnapshotAsync({ config });
    vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync").mockImplementation(async () => {
      const snapshot = { ...metadata };
      bindPluginMetadataSnapshotCache(snapshot, getPluginCache());
      return snapshot;
    });
    let current = config;
    vi.spyOn(remoteRefresh, "refreshRemoteModelCatalog").mockImplementation(async () => ({
      status: "updated",
      generatedAt: 300,
      providers: 1,
      models: 1,
    }));
    const clock = createGatewaySchedulerClock(Date.now());
    const lifecycle = createGatewayUpdateLifecycle(createTestGatewayScheduler(clock.clock));
    const adoptions: Promise<RemoteCatalogPublicationResult>[] = [];
    const check = createGatewayUpdateCheck({
      lifecycle,
      getConfig: () => current,
      log: { info: vi.fn() },
      isNixMode: false,
      applyRemoteCatalogUpdate: (signal) => {
        const adoption = applyRemoteModelCatalogUpdate(() => current, signal);
        adoptions.push(adoption);
        return adoption;
      },
    });
    check.start();
    await clock.advanceBy(0);
    expect(await adoptions[0]).toBe("unchanged");

    stored.mockReturnValue(bundle(300, mirror));
    current = changed;
    // A reload publishes config inside its plugin operation; that inventory retires when it ends.
    const operation = createPluginCache({ kind: "operation" });
    withPluginCache(operation, () => sessionChanges.emit({ all: true, scope: "config" }));
    return {
      clock,
      adoption: (index: number) => adoptions[index],
      endOperation: async () => await retirePluginCache(operation),
      stop: async () => {
        await check.stop();
        await lifecycle.stop();
      },
    };
  }

  it("adopts when the reload operation ends during the build", async () => {
    const gateway = await changeSourceDuringReload();
    try {
      const held = holdPricing();
      const check = gateway.clock.advanceBy(0);
      await held.entered;
      await gateway.endOperation();
      held.release();
      await check;

      expect(await gateway.adoption(1)).toBe("published");
      expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
    } finally {
      await gateway.stop();
    }
  });

  it("adopts when the reload operation ended before the check ran", async () => {
    const gateway = await changeSourceDuringReload();
    try {
      await gateway.endOperation();
      await gateway.clock.advanceBy(0);

      expect(await gateway.adoption(1)).toBe("published");
      expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(300);
    } finally {
      await gateway.stop();
    }
  });

  it("keeps reply dispatch published after the reload operation ends", async () => {
    const gateway = await changeSourceDuringReload();
    try {
      await gateway.clock.advanceBy(0);
      expect(await gateway.adoption(1)).toBe("published");
      await gateway.endOperation();

      expect(await replyDispatchAgent()).toBe("default");
    } finally {
      await gateway.stop();
    }
  });

  it("keeps later scheduled checks working after the reload operation ends", async () => {
    const gateway = await changeSourceDuringReload();
    try {
      await gateway.clock.advanceBy(0);
      expect(await gateway.adoption(1)).toBe("published");
      await gateway.endOperation();

      stored.mockReturnValue(bundle(400, mirror));
      await gateway.clock.advanceBy(remoteRefresh.REMOTE_MODEL_CATALOG_TTL_MS);
      expect(await gateway.adoption(2)).toBe("published");
      expect(captureRemoteModelCatalogStartupSnapshot()?.generatedAt).toBe(400);
      expect(await replyDispatchAgent()).toBe("default");
    } finally {
      await gateway.stop();
    }
  });
});
