// Verifies runtime plugin loading can reuse a compatible gateway startup registry.
import { vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";

const mocks = vi.hoisted(() => ({
  getCurrentPluginMetadataSnapshot: vi.fn(),
  loadOpenClawPlugins: vi.fn<typeof import("../plugins/loader.js").loadOpenClawPlugins>(),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../plugins/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/loader.js")>();
  return {
    ...actual,
    loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
      mocks.loadOpenClawPlugins(...args),
  };
});

function createRegistryWithPlugin(pluginId: string): PluginRegistry {
  // Minimal active registry carrying just enough plugin identity for reuse checks.
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: pluginId,
    status: "loaded",
  } as never);
  return registry;
}
