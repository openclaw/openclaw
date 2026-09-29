// Coverage for registry-backed model forward-compatibility fallbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { guardModelFixtureAuth } from "./model.fixture.test-support.js";
import { expectResolvedForwardCompatFallbackWithRegistryResult } from "./model.forward-compat.test-support.js";
import { createEmptyAgentDiscoveryStores, resolveModelWithRegistry } from "./model.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

let state: OpenClawTestState;
let auth: ReturnType<typeof guardModelFixtureAuth>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "model-forward-compat" });
  auth = guardModelFixtureAuth(state.root);
});
afterEach(async () => {
  try {
    auth.verify();
    expect(auth.spy).toHaveBeenCalled();
  } finally {
    auth.spy.mockRestore();
    await state.cleanup();
  }
});

vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: () => undefined,
  buildProviderUnknownModelHintWithPlugin: () => undefined,
  normalizeProviderResolvedModelWithPlugin: () => undefined,
  normalizeProviderTransportWithPlugin: () => undefined,
  prepareProviderDynamicModel: async () => undefined,
  runProviderDynamicModel: () => undefined,
  shouldPreferProviderRuntimeResolvedModel: () => false,
}));

describe("resolveModel forward-compat tail", () => {
  it("preserves the claude-cli provider for anthropic forward-compat fallback models", async () => {
    const { modelRegistry } = createEmptyAgentDiscoveryStores();
    const result = await resolveModelWithRegistry({
      provider: "claude-cli",
      modelId: "claude-sonnet-4-6",
      agentDir: state.agentDir(),
      modelRegistry,
      runtimeHooks: createProviderRuntimeTestMock({ handledDynamicProviders: ["claude-cli"] }),
    });
    expectResolvedForwardCompatFallbackWithRegistryResult({
      result,
      expectedModel: {
        provider: "claude-cli",
        id: "claude-sonnet-4-6",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
      },
    });
  });
});
