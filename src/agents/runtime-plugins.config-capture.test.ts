import { afterEach, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { loadOpenClawPluginsAsync, loadPluginRegistryHandle } from "../plugins/loader.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { prepareWorkspacePluginRegistries } from "./prepared-model-runtime.inbound-registry.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

// mock-isolation: observe the real load plan before plugin code executes.
vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPluginsAsync: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
}));

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.mocked(loadPluginRegistryHandle).mockReset();
  vi.mocked(loadOpenClawPluginsAsync).mockReset();
});

it("carries one captured fleet to every already-enabled runtime load and projects real policy changes", () => {
  const config = captureRuntimeConfig({
    agents: {
      entries: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [`agent-${index}`, { name: `${index}` }]),
      ),
    },
    plugins: {
      allow: ["fleet-owner", "existing"],
      slots: { memory: "none", contextEngine: "fleet-owner" },
      entries: { "fleet-owner": { enabled: true }, existing: { enabled: true } },
    },
  });
  const metadataSnapshot = createPluginMetadataSnapshotFixture(
    makeRegistry(["fleet-owner", "existing", "new-engine"].map((id) => ({ id, channels: [] }))),
    resolveInstalledPluginIndexPolicyHash(config),
  );
  const load = vi.mocked(loadPluginRegistryHandle).mockReturnValue(createEmptyPluginRegistry());
  for (let index = 0; index < 200; index += 1) {
    loadAgentRuntimePluginRegistryHandle({
      config,
      workspaceDir: `/tmp/fleet-${index}`,
      metadataSnapshot,
      basePluginIds: ["fleet-owner"],
      getConfiguredHarnessRuntimes: () => [],
      selections: [],
    });
  }
  expect(load).toHaveBeenCalledTimes(200);
  for (const [options] of load.mock.calls) {
    expect(options?.config).toBe(config);
    expect(options?.activationSourceConfig).toBe(config);
  }

  const changed = captureRuntimeConfig({
    ...config,
    plugins: {
      ...config.plugins,
      allow: [" fleet-owner ", "fleet-owner", "existing"],
      slots: { memory: "none", contextEngine: "new-engine" },
    },
  });
  loadAgentRuntimePluginRegistryHandle({
    config: changed,
    workspaceDir: "/tmp/fleet-changed",
    metadataSnapshot,
    basePluginIds: ["fleet-owner"],
    getConfiguredHarnessRuntimes: () => [],
    selections: [],
  });
  const projected = load.mock.calls.at(-1)?.[0]?.config;
  expect(projected).not.toBe(changed);
  expect(projected?.plugins?.allow).toEqual(["fleet-owner", "existing", "new-engine"]);
  expect(projected?.plugins?.entries?.["new-engine"]).toEqual({ enabled: true });
  expect(projected?.agents).toBe(changed.agents);
  expect(changed.plugins?.allow).toEqual([" fleet-owner ", "fleet-owner", "existing"]);
  expect(changed.plugins?.entries?.["new-engine"]).toBeUndefined();
});

it.each([
  ["agent", 1, ["configured-harness", "selected-harness"]],
  ["isolated-completion", 0, ["selected-harness"]],
  ["model-catalog", 0, []],
] as const)(
  "reads configured harnesses only when the %s plan uses them",
  async (purpose, calls, ids) => {
    const harnesses = ["configured-harness", "selected-harness"];
    const config = {
      plugins: {
        allow: harnesses,
        slots: { memory: "none" },
        entries: Object.fromEntries(harnesses.map((id) => [id, { enabled: true }])),
      },
    };
    const metadata = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry(
        harnesses.map((id) => ({ id, channels: [], activation: { onAgentHarnesses: [id] } })),
      ),
    });
    const configured = vi.fn(() => ["configured-harness"]);
    const load = vi.mocked(loadOpenClawPluginsAsync).mockResolvedValue(createEmptyPluginRegistry());
    await prepareWorkspacePluginRegistries(
      {
        agentDir: "/fixture/agent",
        config,
        loadRuntimePlugins: true,
        runtimePluginPurpose: purpose,
        runtimePluginSelections: [{ provider: "", modelId: "", runtime: "selected-harness" }],
      },
      metadata,
      () => {},
      undefined,
      false,
      undefined,
      configured,
    );
    expect(configured).toHaveBeenCalledTimes(calls);
    expect(load.mock.lastCall?.[0]?.onlyPluginIds).toEqual(ids);
  },
);
