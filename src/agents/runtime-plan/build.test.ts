import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
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

const gpt54Model = { ...createNativeOpenAIResponsesModel(), baseUrl: undefined };
const apiModel = { ...gpt54Model, baseUrl: "https://api.openai.com/v1" };

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

type PreparedHandle = ProviderRuntimePluginHandle & { modelId: string; prepared: true };
function preparedHandle(
  plugin: PreparedHandle["plugin"],
  overrides: Partial<PreparedHandle> = {},
): PreparedHandle {
  return {
    provider: "openai",
    modelId: "gpt-5.4",
    prepared: true,
    workspaceDir: "/tmp/openclaw-runtime-plan",
    plugin,
    ...overrides,
  };
}

describe("AgentRuntimePlan", () => {
  afterEach(() => resetConfigRuntimeState());

  it("defers default transport extra params until they are read", () => {
    const prepareProviderExtraParamsMock = vi.fn(() => undefined);
    const providerRuntimeHandle = preparedHandle({
      id: "openai",
      label: "OpenAI",
      auth: [],
      prepareExtraParams: prepareProviderExtraParamsMock,
    });
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
      const providerRuntimeHandle = preparedHandle(
        {
          id: "fixture-provider",
          label: "Fixture",
          auth: [],
          prepareExtraParams: ({ extraParams }) => ({ ...extraParams, owner }),
        },
        { provider: "fixture-provider", modelId: "fixture-model", workspaceDir: undefined },
      );
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

  it.each(["openclaw", "codex"])(
    "resolves Access defaults for existing sessions in %s",
    (runtime) => {
      const config = (accessPrograms?: Record<string, unknown>) => ({
        agents: { defaults: { params: accessPrograms === undefined ? {} : { accessPrograms } } },
      });
      const build = (accessPrograms?: Record<string, unknown>) =>
        buildPlan({
          config: config(accessPrograms),
          harnessId: runtime,
          harnessRuntime: runtime,
          model: apiModel,
          modelRoute: {
            provider: "openai",
            modelId: "gpt-5.4",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authRequirement: "api-key",
            requestTransportOverrides: "none",
          },
        });
      expect(build().transport.resolveExtraParams().accessPrograms).toEqual({ cyber: "standard" });
      const configured = build({ cyber: "daybreak_blue" });
      expect(configured.transport.resolveExtraParams().accessPrograms).toEqual({
        cyber: "daybreak_blue",
      });
      expect(
        configured.transport.resolveExtraParams({
          extraParamsOverride: { accessPrograms: { cyber: "daybreak_red" } },
        }).accessPrograms,
      ).toEqual({ cyber: "daybreak_red" });
      expect(build({}).transport.resolveExtraParams().accessPrograms).toEqual({});
    },
  );

  it("records auth and observability and resolves transport and prompt policy", () => {
    const plan = buildPlan({
      harnessId: "codex",
      harnessRuntime: "codex",
      authProfileProvider: "openai",
      sessionAuthProfileId: "openai:work",
      model: apiModel,
    });

    expect(plan).toMatchObject({
      auth: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        harnessAuthProvider: "openai",
        forwardedAuthProfileId: "openai:work",
      },
      observability: { resolvedRef: "openai/gpt-5.4", harnessId: "codex" },
    });
    expect(
      plan.transport.resolveExtraParams({
        extraParamsOverride: { parallel_tool_calls: false },
        resolvedTransport: "websocket",
      }),
    ).toMatchObject({
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
  });

  it("keeps OpenClaw-owned tool-schema normalization reachable from the plan", () => {
    const plan = buildPlan({ model: apiModel });
    const normalized = plan.tools.normalize([createParameterFreeTool()] as never);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.name).toBe("ping");
    expect(normalized[0]?.parameters).toStrictEqual({});
  });

  it("reuses the provider handle prepared before plan construction", () => {
    vi.mocked(resolveProviderFollowupFallbackRoute).mockClear();

    const suppliedHandle = preparedHandle(undefined, {
      config: { plugins: { allow: ["openai"] } },
      env: process.env,
    });

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
