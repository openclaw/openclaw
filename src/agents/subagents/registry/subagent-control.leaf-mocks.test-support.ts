import { vi } from "vitest";
import type { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";

vi.mock("../../../browser-lifecycle-cleanup.js", { spy: true });
vi.mock("../../../context-engine/init.js", { spy: true });
vi.mock("../../../context-engine/registry.js", { spy: true });
vi.mock("../../runtime-plugins.js", async () => {
  const { getActivePluginRegistry } = await import("../../../plugins/runtime.js");
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<typeof loadAgentRuntimePluginRegistryHandle>(
      () => getActivePluginRegistry() ?? createEmptyPluginRegistry(),
    ),
  };
});
vi.mock("./subagent-registry-state.js", { spy: true });
