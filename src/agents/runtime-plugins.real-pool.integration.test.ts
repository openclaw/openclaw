// Proves the ACTUAL benefit of the superset path wired into
// `resolveAgentRuntimePluginRegistryLoad` (runtime-plugins.ts): once plugins A and B are loaded
// into a cumulative model-catalog registry, a follow-up request needing A+B+C must not re-run the
// real (expensive) module-load work for A or B -- only C's real load should execute. Unlike
// `runtime-plugins.real-pool.test.ts` (which mocks `loadPluginRegistryHandle`/
// `loadOpenClawPluginsCore` entirely and only proves the id-set decision logic), this test runs
// the REAL loader (`loadAgentRuntimePluginRegistryHandle` -> `loadPluginRegistryHandle` ->
// `loadOpenClawPluginsCore`) against real on-disk plugin fixtures, and observes real module-load
// side effects (a counter file each plugin's module body writes to on every real execution) to
// prove the underlying `previousRegistry`-driven incremental-reuse mechanism
// (`projectPluginContributions` in loader-runtime-core.ts) is actually reached and actually skips
// unchanged plugins -- not just that the id bookkeeping looks right.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

const counterKeys: symbol[] = [];
let nextCounterKey = 0;

function createCounterKey(): string {
  const counterKey = `openclaw.test.real-pool.${process.pid}.${nextCounterKey++}`;
  const symbol = Symbol.for(counterKey);
  counterKeys.push(symbol);
  delete (globalThis as Record<symbol, unknown>)[symbol];
  return counterKey;
}

function writeCountingPlugin(id: string, counterKey: string) {
  return writePlugin({
    id,
    body: `
      const counterKey = Symbol.for(${JSON.stringify(counterKey)});
      const counts = globalThis[counterKey] || (globalThis[counterKey] = Object.create(null));
      counts[${JSON.stringify(id)}] = (counts[${JSON.stringify(id)}] || 0) + 1;
      module.exports = {
        id: ${JSON.stringify(id)},
        register(api) {
          api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => respond(true, "ok"));
        },
      };
    `,
  });
}

function loadCountsFromCounterKey(counterKey: string): Record<string, number> {
  return {
    ...((globalThis as Record<symbol, Record<string, number> | undefined>)[
      Symbol.for(counterKey)
    ] ?? {}),
  };
}

describe("model-catalog: real incremental registry reuse", () => {
  const registries: PluginRegistry[] = [];

  afterEach(async () => {
    for (const registry of registries.splice(0).toReversed()) {
      await disposePluginRegistryInstances(registry);
    }
    for (const counterKey of counterKeys.splice(0)) {
      delete (globalThis as Record<symbol, unknown>)[counterKey];
    }
    resetPluginLoaderTestStateForTest();
  });

  it("loads plugin modules when snapshot and discovery source spellings differ", () => {
    useNoBundledPlugins();
    const counterKey = createCounterKey();
    const plugin = writeCountingPlugin("real-pool-source-spelling", counterKey);
    const aliasFile = path.join(plugin.dir, "source-spelling-alias.cjs");
    try {
      fs.symlinkSync(path.basename(plugin.file), aliasFile);
    } catch {
      return;
    }
    const config = {
      plugins: {
        allow: [plugin.id],
        load: { paths: [aliasFile] },
        slots: { memory: "none" as const },
      },
    };
    const snapshot = loadPluginMetadataSnapshot({ config });
    const aliasedRecord = snapshot.manifestRegistry.plugins.find(
      (record) => record.id === plugin.id,
    );
    expect(aliasedRecord?.source).toBe(aliasFile);
    const metadataSnapshot = {
      ...snapshot,
      manifestRegistry: {
        ...snapshot.manifestRegistry,
        plugins: snapshot.manifestRegistry.plugins.map((record) =>
          record.id === plugin.id ? { ...record, source: fs.realpathSync(record.source) } : record,
        ),
      },
    };

    const registry = loadAgentRuntimePluginRegistryHandle({
      config,
      basePluginIds: [plugin.id],
      metadataSnapshot,
      purpose: "model-catalog",
    });
    registries.push(registry);

    expect(loadCountsFromCounterKey(counterKey)).toEqual({ [plugin.id]: 1 });
  });

  it("does not re-run the real load for already-loaded plugins when a superset is requested", () => {
    useNoBundledPlugins();
    const counterKey = createCounterKey();

    const pluginA = writeCountingPlugin("real-pool-a", counterKey);
    const pluginB = writeCountingPlugin("real-pool-b", counterKey);
    const pluginC = writeCountingPlugin("real-pool-c", counterKey);

    const baseConfig = (ids: string[], files: string[]) => ({
      plugins: {
        allow: ids,
        load: { paths: files },
        slots: { memory: "none" as const },
      },
    });

    // Step 1: load A+B only. Real load must run once each for A and B.
    const registryAB = loadAgentRuntimePluginRegistryHandle({
      config: baseConfig([pluginA.id, pluginB.id], [pluginA.file, pluginB.file]),
      basePluginIds: [pluginA.id, pluginB.id],
      purpose: "model-catalog",
    });
    registries.push(registryAB);
    expect(loadCountsFromCounterKey(counterKey)).toEqual({
      [pluginA.id]: 1,
      [pluginB.id]: 1,
    });

    // Step 2: request A+B+C (a superset), passing the A+B registry as `reusableRegistry`.
    // This must thread `previousRegistry` through so the real loader retains A and B by
    // signature match and only really loads C.
    const registryABC = loadAgentRuntimePluginRegistryHandle({
      config: baseConfig(
        [pluginA.id, pluginB.id, pluginC.id],
        [pluginA.file, pluginB.file, pluginC.file],
      ),
      basePluginIds: [pluginA.id, pluginB.id, pluginC.id],
      reusableRegistry: registryAB,
      purpose: "model-catalog",
    });
    registries.push(registryABC);

    // The key assertion: A and B's real module load did NOT execute a second time; only C's did.
    expect(loadCountsFromCounterKey(counterKey)).toEqual({
      [pluginA.id]: 1,
      [pluginB.id]: 1,
      [pluginC.id]: 1,
    });
    expect(registryABC.plugins.map((plugin) => plugin.id).toSorted()).toEqual(
      [pluginA.id, pluginB.id, pluginC.id].toSorted(),
    );
  });
});
