import { expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { guardModelFixtureAuth, guardModelFixtureWorkspace } from "./model.fixture.test-support.js";

const discovery = vi.hoisted(() => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));
const hooks = vi.hoisted(() => ({
  applyProviderResolvedTransportWithPlugin: vi.fn(() => {
    throw new Error("transport hook should not run during skipAgentDiscovery");
  }),
  buildProviderUnknownModelHintWithPlugin: vi.fn(() => undefined),
  normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
  normalizeProviderTransportWithPlugin: vi.fn(() => {
    throw new Error("transport normalization hook should not run during skipAgentDiscovery");
  }),
  prepareProviderDynamicModel: vi.fn(async () => undefined),
  runProviderDynamicModel: vi.fn(
    ({ context }: { context: { provider: string; modelId: string } }) =>
      makeProviderModelFixture({
        id: context.modelId,
        provider: context.provider,
        api: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        contextWindow: 8192,
        maxTokens: 1024,
      }),
  ),
  shouldPreferProviderRuntimeResolvedModel: vi.fn(() => false),
}));

// mock-isolation: Discovery spies must observe the skip path without opening real auth or model stores.
vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: discovery.discoverAuthStorage,
  discoverModelsAsync: async (...args: Parameters<typeof discovery.discoverModels>) =>
    discovery.discoverModels(...args),
}));

// mock-isolation: The skip-discovery fixture must exercise only selected dynamic hooks without discovering host auth providers.
vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
  }),
}));

// mock-isolation: Observe target-provider hooks without loading the host provider registry.
vi.mock("../../plugins/provider-runtime.js", () => hooks);

import { resolveModelAsync as resolve } from "./model.js";

it("resolveModelAsync skipAgentDiscovery uses only target-provider dynamic hooks", async () => {
  const state = await createOpenClawTestState({ label: "skip-agent-discovery" });
  const auth = guardModelFixtureAuth(state.root),
    workspace = guardModelFixtureWorkspace(state.root);
  vi.clearAllMocks();
  try {
    const options = { skipAgentDiscovery: true, workspaceDir: state.workspaceDir };
    const result = await resolve("ollama", "llama3.2:latest", state.agentDir(), undefined, options);
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "ollama",
      id: "llama3.2:latest",
      api: "ollama",
    });
    expect(discovery.discoverAuthStorage).not.toHaveBeenCalled();
    expect(discovery.discoverModels).not.toHaveBeenCalled();
    expect(hooks.applyProviderResolvedTransportWithPlugin).not.toHaveBeenCalled();
    expect(hooks.normalizeProviderTransportWithPlugin).not.toHaveBeenCalled();
    const scope = expect.objectContaining({
      workspaceDir: state.workspaceDir,
      context: expect.objectContaining({ workspaceDir: state.workspaceDir }),
    });
    expect(hooks.prepareProviderDynamicModel).toHaveBeenCalledExactlyOnceWith(scope);
    expect(hooks.runProviderDynamicModel).toHaveBeenCalledExactlyOnceWith(scope);
    expect(hooks.normalizeProviderResolvedModelWithPlugin).toHaveBeenCalledExactlyOnceWith(scope);
  } finally {
    try {
      auth.verify();
      workspace.verify();
      expect(auth.spy).toHaveBeenCalled();
    } finally {
      auth.spy.mockRestore();
      workspace.spy.mockRestore();
      await state.cleanup();
    }
  }
});
