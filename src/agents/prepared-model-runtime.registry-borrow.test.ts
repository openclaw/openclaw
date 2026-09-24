// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { loadPreparedInboundPluginRegistry } from "./prepared-model-runtime.inbound-registry.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquirePublishedPreparedModelRuntime,
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";
import * as runtimePlugins from "./runtime-plugins.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-registry-borrow" });
const { mocks } = fixture;

async function acquireConfiguredRegistryBorrower(source: "owned" | "gateway" = "owned") {
  mocks.configuredAgentIds = ["default"];
  const config = {};
  const workspaceDir = "/tmp/unused-workspace";
  const metadata = createPluginMetadataSnapshot({
    config,
    workspaceDir,
    manifestRegistry: makeRegistry([
      { id: "prepared-registry-borrow", origin: "config", channels: [] },
    ]),
  });
  const registry = createEmptyPluginRegistry();
  const manifest = metadata.plugins[0]!;
  const record = createPluginRecord({
    id: manifest.id,
    rootDir: manifest.rootDir,
    source: manifest.source,
    origin: manifest.origin,
  });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  const input = {
    ...fixture.agentInput("default", config),
    workspaceDir,
    ...(source === "gateway" ? { allowGatewaySubagentBinding: true } : {}),
  };
  if (source === "gateway") {
    bindPluginRuntimeArtifactSelection(record, {
      runtimeEntry: resolvePluginRuntimeArtifactSelection({
        ...manifest,
        entryKind: "runtime",
        preferBuiltPluginArtifacts: false,
      }),
    });
    setPluginRuntimeLoadContext(registry, {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir,
      env: process.env,
      metadataSnapshot: metadata,
      manifestRegistry: metadata.manifestRegistry,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    setActivePluginRegistry(registry, undefined, "gateway-bindable", workspaceDir);
    expect(loadPreparedInboundPluginRegistry(input, metadata)).toBe(registry);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  }
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
    ...(source === "gateway"
      ? { allowGatewaySubagentBinding: true, pluginMetadataSnapshot: metadata }
      : {}),
  });
  const borrower = await acquirePublishedPreparedModelRuntime(input);
  await borrower.snapshot.loadFullModelCatalog?.();
  return { registry, config, input, borrower, instance, metadata };
}

