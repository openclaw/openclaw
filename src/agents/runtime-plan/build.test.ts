import { createNativeOpenAIResponsesModel } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import {
  resolveProviderFollowupFallbackRoute,
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import { buildAgentRuntimePlan } from "./build.js";

vi.mock("../provider-auth-aliases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provider-auth-aliases.js")>()),
  resolveProviderIdForAuth: (provider: string) => provider,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  clearProviderRuntimePluginCacheForTest: vi.fn(),
  testing: { clearProviderRuntimePluginCacheForTest: vi.fn() },
  ensureProviderRuntimePluginHandle: vi.fn(
    (params) => params.runtimeHandle ?? { provider: "openai" },
  ),
  getModelProviderRuntimePluginHandle: () => undefined,
  resolveProviderAuthProfileId: vi.fn(() => undefined),
  resolveProviderFollowupFallbackRoute: vi.fn(() => undefined),
  resolveProviderPluginsForHooks: vi.fn(() => []),
  resolveProviderRuntimePlugin: vi.fn(() => undefined),
  resolveProviderRuntimePluginHandle: vi.fn(() => ({ provider: "openai" })),
}));

function buildPlan(overrides: Partial<Parameters<typeof buildAgentRuntimePlan>[0]> = {}) {
  return buildAgentRuntimePlan({
    provider: "openai",
    modelId: "gpt-5.4",
    modelApi: "openai-responses",
    config: {},
    workspaceDir: "/tmp/openclaw-runtime-plan",
    model: { ...createNativeOpenAIResponsesModel(), baseUrl: undefined },
    ...overrides,
  });
}

type PreparedHandle = ProviderRuntimePluginHandle & { modelId: string; prepared: true };
function preparedHandle(
  prepareExtraParams?: NonNullable<PreparedHandle["plugin"]>["prepareExtraParams"],
  overrides: Partial<PreparedHandle> = {},
): PreparedHandle {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    prepared: true,
    workspaceDir: "/tmp/openclaw-runtime-plan",
    plugin: prepareExtraParams
      ? { id: overrides.provider ?? "openai", label: "Fixture", auth: [], prepareExtraParams }
      : undefined,
    ...overrides,
  };
}

describe("AgentRuntimePlan", () => {
  afterEach(() => resetConfigRuntimeState());

  it("defers default transport extra params until they are read", () => {
    let calls = 0;
    const prepareExtraParams: NonNullable<PreparedHandle["plugin"]>["prepareExtraParams"] = ({
      auth,
    }) => {
      calls++;
      expect(auth).toEqual({ mode: "oauth", authFlow: "test-subscription" });
      return undefined;
    };
    const plan = buildPlan({
      providerRuntimeHandle: preparedHandle(prepareExtraParams),
      preparedAuthPlan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        selectedAuthMode: "oauth",
        selectedAuthFlow: "test-subscription",
      },
    });

    expect(calls).toBe(0);
    void plan.transport.extraParams;
    expect(calls).toBe(1);
    void plan.transport.extraParams;
    expect(calls).toBe(1);
  });

  it("keeps prepared extra params within their provider generation and attempt", () => {
    const config = { agents: { defaults: { params: { temperature: 0.1 } } } };
    const buildOwnedPlan = (owner: string) =>
      buildAgentRuntimePlan({
        config,
        provider: "fixture-provider",
        modelId: "fixture-model",
        providerRuntimeHandle: preparedHandle(({ extraParams }) => ({ ...extraParams, owner }), {
          provider: "fixture-provider",
          modelId: "fixture-model",
          workspaceDir: undefined,
        }),
      });
    const first = buildOwnedPlan("first");
    expect(first.transport.extraParams).toEqual({ temperature: 0.1, owner: "first" });
    const replacement = buildOwnedPlan("replacement");
    expect(replacement.transport.extraParams).toEqual({ temperature: 0.1, owner: "replacement" });
    config.agents.defaults.params.temperature = 0.7;
    const updated = buildOwnedPlan("updated");
    expect(updated.transport.extraParams).toEqual({ temperature: 0.7, owner: "updated" });
    expect(first.transport.extraParams).toEqual({ temperature: 0.1, owner: "first" });
  });

  it("reuses the provider handle prepared before plan construction", () => {
    vi.mocked(resolveProviderFollowupFallbackRoute).mockClear();

    const suppliedHandle = preparedHandle();

    const plan = buildPlan({ providerRuntimeHandle: suppliedHandle });

    expect(plan.providerRuntimeHandle).toBe(suppliedHandle);

    plan.delivery.resolveFollowupRoute({
      payload: { text: "hello" },
      originRoutable: false,
      dispatcherAvailable: true,
    });

    expect(vi.mocked(resolveProviderFollowupFallbackRoute).mock.lastCall?.[0].runtimeHandle).toBe(
      suppliedHandle,
    );
  });

  it("assembles auth, observability, and prepared metadata without rediscovery", () => {
    const metadataSnapshot = { plugins: [] };
    vi.mocked(resolveProviderRuntimePluginHandle).mockClear();
    const plan = buildPlan({
      metadataSnapshot,
      harnessId: "codex",
      sessionAuthProfileId: "openai:work",
    });
    expect(plan.auth.forwardedAuthProfileId).toBe("openai:work");
    expect(plan.observability).toMatchObject({ resolvedRef: "openai/gpt-5.4", harnessId: "codex" });

    expect(plan.tools.preparedPlanning?.metadataSnapshot).toBe(metadataSnapshot);
    expect(resolveProviderRuntimePluginHandle).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot: metadataSnapshot }),
    );
  });
});
