import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ProviderRuntimeModel,
  ProviderResolveTransportTurnStateContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createCapturedPluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  GPT5_BEHAVIOR_CONTRACT,
  GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import plugin from "./index.js";

const OPENAI_FRIENDLY_PROMPT_OVERLAY = GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY;
const OPENAI_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;

const runtimeMocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
  };
});

vi.mock("./openai-chatgpt-oauth-flow.runtime.js", () => ({
  refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
}));

const capturedRegistrations: ReturnType<typeof createCapturedPluginRegistration>[] = [];

function registerOpenAIPluginWithHook(params?: { pluginConfig?: Record<string, unknown> }) {
  const captured = createCapturedPluginRegistration({
    id: "openai",
    name: "OpenAI Provider",
    source: "test",
    config: {},
  });
  capturedRegistrations.push(captured);
  const on = vi.fn(captured.api.on);
  const registerHttpRoute = vi.fn(captured.api.registerHttpRoute);
  const registerRuntimeLifecycle = vi.fn(captured.api.lifecycle.registerRuntimeLifecycle);
  plugin.register({
    ...captured.api,
    runtime: {
      config: { current: vi.fn(() => ({})) },
      modelAuth: captured.api.runtime.modelAuth,
    } as never,
    pluginConfig: params?.pluginConfig,
    on,
    registerHttpRoute,
    lifecycle: { ...captured.api.lifecycle, registerRuntimeLifecycle },
  });
  return { on, providers: captured.providers, registerHttpRoute, registerRuntimeLifecycle };
}

type PromptContext = Parameters<NonNullable<ProviderPlugin["resolveSystemPromptContribution"]>>[0];
function promptContribution(provider: ProviderPlugin, overrides: Partial<PromptContext> = {}) {
  return provider.resolveSystemPromptContribution?.({
    config: undefined,
    agentDir: undefined,
    workspaceDir: undefined,
    provider: "openai",
    modelId: "gpt-5.4",
    promptMode: "full",
    runtimeChannel: undefined,
    runtimeCapabilities: undefined,
    agentId: undefined,
    ...overrides,
  });
}

