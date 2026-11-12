import { expect, it } from "vitest";
import { bindPluginMetadataSnapshotCache, createPluginCache } from "../plugins/plugin-cache.js";
import { pluginInvocationContext } from "../plugins/plugin-instance-scope.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withPreparedModelCatalogPluginScope } from "./prepared-model-runtime.catalog-auth.js";
import type { PreparedModelRuntimePluginGeneration } from "./prepared-model-runtime.types.js";
import { createRuntimePluginWork } from "./runtime-plugin-work.js";

it.each([false, true])(
  "retains exact catalog work through physical cleanup (parent: %s)",
  async (nested) => {
    await using cache = createPluginCache();
    const metadata = createPluginMetadataSnapshotFixture({ plugins: [] });
    bindPluginMetadataSnapshotCache(metadata, cache);
    const registry = createEmptyPluginRegistry();
    const selected = new PluginInstance("catalog-provider");
    const unrelated = new PluginInstance("catalog-provider");
    const callback = selected.wrap(() => "selected");
    registry.contextEngines.set("unrelated", {
      factory: unrelated.wrap(() => {
        throw new Error("must not execute");
      }),
      owner: "plugin:catalog-provider",
      lifecycle: "runtime",
    });
    const cleanupStarted = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const resources = new PluginRegistryInspectionResources(async () => {
      expect(selected.retainedWorkCount).toBeGreaterThan(0);
      expect(unrelated.retainedWorkCount).toBe(0);
      cleanupStarted.resolve();
      await finishCleanup.promise;
    });
    resources.attach(registry);
    const generation: PreparedModelRuntimePluginGeneration = {
      remoteCatalog: null,
      pluginMetadataSnapshot: metadata,
      pluginRegistry: registry,
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    };
    const parentWork = createRuntimePluginWork();
    const parent = new PluginInvocationScope(registry, [], { work: parentWork });
    const run = () =>
      withPreparedModelCatalogPluginScope(generation, async () => {
        // Resolving a delayed callback, rather than invoking it, must establish custody.
        const context = pluginInvocationContext.getStore()!;
        context.lookup(selected);
        expect(context.retainedInstances).toContain(selected);
        expect(context.retainedInstances).not.toContain(unrelated);
        expect(selected.retainedWorkCount).toBeGreaterThan(0);
        expect(unrelated.retainedWorkCount).toBe(0);
        await Promise.resolve();
        expect(callback()).toBe("selected");
        await resources.release();
      });
    const pending = nested ? parent.run(run) : run();
    try {
      await cleanupStarted.promise;
      expect(selected.retainedWorkCount).toBeGreaterThan(0);
      expect(unrelated.retainedWorkCount).toBe(0);
      finishCleanup.resolve();
      await pending;
      expect(selected.retainedWorkCount).toBe(nested ? 1 : 0);
      expect(unrelated.retainedWorkCount).toBe(0);
    } finally {
      finishCleanup.resolve();
      await pending;
      parent.release();
      parentWork.release();
      await resources.release();
      await Promise.all([selected.dispose(), unrelated.dispose()]);
    }
  },
);
