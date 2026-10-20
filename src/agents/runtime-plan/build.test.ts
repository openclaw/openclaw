import { createParameterFreeTool } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import {
  resolveProviderFollowupFallbackRoute,
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../plugins/provider-hook-runtime.js";
import { buildAgentRuntimePlan } from "./build.js";

const resolveProviderIdForAuth = vi.hoisted(() => vi.fn((provider: string) => provider));

vi.mock("../provider-auth-aliases.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provider-auth-aliases.js")>()),
  resolveProviderIdForAuth,
}));

vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  clearProviderRuntimePluginCacheForTest: vi.fn(),
  testing: {
    clearProviderRuntimePluginCacheForTest: vi.fn(),
  },
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

const gpt54Model = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} as const;

function buildPlan(overrides: Partial<Parameters<typeof buildAgentRuntimePlan>[0]> = {}) {
  return buildAgentRuntimePlan({
    provider: "openai",
    modelId: "gpt-5.4",
    modelApi: "openai-responses",
    config: {},
    workspaceDir: "/tmp/openclaw-runtime-plan",
    model: gpt54Model,
    ...overrides,
  });
}

function latestFollowupRouteCall() {
  const call = vi.mocked(resolveProviderFollowupFallbackRoute).mock.calls.at(-1)?.[0];
  if (!call || typeof call !== "object") {
    throw new Error("expected follow-up route call");
  }
  return call;
}

describe("AgentRuntimePlan", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("defers default transport extra params until they are read", () => {
    const prepareProviderExtraParamsMock = vi.fn(() => undefined);
    const providerRuntimeHandle = {
      provider: "openai",
      modelId: gpt54Model.id,
      workspaceDir: "/tmp/openclaw-runtime-plan",
      prepared: true,
      plugin: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        prepareExtraParams: prepareProviderExtraParamsMock,
      },
    } satisfies ProviderRuntimePluginHandle & { modelId: string; prepared: true };
    const plan = buildPlan({
      providerRuntimeHandle,
      preparedAuthPlan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        selectedAuthMode: "oauth",
        selectedAuthFlow: "test-subscription",
      },
    });

    expect(prepareProviderExtraParamsMock).not.toHaveBeenCalled();
    expect(plan.transport.extraParams).toMatchObject({
      parallel_tool_calls: true,
      text_verbosity: "low",
    });
    expect(prepareProviderExtraParamsMock).toHaveBeenCalledTimes(1);
    expect(prepareProviderExtraParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { mode: "oauth", authFlow: "test-subscription" } }),
    );
    void plan.transport.extraParams;
    expect(prepareProviderExtraParamsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps prepared extra params within their provider generation and attempt", () => {
    const config = { agents: { defaults: { params: { temperature: 0.1 } } } };
    const buildOwnedPlan = (owner: string) => {
      const providerRuntimeHandle = {
        provider: "fixture-provider",
        modelId: "fixture-model",
        prepared: true,
        plugin: {
          id: "fixture-provider",
          label: "Fixture",
          auth: [],
          prepareExtraParams: ({ extraParams }) => ({ ...extraParams, owner }),
        },
      } satisfies ProviderRuntimePluginHandle & { modelId: string; prepared: true };
      return buildAgentRuntimePlan({
        config,
        provider: "fixture-provider",
        modelId: "fixture-model",
        providerRuntimeHandle,
      });
    };
    const first = buildOwnedPlan("first");
    expect(first.transport.extraParams).toEqual({ temperature: 0.1, owner: "first" });
    const replacement = buildOwnedPlan("replacement");
    expect(replacement.transport.extraParams).toEqual({ temperature: 0.1, owner: "replacement" });
    config.agents.defaults.params.temperature = 0.7;
    const updated = buildOwnedPlan("updated");
    expect(updated.transport.extraParams).toEqual({ temperature: 0.7, owner: "updated" });
    expect(first.transport.extraParams).toEqual({ temperature: 0.1, owner: "first" });
  });

  it("records resolved model, auth, transport, tool, delivery, and observability policy", () => {
    const plan = buildPlan({
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai",
      sessionAuthProfileId: "openai:work",
      model: {
        ...gpt54Model,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    expect(plan.auth).toMatchObject({
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      harnessAuthProvider: "openai",
      forwardedAuthProfileId: "openai:work",
    });
    expect(plan.transport.extraParams).toMatchObject({
      parallel_tool_calls: true,
      text_verbosity: "low",
    });
    const resolvedExtraParams = plan.transport.resolveExtraParams({
      extraParamsOverride: { parallel_tool_calls: false },
      resolvedTransport: "websocket",
    });
    expect(resolvedExtraParams).toMatchObject({
      parallel_tool_calls: false,
      text_verbosity: "low",
    });
    expect(
      plan.prompt.resolveSystemPromptContribution({
        provider: "openai",
        modelId: "gpt-5.4",
        promptMode: "full",
      })?.stablePrefix,
    ).toContain("<persona_latch>");
    expect(plan.transcript.resolvePolicy()).toEqual(plan.transcript.policy);
    expect(
      plan.outcome.classifyRunResult({
        provider: "openai",
        model: "gpt-4.1",
        result: {},
      }),
    ).toBeNull();
    expect(plan.observability).toMatchObject({ resolvedRef: "openai/gpt-5.4", harnessId: "codex" });
  });

  it("keeps OpenClaw-owned tool-schema normalization reachable from the plan", () => {
    const plan = buildPlan({
      model: {
        ...gpt54Model,
        baseUrl: "https://api.openai.com/v1",
      },
    });

    const normalized = plan.tools.normalize([createParameterFreeTool()] as never);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.name).toBe("ping");
    expect(normalized[0]?.parameters).toStrictEqual({});
  });

  it("reuses the provider handle prepared before plan construction", () => {
    const resolveProviderFollowupFallbackRouteMock = vi.mocked(
      resolveProviderFollowupFallbackRoute,
    );
    resolveProviderFollowupFallbackRouteMock.mockClear();

    const suppliedHandle: ProviderRuntimePluginHandle & { modelId: string; prepared: true } = {
      provider: "openai",
      modelId: "gpt-5.4",
      prepared: true,
      config: { plugins: { allow: ["openai"] } },
      workspaceDir: "/tmp/openclaw-runtime-plan",
      env: process.env,
      plugin: {} as never,
    };

    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      config: {},
      workspaceDir: "/tmp/openclaw-runtime-plan",
      providerRuntimeHandle: suppliedHandle,
    });

    expect(plan.providerRuntimeHandle).toBe(suppliedHandle);

    plan.delivery.resolveFollowupRoute({
      payload: { text: "hello" },
      originRoutable: false,
      dispatcherAvailable: true,
    });

    const followupCall = latestFollowupRouteCall();
    expect(followupCall.runtimeHandle).toBe(suppliedHandle);
  });

  it("threads prepared tool metadata without discovery", () => {
    const metadataSnapshot = { plugins: [] };
    vi.mocked(resolveProviderRuntimePluginHandle).mockClear();
    resolveProviderIdForAuth.mockClear();
    const plan = buildAgentRuntimePlan({
      provider: "openai",
      modelId: "gpt-5.4",
      metadataSnapshot,
    });

    expect(plan.tools.preparedPlanning?.metadataSnapshot).toBe(metadataSnapshot);
    expect(resolveProviderRuntimePluginHandle).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot: metadataSnapshot }),
    );
    expect(resolveProviderIdForAuth).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ metadataSnapshot }),
    );
  });
});
