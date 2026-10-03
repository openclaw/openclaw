// Registers a selected memory provider so realtime fast-context tests reach the
// host's real provider acquisition instead of a mocked lookup.
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";

export function registerFastContextMemoryProvider() {
  const search = vi.fn(async () => ({
    hits: [{ reference: { providerId: "records", id: "lights" }, excerpt: "Lights are on." }],
  }));
  const open = vi.fn(async () => ({
    provider: {
      capabilities: {
        sources: ["memory" as const],
        pagination: false,
        candidates: [],
        projectFilter: false,
      },
      search,
      get: async () => ({ status: "not_found" as const }),
      health: async () => ({ status: "ready" as const }),
      close: async () => {},
    },
  }));
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({
    pluginId: "records",
    capability: { providerRuntime: { open } },
  });
  setActivePluginRegistry(registry);
  return { open, search };
}
