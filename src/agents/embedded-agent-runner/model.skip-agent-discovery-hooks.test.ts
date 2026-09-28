// Coverage for resolving models through provider hooks while discovery is skipped.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { guardModelFixtureAuth, guardModelFixtureWorkspace } from "./model.fixture.test-support.js";

let state: OpenClawTestState;
let auth: ReturnType<typeof guardModelFixtureAuth>;
let workspace: ReturnType<typeof guardModelFixtureWorkspace>;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "skip-agent-discovery" });
  auth = guardModelFixtureAuth(state.root);
  workspace = guardModelFixtureWorkspace(state.root);
});
afterEach(async () => {
  try {
    auth.verify();
    workspace.verify();
    expect(auth.spy).toHaveBeenCalled();
  } finally {
    auth.spy.mockRestore();
    workspace.spy.mockRestore();
    await state.cleanup();
  }
});

const mocks = vi.hoisted(() => ({
  // Discovery mocks throw/assert by call count so skipAgentDiscovery can prove it
  // only invokes the target provider's dynamic hooks.
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
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
    ({ context }: { context: { provider: string; modelId: string } }) => ({
      id: context.modelId,
      name: context.modelId,
      provider: context.provider,
      api: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    }),
  ),
  shouldPreferProviderRuntimeResolvedModel: vi.fn(() => false),
}));

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: mocks.discoverAuthStorage,
  discoverModels: mocks.discoverModels,
}));

vi.mock("../../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  applyProviderResolvedTransportWithPlugin: mocks.applyProviderResolvedTransportWithPlugin,
  buildProviderUnknownModelHintWithPlugin: mocks.buildProviderUnknownModelHintWithPlugin,
  normalizeProviderResolvedModelWithPlugin: mocks.normalizeProviderResolvedModelWithPlugin,
  normalizeProviderTransportWithPlugin: mocks.normalizeProviderTransportWithPlugin,
  prepareProviderDynamicModel: mocks.prepareProviderDynamicModel,
  runProviderDynamicModel: mocks.runProviderDynamicModel,
  shouldPreferProviderRuntimeResolvedModel: mocks.shouldPreferProviderRuntimeResolvedModel,
}));

let resolveModelAsync: typeof import("./model.js").resolveModelAsync;

function expectWorkspaceHookCall(mock: { mock: { calls: unknown[][] } }) {
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      workspaceDir: state.workspaceDir,
      context: expect.objectContaining({ workspaceDir: state.workspaceDir }),
    }),
  );
}

beforeAll(async () => {
  ({ resolveModelAsync } = await import("./model.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveModelAsync skipAgentDiscovery runtime hooks", () => {
  it("uses only target-provider dynamic hooks", async () => {
    const result = await resolveModelAsync(
      "ollama",
      "llama3.2:latest",
      state.agentDir(),
      undefined,
      {
        skipAgentDiscovery: true,
        workspaceDir: state.workspaceDir,
      },
    );

    expect(result.error).toBeUndefined();
    if (!result.model) {
      throw new Error("Expected resolved model");
    }
    expect(result.model.provider).toBe("ollama");
    expect(result.model.id).toBe("llama3.2:latest");
    expect(result.model.api).toBe("ollama");
    expect(mocks.discoverAuthStorage).not.toHaveBeenCalled();
    expect(mocks.discoverModels).not.toHaveBeenCalled();
    expectWorkspaceHookCall(mocks.prepareProviderDynamicModel);
    expectWorkspaceHookCall(mocks.runProviderDynamicModel);
    expectWorkspaceHookCall(mocks.normalizeProviderResolvedModelWithPlugin);
    expect(mocks.applyProviderResolvedTransportWithPlugin).not.toHaveBeenCalled();
    expect(mocks.normalizeProviderTransportWithPlugin).not.toHaveBeenCalled();
  });
});
