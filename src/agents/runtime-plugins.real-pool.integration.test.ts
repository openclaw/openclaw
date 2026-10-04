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
import { afterEach, describe, expect, it } from "vitest";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

function writeCountingPlugin(id: string, counterFile: string) {
  return writePlugin({
    id,
    body: `
      const fs = require("node:fs");
      fs.appendFileSync(${JSON.stringify(counterFile)}, ${JSON.stringify(id)} + "\\n");
      module.exports = {
        id: ${JSON.stringify(id)},
        register(api) {
          api.registerGatewayMethod(${JSON.stringify(`${id}.probe`)}, ({ respond }) => respond(true, "ok"));
        },
      };
    `,
  });
}

function loadCountsFromCounterFile(counterFile: string): Record<string, number> {
  if (!fs.existsSync(counterFile)) return {};
  const lines = fs.readFileSync(counterFile, "utf8").split("\n").filter(Boolean);
  const counts: Record<string, number> = {};
  for (const line of lines) counts[line] = (counts[line] ?? 0) + 1;
  return counts;
}

describe("model-catalog: real incremental registry reuse", () => {
  const registries: PluginRegistry[] = [];

  afterEach(async () => {
    for (const registry of registries.splice(0).toReversed()) {
      await disposePluginRegistryInstances(registry);
    }
    resetPluginLoaderTestStateForTest();
  });

  it("does not re-run the real load for already-loaded plugins when a superset is requested", () => {
    useNoBundledPlugins();
    const counterFile = writePlugin({ id: "counter-dir-holder", body: "module.exports = {};" }).dir;
    const counterPath = `${counterFile}/counter.log`;

    const pluginA = writeCountingPlugin("real-pool-a", counterPath);
    const pluginB = writeCountingPlugin("real-pool-b", counterPath);
    const pluginC = writeCountingPlugin("real-pool-c", counterPath);

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
    expect(loadCountsFromCounterFile(counterPath)).toEqual({
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
    expect(loadCountsFromCounterFile(counterPath)).toEqual({
      [pluginA.id]: 1,
      [pluginB.id]: 1,
      [pluginC.id]: 1,
    });
    expect(registryABC.plugins.map((plugin) => plugin.id).toSorted()).toEqual(
      [pluginA.id, pluginB.id, pluginC.id].toSorted(),
    );
  });
});
