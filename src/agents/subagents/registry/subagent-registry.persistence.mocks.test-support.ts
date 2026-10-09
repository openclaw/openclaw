import { vi } from "vitest";

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn<
    typeof import("../../../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd
  >(async () => {}),
}));

vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<
      typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle
    >(() => createEmptyPluginRegistry()),
  };
});

vi.mock("./subagent-registry.runtime.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn<typeof import("./subagent-registry.runtime.js").resolveContextEngine>(
    async () => ({
      info: { id: "test", name: "Test", version: "0.0.1" },
      ingest: async () => ({ ingested: false }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: async () => ({ ok: false, compacted: false }),
    }),
  ),
}));

vi.mock("../../timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn<typeof import("../../timeout.js").resolveAgentTimeoutMs>(() => 100),
}));