describe("prepared registry construction borrows", () => {
  it("retires a prepared registry after its borrowing request scope has closed", async () => {
    const caller = new AsyncWorkScope();
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "late-catalog-lease", status: "loaded" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    const entered = createDeferred();
    const finish = createDeferred();
    const cleaned = vi.fn();
    instance.lifecycle.onDispose(async () => {
      entered.resolve();
      await finish.promise;
      cleaned();
    });
    const borrower = await caller.track(() => {
      const release = retainPreparedPluginRegistry(registry);
      expect(release).toBeDefined();
      return { release: release!, run: AsyncLocalStorage.snapshot() };
    });
    await caller.drain();
    let retired = false;
    const closing = borrower
      .run(async () => {
        await borrower.release();
      })
      .then(() => {
        retired = true;
      });
    void closing.catch(() => {});
    try {
      await Promise.race([entered.promise, closing]);
      expect(retired).toBe(false);
      finish.resolve();
      await closing;
      expect(cleaned).toHaveBeenCalledOnce();
      expect(retired).toBe(true);
      await expect(caller.track(() => undefined)).rejects.toThrow("Async work scope is closed");
      expect(() => instance.run(() => "retired")).toThrow("reloaded or disabled");
    } finally {
      finish.resolve();
      await closing.catch(() => {});
    }
  });

  it("reacquires a refused source and rejects admission after construction closes", async () => {
    const { registry, borrower, instance } = await acquireConfiguredRegistryBorrower();
    const construction = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    await borrower[Symbol.asyncDispose]();
    const releaseReplacement = instance.reserveReplacement();
    try {
      expect(() => construction.retainRegistry(registry)).toThrow("replacement is in progress");
      releaseReplacement();
      construction.retainRegistry(registry);
      expect(() => instance.reserveReplacement()()).toThrow("active retained work");
      await construction[Symbol.asyncDispose]();
      instance.reserveReplacement()();
      expect(() => construction.retainRegistry(registry)).toThrow(
        "construction resources have been released",
      );
      const loads = mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.length;
      await expect(construction.load({ config: {} }, () => {})).rejects.toThrow(
        "construction resources have been released",
      );
      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(loads);
      markPreparedModelRuntimeSnapshotsStale("construction owner closed");
      expect(isPluginRegistryRetired(registry)).toBe(true);
    } finally {
      releaseReplacement();
      await construction[Symbol.asyncDispose]();
      await borrower[Symbol.asyncDispose]();
    }
  });

  it("retains selected inbound resources until a cancelled initial run inspection settles", async () => {
    const { registry, input, borrower, instance } = await acquireConfiguredRegistryBorrower();
    const inspecting = createDeferred();
    const finishInspection = createDeferred();
    const acquire = runtimePlugins.acquireAgentRuntimePluginRegistry;
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(createEmptyPluginRegistry());
    const inspection = vi
      .spyOn(runtimePlugins, "acquireAgentRuntimePluginRegistry")
      .mockImplementationOnce(async (...args) => {
        const acquired = await acquire(...args);
        inspecting.resolve();
        await finishInspection.promise;
        return acquired;
      });
    const pending = acquireAgentRunPreparedModelRuntime(
      {
        ...input,
        runtimePluginSelections: [{ provider: "custom", modelId: "selected", runtime: "openclaw" }],
      },
      { catalogMode: "static", pluginGeneration: borrower.pluginGeneration },
    );
    const settled = Promise.allSettled([pending]);
    try {
      await Promise.race([
        inspecting.promise,
        pending.then(() => {
          throw new Error("Initial run skipped inspection acquisition");
        }),
      ]);
      markPreparedModelRuntimeSnapshotsStale("configuration replaced during run admission");
      await borrower[Symbol.asyncDispose]();
      expect(isPluginRegistryRetired(registry)).toBe(false);
      expect(() => instance.reserveReplacement()()).toThrow("active retained work");
      finishInspection.resolve();
      await expect(pending).rejects.toThrow("superseded");
      await expect(pending).rejects.toBeInstanceOf(PreparedModelRuntimePublicationSupersededError);
      expect(isPluginRegistryRetired(registry)).toBe(true);
    } finally {
      finishInspection.resolve();
      const [outcome] = await settled;
      if (outcome.status === "fulfilled") {
        await outcome.value[Symbol.asyncDispose]();
      }
      await borrower[Symbol.asyncDispose]();
      inspection.mockRestore();
    }
  });

  it("keeps a cached registry alive while its configured replacement is preparing", async () => {
    const { registry, config, input, borrower, instance } =
      await acquireConfiguredRegistryBorrower();
    const preparing = createDeferred();
    const finishPreparation = createDeferred();
    mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
      preparing.resolve();
      await finishPreparation.promise;
      return { entries: [] };
    });
    const replacement = refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const settled = Promise.allSettled([replacement]);
    try {
      await Promise.race([
        preparing.promise,
        replacement.then(() => {
          throw new Error("Replacement did not enter catalog preparation");
        }),
      ]);
      await borrower[Symbol.asyncDispose]();
      // The build still uses this registry after the final admitted caller releases it.
      expect(() => instance.reserveReplacement()()).toThrow("active retained work");
      finishPreparation.resolve();
      await replacement;
      const published = await prepareModelRuntimeSnapshot(input);
      expect(published).not.toBe(borrower.snapshot);
      expect(published.pluginRegistry).toBe(registry);
      expect(published.config).toBe(config);
      instance.reserveReplacement()();
    } finally {
      finishPreparation.resolve();
      await Promise.allSettled([borrower[Symbol.asyncDispose](), settled]);
    }
  });
  it("does not retire an admitted registry borrower when replacement preparation fails", async () => {
    const { registry, config, borrower } = await acquireConfiguredRegistryBorrower();
    const preparationError = new Error("replacement catalog preparation failed");
    mocks.prepareStaticCatalog.mockRejectedValueOnce(preparationError);
    try {
      await expect(
        refreshPreparedModelRuntimeSnapshots(config, {
          gatewayLifecycle: true,
          catalogMode: "static",
        }),
      ).rejects.toBe(preparationError);
      expect(isPluginRegistryRetired(registry)).toBe(false);
    } finally {
      await borrower[Symbol.asyncDispose]();
    }
    expect(isPluginRegistryRetired(registry)).toBe(true);
  });

  it.each(
    (["run", "configured", "explicit"] as const).flatMap((owner) =>
      (["owned", "gateway"] as const).map((source) => ({ owner, source })),
    ),
  )(
    "keeps $owner/$source busy through post-facts projection, then permits idle replacement",
    async ({ owner, source }) => {
      const { registry, config, input, borrower, instance, metadata } =
        await acquireConfiguredRegistryBorrower(source);
      const projecting = createDeferred();
      const finishProjection = createDeferred();
      mocks.buildPreparedModelCatalogSnapshot.mockImplementationOnce(async () => {
        projecting.resolve();
        await finishProjection.promise;
        return { entries: [], routeVariants: [] };
      });
      let lease: Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>> | undefined;
      const pending =
        owner === "run"
          ? acquireAgentRunPreparedModelRuntime(
              {
                ...input,
                runtimePluginSelections: [
                  { provider: "custom", modelId: "selected", runtime: "openclaw" },
                ],
              },
              { catalogMode: "live", pluginGeneration: borrower.pluginGeneration },
            ).then((acquired) => {
              lease = acquired;
              return acquired.snapshot;
            })
          : owner === "configured"
            ? refreshPreparedModelRuntimeSnapshots(config, {
                gatewayLifecycle: true,
                catalogMode: "live",
                ...(source === "gateway"
                  ? { allowGatewaySubagentBinding: true, pluginMetadataSnapshot: metadata }
                  : {}),
              }).then(() => prepareModelRuntimeSnapshot(input))
            : publishPreparedModelRuntimeSnapshot(input, {
                force: true,
                provenance: "explicit",
                catalogMode: "live",
              });
      const settled = Promise.allSettled([pending]);
      try {
        await Promise.race([
          projecting.promise,
          pending.then(() => {
            throw new Error("Preparation skipped live catalog projection");
          }),
        ]);
        await borrower[Symbol.asyncDispose]();
        expect(isPluginRegistryRetired(registry)).toBe(false);
        expect(() => instance.reserveReplacement()()).toThrow("active retained work");
        finishProjection.resolve();
        const snapshot = await pending;
        expect(snapshot.pluginRegistry).toBe(registry);
        if (lease) {
          expect(() => instance.reserveReplacement()()).toThrow("active retained work");
          await lease[Symbol.asyncDispose]();
        }
        expect(isPluginRegistryRetired(registry)).toBe(false);
        instance.reserveReplacement()();
      } finally {
        finishProjection.resolve();
        await settled;
        await lease?.[Symbol.asyncDispose]();
        await borrower[Symbol.asyncDispose]();
        if (source === "gateway") {
          await clearActivePluginRegistry(registry);
        }
      }
    },
  );
});
