import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { withAgentPluginRegistry } from "./runtime-plugins.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);
beforeEach(useNoBundledPlugins);

type Probe = { ticks: number; seen: Record<string, number>; evaluations: number };
const probeKey = "__openclawIngressLoadProbe";

function writeProbePlugin(id: string) {
  // Records the event-loop tick count at module evaluation time.
  return writePlugin({
    id,
    body: `const probe = globalThis[${JSON.stringify(probeKey)}];
probe.seen[${JSON.stringify(id)}] = probe.ticks;
probe.evaluations++;
module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
  });
}

function configFor(plugins: ReturnType<typeof writePlugin>[]): OpenClawConfig {
  return {
    plugins: {
      load: { paths: plugins.map((plugin) => plugin.file) },
      allow: plugins.map((plugin) => plugin.id),
      entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { enabled: true }])),
      slots: { memory: "none" },
    },
  };
}

async function withTicker<T>(run: (probe: Probe) => Promise<T>): Promise<T> {
  const probe: Probe = { ticks: 0, seen: {}, evaluations: 0 };
  Object.assign(globalThis, { [probeKey]: probe });
  let ticking = true;
  const tick = () => {
    if (ticking) {
      probe.ticks++;
      setImmediate(tick);
    }
  };
  setImmediate(tick);
  try {
    return await run(probe);
  } finally {
    ticking = false;
    Reflect.deleteProperty(globalThis, probeKey);
  }
}

it("lets the event loop run between plugins while building an ingress run registry", async () => {
  const first = writeProbePlugin("ingress-load-first");
  const second = writeProbePlugin("ingress-load-second");
  const seen = await withTicker(async (probe) => {
    const loaded = await withAgentPluginRegistry({
      config: configFor([first, second]),
      workspaceDir: makePluginLoaderTempDir(),
      run: async (registry) =>
        registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
    });
    expect(loaded).toEqual(expect.arrayContaining([first.id, second.id]));
    return probe.seen;
  });
  // A synchronous load evaluates every plugin inside one macrotask.
  expect(seen[second.id]).toBeGreaterThan(seen[first.id]!);
});

it("shares one registry load between concurrent ingress runs for the same workspace", async () => {
  const plugin = writeProbePlugin("ingress-load-shared");
  const config = configFor([plugin]);
  const workspaceDir = makePluginLoaderTempDir();
  const { results, evaluations } = await withTicker(async (probe) => {
    const run = () =>
      withAgentPluginRegistry({
        config,
        workspaceDir,
        run: async (registry) =>
          registry.plugins.find((entry) => entry.id === plugin.id)?.status ?? "missing",
      });
    const statuses = await Promise.all([run(), run()]);
    return { results: statuses, evaluations: probe.evaluations };
  });
  expect(results).toEqual(["loaded", "loaded"]);
  expect(evaluations).toBe(1);
});
