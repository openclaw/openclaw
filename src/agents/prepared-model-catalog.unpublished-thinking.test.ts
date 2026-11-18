import { expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadProviderScopedThinkingCatalog } from "./prepared-model-catalog.js";

const discovery = vi.hoisted(() => vi.fn(() => []));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: discovery,
}));

it.each([
  { provider: "anthropic", model: "claude-sonnet-5" },
  { provider: "ollama", model: "catalog-probe:latest" },
])("keeps unpublished $provider thinking reads off provider discovery", async (ref) => {
  const state = await createOpenClawTestState({ label: "unpublished-thinking" });
  try {
    const catalog = await loadProviderScopedThinkingCatalog({
      config: {},
      agentId: "main",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      ...ref,
    });

    expect(discovery).not.toHaveBeenCalled();
    expect(catalog).toEqual([]);
  } finally {
    await state.cleanup();
  }
});
