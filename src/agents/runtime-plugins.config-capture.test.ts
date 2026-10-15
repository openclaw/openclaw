import { afterEach, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

vi.mock("../plugins/loader.js", () => ({ loadPluginRegistryHandle: vi.fn() }));

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.mocked(loadPluginRegistryHandle).mockReset();
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
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: makeRegistry(
      ["fleet-owner", "existing", "new-engine"].map((id) => ({ id, channels: [] })),
    ),
  });
  const load = vi.mocked(loadPluginRegistryHandle).mockReturnValue(createEmptyPluginRegistry());
  for (let index = 0; index < 200; index += 1) {
    loadAgentRuntimePluginRegistryHandle({
      config,
      workspaceDir: `/tmp/fleet-${index}`,
      metadataSnapshot,
      basePluginIds: ["fleet-owner"],
      configuredHarnessRuntimes: [],
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
    configuredHarnessRuntimes: [],
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