function expectOpenAIPromptContribution(
  provider: ProviderPlugin,
  sectionOverrides: Record<string, unknown>,
  contextOverrides: Partial<PromptContext> = {},
) {
  expect(promptContribution(provider, contextOverrides)).toEqual({
    stablePrefix: OPENAI_GPT5_BEHAVIOR_CONTRACT,
    sectionOverrides,
  });
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      for (const captured of capturedRegistrations.splice(0)) {
        for (const lifecycle of captured.runtimeLifecycles) {
          await lifecycle.cleanup?.({ reason: "disable" });
        }
      }
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("shares one GPT-Live broker across full registrations and ignores late old cleanup", async () => {
    const register = () => {
      const { registerHttpRoute, registerRuntimeLifecycle } = registerOpenAIPluginWithHook();
      expect(registerHttpRoute).toHaveBeenCalledWith({
        path: "/plugins/openai/realtime/calls",
        auth: "plugin",
        match: "exact",
        handler: expect.any(Function),
      });
      expect(registerRuntimeLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "openai-quicksilver-realtime-browser-session",
          cleanup: expect.any(Function),
        }),
      );
      return {
        handler: registerHttpRoute.mock.calls[0]?.[0].handler as unknown,
        cleanup: registerRuntimeLifecycle.mock.calls[0]?.[0].cleanup as (ctx: {
          reason: string;
        }) => Promise<void> | void,
      };
    };

    const first = register();
    const second = register();
    expect(second.handler).toBe(first.handler);

    await first.cleanup({ reason: "disable" });
    const replacement = register();
    expect(replacement.handler).not.toBe(first.handler);

    await second.cleanup({ reason: "disable" });
    const afterLateCleanup = register();
    expect(afterLateCleanup.handler).toBe(replacement.handler);
    await replacement.cleanup({ reason: "disable" });
  });

  it("only cleans up the GPT-Live broker on plugin disable, not session reset/delete/restart", async () => {
    const { registerRuntimeLifecycle } = registerOpenAIPluginWithHook();

    const lifecycle = registerRuntimeLifecycle.mock.calls[0]?.[0] as {
      cleanup: (ctx: { reason: string }) => Promise<void> | void;
    };
    expect(lifecycle).toBeDefined();

    for (const reason of ["reset", "delete", "restart"]) {
      const result = lifecycle.cleanup({ reason });
      expect(result).toBeUndefined();
    }

    const disableResult = lifecycle.cleanup({ reason: "disable" });
    await expect(disableResult).resolves.toBeUndefined();
  });

  it("does not allow private-network routing just because a custom base URL is configured", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider(
      createCapturedPluginRegistration().api.runtime.modelAuth,
    );
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "draw a cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        } satisfies OpenClawConfig,
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bootstraps the env proxy dispatcher before refreshing codex oauth credentials", async () => {
    const refreshed = {
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 60_000,
    };
    runtimeMocks.refreshOpenAICodexToken.mockResolvedValue(refreshed);
    const { providers } = registerOpenAIPluginWithHook();
    const provider = requireRegisteredProvider(providers, "openai");
    await expect(
      provider.refreshOAuth!({
        type: "oauth",
        provider: "openai",
        access: "old-access",
        refresh: "refresh-token",
        expires: 0,
      }),
    ).resolves.toMatchObject(refreshed);

    expect(runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(runtimeMocks.refreshOpenAICodexToken).toHaveBeenCalledOnce();
    expect(runtimeMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
    expect(
      expectDefined(
        runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher.mock.invocationCallOrder[0],
        "OpenAI proxy dispatcher invocation",
      ),
    ).toBeLessThan(
      expectDefined(
        runtimeMocks.refreshOpenAICodexToken.mock.invocationCallOrder[0],
        "OpenAI token refresh invocation",
      ),
    );
  });

  it("registers provider-owned OpenAI tool compat hooks for API and Codex transports", () => {
    const { providers } = registerOpenAIPluginWithHook();
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    const noParamsTool = {
      name: "ping",
      description: "",
      parameters: {},
      execute: vi.fn(),
    } as never;

    for (const [modelApi, baseUrl] of [
      ["openai-responses", "https://api.openai.com/v1"],
      ["openai-chatgpt-responses", "https://chatgpt.com/backend-api"],
    ]) {
      const context = {
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi,
        model: { provider: "openai", api: modelApi, baseUrl, id: "gpt-5.4" },
        tools: [noParamsTool],
      } as never;
      expect(openaiProvider.normalizeToolSchemas?.(context)?.[0]?.parameters).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
      expect(openaiProvider.inspectToolSchemas?.(context)).toStrictEqual([]);
    }
  });

  it.each([
    ["Platform", "https://api.openai.com/v1", undefined, true],
    ["Codex OAuth", "https://chatgpt.com/backend-api/codex", undefined, true],
    ["normalized official endpoint", " https://API.OPENAI.COM./v1/ ", undefined, true],
    ["custom proxy", "https://openai-proxy.example/v1", undefined, false],
    ["opted proxy", "https://openai-proxy.example/v1", true, true],
    ["opted-out Platform", "https://api.openai.com/v1", false, false],
    ["lookalike host", "https://api.openai.com.example/v1", undefined, false],
    ["plaintext official endpoint", "http://api.openai.com/v1", undefined, false],
    ["invalid official path", "https://api.openai.com/not-api", undefined, false],
    ["unresolved route", undefined, undefined, false],
  ] as const)(
    "registers %s cache-TTL eligibility",
    (_name, baseUrl, supportsPromptCacheKey, expected) => {
      const { providers } = registerOpenAIPluginWithHook();
      const provider = requireRegisteredProvider(providers, "openai");
      expect(
        provider.isCacheTtlEligible?.({
          provider: " OPENAI ",
          modelId: "gpt-4o",
          modelApi: baseUrl?.includes("chatgpt.com")
            ? "openai-chatgpt-responses"
            : "openai-responses",
          baseUrl,
          supportsPromptCacheKey,
        }),
      ).toBe(expected);
      expect(
        provider.isCacheTtlEligible?.({
          provider: "openrouter",
          modelId: "openai/gpt-4o",
          baseUrl,
          supportsPromptCacheKey: true,
        }),
      ).toBe(false);
    },
  );

  it("registers GPT-5 system prompt contributions when the friendly overlay is enabled", () => {
    const { on, providers } = registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expect(on.mock.calls.some((call) => call[0] === "before_prompt_build")).toBe(false);

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    const sectionOverrides = { interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY };
    expectOpenAIPromptContribution(openaiProvider, sectionOverrides);
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("Live chat: short, natural, human.");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain(
      "No memo voice, long preamble, wall, repetition.",
    );
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("Grounded emotion when fitting:");
    expect(OPENAI_FRIENDLY_PROMPT_OVERLAY).toContain("Sparse natural emoji ok.");
    expectOpenAIPromptContribution(openaiProvider, sectionOverrides, { trigger: "heartbeat" });
    for (const modelId of ["openai/gpt-5.4-mini", "gpt-6-astra"]) {
      expectOpenAIPromptContribution(openaiProvider, sectionOverrides, { modelId });
    }
    for (const modelId of ["gpt-image-1", "openai/gpt-7-x"]) {
      expect(promptContribution(openaiProvider, { modelId })).toBeUndefined();
    }
  });

  it("treats mixed-case off values as disabling the friendly prompt overlay", () => {
    const { providers } = registerOpenAIPluginWithHook({
      pluginConfig: { personality: "Off" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(openaiProvider, {});
  });

  it("uses live plugin config for GPT-5 prompt overlay mode", () => {
    const { providers } = registerOpenAIPluginWithHook({
      pluginConfig: { personality: "off" },
    });

    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expectOpenAIPromptContribution(
      openaiProvider,
      { interaction_style: OPENAI_FRIENDLY_PROMPT_OVERLAY },
      {
        config: { plugins: { entries: { openai: { config: { personality: "friendly" } } } } },
      },
    );
  });
  const nativeModel = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } satisfies ProviderRuntimeModel;

  function turnState(overrides: Partial<ProviderResolveTransportTurnStateContext>) {
    const { providers } = registerOpenAIPluginWithHook();
    const provider = requireRegisteredProvider(providers, "openai");
    return provider.resolveTransportTurnState?.({
      provider: nativeModel.provider,
      modelId: nativeModel.id,
      model: nativeModel,
      sessionId: "session-123",
      turnId: "turn-123",
      attempt: 2,
      transport: "websocket",
      ...overrides,
    });
  }

  it.each([
    ["openai", "openai-responses", "https://api.openai.com/v1", "websocket"],
    ["openai", "openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "stream"],
    [
      "azure-openai-responses",
      "openai-responses",
      "https://demo.openai.azure.com/openai/v1",
      "websocket",
    ],
    ["openai", "openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "websocket"],
  ] as const)(
    "builds native turn state for %s / %s / %s / %s",
    (provider, api, baseUrl, transport) => {
      const state = turnState({
        provider,
        model: { ...nativeModel, provider, api, baseUrl },
        transport,
      });
      const sessionHeaders = {
        "x-client-request-id": "session-123",
        "x-openclaw-session-id": "session-123",
      };
      expect(state?.headers).toMatchObject({
        ...sessionHeaders,
        "x-openclaw-turn-id": "turn-123",
        "x-openclaw-turn-attempt": "2",
      });
      expect(state?.metadata).toMatchObject({
        openclaw_session_id: "session-123",
        openclaw_turn_id: "turn-123",
        openclaw_turn_attempt: "2",
        openclaw_transport: transport,
      });
      if (transport === "websocket") {
        expect(state?.websocket).toEqual({ headers: sessionHeaders, degradeCooldownMs: 60_000 });
      }
    },
  );

  it("skips turn state for proxy-like OpenAI routes", () => {
    expect(
      turnState({
        model: { ...nativeModel, baseUrl: "https://proxy.example.com/v1" },
        transport: "stream",
      }),
    ).toBeUndefined();
  });
});
