import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model, SimpleStreamOptions } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENAI_API_BASE_URL,
  OPENAI_CODEX_MODELS_ENDPOINT as OPENAI_CODEX_MODELS_URL,
  OPENAI_CODEX_RESPONSES_BASE_URL,
} from "./base-url.js";
import { OPENAI_DEFAULT_MODEL } from "./default-models.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { registerOpenAIServiceTierCatalogTests } from "./test-support/model-service-tiers.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadata: vi.fn(),
}));

type OpenAITestCatalogResult = {
  provider: ModelProviderConfig;
  outcomes: readonly {
    provider: string;
    profileId?: string;
    rejectionScope?: "catalog";
    status: "ready" | "auth-rejected" | "unavailable";
  }[];
};

async function runCatalogWithFetchGuard(params: {
  fetchGuard: LiveModelCatalogFetchGuard;
  auth: {
    mode: "api_key" | "oauth" | "token";
    apiKey: string;
    discoveryApiKey?: string;
    profileId?: string;
    authFlow?: string;
    source: string;
  };
  accountId?: string;
  baseUrl?: string;
}): Promise<OpenAITestCatalogResult> {
  if (params.auth.mode === "oauth") {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      ...params.auth,
      source: params.auth.source,
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: params.auth.profileId,
      accountId: params.accountId,
    });
  }
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const guarded = await params.fetchGuard({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    await guarded.release();
    return guarded.response;
  });
  try {
    const result = await buildOpenAIProvider().catalog?.run({
      resolveProviderAuth: () => params.auth,
      resolveProviderApiKey: () => ({
        apiKey: params.auth.apiKey,
        discoveryApiKey: params.auth.discoveryApiKey,
      }),
      config: params.baseUrl
        ? { models: { providers: { openai: { baseUrl: params.baseUrl, models: [] } } } }
        : { auth: { profiles: {} } },
      agentDir: "/tmp/openai-agent",
      workspaceDir: "/tmp/openai-workspace",
    } as never);
    if (!result || "provider" in result || !result.providers.openai) {
      throw new Error("expected OpenAI live provider catalog");
    }
    return { provider: result.providers.openai, outcomes: result.outcomes ?? [] };
  } finally {
    fetchSpy.mockRestore();
  }
}

async function buildOpenAICodexLiveProviderConfig(params: {
  discoveryApiKey: string;
  accountId?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  return (
    await runCatalogWithFetchGuard({
      fetchGuard: params.fetchGuard,
      auth: {
        mode: "oauth",
        apiKey: params.discoveryApiKey,
        profileId: "openai:chatgpt",
        source: "profile",
      },
      accountId: params.accountId,
    })
  ).provider;
}

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveProviderAuthProfileMetadata: mocks.resolveProviderAuthProfileMetadata,
}));

async function runWrappedPayloadCase(params: {
  wrap: NonNullable<ReturnType<typeof buildOpenAIProvider>["wrapStreamFn"]>;
  provider: string;
  modelId: string;
  model:
    | Model<"openai-responses">
    | Model<"openai-chatgpt-responses">
    | Model<"azure-openai-responses">;
  extraParams?: Record<string, unknown>;
  cfg?: Record<string, unknown>;
  agentId?: string;
  nativeWebSearchAllowedByToolPolicy?: boolean;
  payload?: Record<string, unknown>;
  context?: Context;
  streamOptions?: SimpleStreamOptions & {
    openclawCodeModeToolSurface?: boolean;
    openclawCodeModeAllowedHostedToolTypes?: Set<string>;
  };
}) {
  const payload = params.payload ?? { store: false };
  let capturedOptions: SimpleStreamOptions | undefined;
  const baseStreamFn: StreamFn = (model, _context, options) => {
    capturedOptions = options;
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const streamFn = params.wrap({
    provider: params.provider,
    modelId: params.modelId,
    extraParams: params.extraParams,
    config: params.cfg as never,
    agentDir: "/tmp/openai-provider-test",
    agentId: params.agentId,
    nativeWebSearchAllowedByToolPolicy: params.nativeWebSearchAllowedByToolPolicy,
    streamFn: baseStreamFn,
  } as never);

  await streamFn?.(params.model, params.context ?? { messages: [] }, params.streamOptions ?? {});

  return {
    payload,
    options: capturedOptions,
  };
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function expectCatalogEntry(entries: unknown, id: string, expected: Record<string, unknown>): void {
  expect(Array.isArray(entries)).toBe(true);
  const entry = (entries as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === id,
  );
  expectFields(entry, expected);
}

function expectNoCatalogEntry(entries: unknown, id: string): void {
  expect(Array.isArray(entries)).toBe(true);
  const entryIds = new Set((entries as Array<Record<string, unknown>>).map((entry) => entry.id));
  expect(entryIds.has(id)).toBe(false);
}

describe("buildOpenAIProvider", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    mocks.resolveApiKeyForProvider.mockReset();
    mocks.resolveProviderAuthProfileMetadata.mockReset();
  });

  it("preserves existing model selection during non-interactive API key setup", async () => {
    const provider = buildOpenAIProvider();
    const apiKey = provider.auth.find((method) => method.id === "api-key");
    if (!apiKey?.runNonInteractive) {
      throw new Error("expected OpenAI API key non-interactive auth");
    }
    const primaryModel = "anthropic/claude-opus-4-6";
    const fallbackModel = "openai/gpt-5.5";

    const next = await apiKey.runNonInteractive({
      config: {
        agents: {
          defaults: {
            model: { primary: primaryModel, fallbacks: [fallbackModel] },
            models: {
              [primaryModel]: { alias: "Primary" },
              [fallbackModel]: { alias: "Fallback" },
            },
          },
        },
      },
      opts: {},
      env: {},
      runtime: {},
      resolveApiKey: async () => ({ key: "sk-test", source: "profile" }),
      toApiKeyCredential: () => null,
    } as never);

    expect(next?.agents?.defaults?.model).toEqual({
      primary: primaryModel,
      fallbacks: [fallbackModel],
    });
    expect(next?.agents?.defaults?.models).toMatchObject({
      [primaryModel]: { alias: "Primary" },
      [fallbackModel]: { alias: "Fallback" },
      [OPENAI_DEFAULT_MODEL]: { alias: "GPT" },
    });
  });

  it("classifies OpenAI-native code-only failover errors", () => {
    const provider = buildOpenAIProvider();

    for (const providerId of ["openai", "azure-openai", "azure-openai-responses"]) {
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          code: "SERVER_ERROR",
        }),
      ).toBe("server_error");
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          code: "INSUFFICIENT_QUOTA",
        }),
      ).toBe("billing");
    }
    // API_ERROR is an Anthropic-native code, not OpenAI's: fall through to generic.
    expect(
      provider.classifyFailoverReason?.({
        provider: "openai",
        errorMessage: "",
        code: "API_ERROR",
      }),
    ).toBeUndefined();
  });

  it("does not hardcode transport routing on static catalog entries (#91710)", () => {
    const openaiModels = manifest.modelCatalog.providers.openai.models as Array<
      Record<string, unknown>
    >;
    expect(openaiModels.length).toBeGreaterThan(0);
    // Transport selection is runtime-owned; a manifest row pinning api/baseUrl
    // would bypass route policy (the original #91710 regression).
    for (const entry of openaiModels) {
      expect(entry.api, `catalog row ${String(entry.id)} must not pin api`).toBeUndefined();
      expect(entry.baseUrl, `catalog row ${String(entry.id)} must not pin baseUrl`).toBeUndefined();
    }
  });

  it("scopes the OpenAI API-key catalog to the OpenAI provider id", async () => {
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [{ id: "gpt-5.5", object: "model" }],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        providerIds: ["openai"],
        resolveProviderAuth: () => ({
          mode: "api_key",
          apiKey: "sk-openai",
          discoveryApiKey: "sk-discovery",
          source: "profile",
        }),
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI live provider catalog");
      }
      expect(Object.keys(result.providers)).toEqual(["openai"]);
      expect(result.providers.openai?.apiKey).toBe("sk-openai");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const fetchInit = fetchSpy.mock.calls[0]?.[1];
      const headers = fetchInit?.headers;
      expect(headers).toBeInstanceOf(Headers);
      if (!(headers instanceof Headers)) {
        throw new Error("expected fetch headers");
      }
      expect(headers.get("Authorization")).toBe("Bearer sk-discovery");
      expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(["azure-openai-responses"])(
    "does not resolve OpenAI credentials or fetch for %s-only catalog scope",
    async (providerId) => {
      const provider = buildOpenAIProvider();
      const resolveProviderAuth = vi.fn(() => ({
        mode: "api_key" as const,
        apiKey: "sk-openai",
        source: "profile" as const,
      }));
      const resolveProviderApiKey = vi.fn(() => ({ apiKey: "sk-openai" }));
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ data: [{ id: "gpt-5.5", object: "model" }] }));

      try {
        await expect(
          provider.catalog?.run({
            providerIds: [providerId],
            resolveProviderAuth,
            resolveProviderApiKey,
            config: {},
            env: {},
          }),
        ).resolves.toBeNull();
        expect(resolveProviderAuth).not.toHaveBeenCalled();
        expect(resolveProviderApiKey).not.toHaveBeenCalled();
        expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it("keeps locked OAuth resolution failures on the selected profile", async () => {
    mocks.resolveApiKeyForProvider.mockRejectedValue(new Error("expired oauth profile"));
    const provider = buildOpenAIProvider();
    const resolveProviderApiKey = vi.fn(() => ({
      apiKey: "sk-openai",
      discoveryApiKey: "sk-discovery",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [{ id: "gpt-5.5", object: "model" }],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "oauth",
          apiKey: "stale-oauth-token",
          profileId: "openai:chatgpt",
          source: "profile",
        }),
        resolveProviderApiKey,
        config: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI live provider catalog");
      }
      expect(result.providers.openai?.api).toBe("openai-chatgpt-responses");
      expect(result.providers.openai?.auth).toBe("oauth");
      expect(result.providers.openai?.apiKey).toBeUndefined();
      expect(result.outcomes).toEqual([
        { provider: "openai", profileId: "openai:chatgpt", status: "unavailable" },
      ]);
      expect(resolveProviderApiKey).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses a locked runtime key without exposing the selected SecretRef profile", async () => {
    const profileId = "openai:secretref";
    const runtimeKey = "sk-runtime-secretref";
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      apiKey: runtimeKey,
      profileId,
      source: `profile:${profileId}`,
      mode: "api-key",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: [{ id: "gpt-5.5", object: "model" }] }));

    try {
      const result = await buildOpenAIProvider().catalog?.run({
        resolveProviderAuth: () => ({
          mode: "api_key",
          apiKey: "secretref-managed",
          profileId,
          source: "profile",
        }),
        resolveProviderApiKey: vi.fn(),
        config: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI live provider catalog");
      }
      expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${runtimeKey}`,
      );
      expect(result.providers.openai?.apiKey).toBe("secretref-managed");
      expect(JSON.stringify(result)).not.toContain(runtimeKey);
      expect(result.outcomes).toEqual([{ provider: "openai", profileId, status: "ready" }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not send a selected SecretRef marker when locked materialization fails", async () => {
    const profileId = "openai:secretref";
    const baseUrl = "https://gateway.example.test/v1";
    mocks.resolveApiKeyForProvider.mockRejectedValue(new Error("secret unavailable"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await buildOpenAIProvider().catalog?.run({
      resolveProviderAuth: () => ({
        mode: "api_key",
        apiKey: "secretref-managed",
        profileId,
        source: "profile",
      }),
      resolveProviderApiKey: vi.fn(),
      config: {
        auth: { profiles: {} },
        models: { providers: { openai: { baseUrl, models: [] } } },
      },
      agentDir: "/tmp/openai-agent",
      workspaceDir: "/tmp/openai-workspace",
    } as never);

    if (!result || "provider" in result) {
      throw new Error("expected OpenAI live provider catalog");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.providers.openai?.baseUrl).toBe(baseUrl);
    expect(result.outcomes).toEqual([
      {
        provider: "openai",
        profileId,
        rejectionScope: "catalog",
        status: "unavailable",
      },
    ]);
  });

  it.each(["token"] as const)(
    "does not send an unmaterialized direct %s credential marker",
    async (mode) => {
      const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>();
      const result = await runCatalogWithFetchGuard({
        fetchGuard,
        auth: { mode, apiKey: "secretref-managed", source: "none" },
      });
      expect(fetchGuard).not.toHaveBeenCalled();
      expect(result.outcomes).toEqual([{ provider: "openai", status: "unavailable" }]);
    },
  );

  it("uses the Codex backend catalog for OpenAI OAuth discovery", async () => {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      mode: "oauth",
      apiKey: "fresh-oauth-token",
      source: "profile:openai:chatgpt",
      profileId: "openai:chatgpt",
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: "openai:chatgpt",
      accountId: "acct-openai-workspace",
    });
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "low" },
              { effort: "medium", description: "medium" },
              { effort: "high", description: "high" },
              { effort: "xhigh", description: "xhigh" },
              { effort: "max", description: "max" },
            ],
            input_modalities: ["text", "image"],
            context_window: 372_000,
            max_context_window: 372_000,
          },
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "low" },
              { effort: "medium", description: "medium" },
              { effort: "high", description: "high" },
            ],
            input_modalities: ["text", "image"],
            context_window: 272_000,
            max_context_window: 1_000_000,
            max_output_tokens: 128_000,
          },
          {
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6 Terra",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
          },
          {
            slug: "gpt-5.3-codex-spark",
            display_name: "GPT-5.3 Codex Spark",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "high", description: "high" }],
            context_window: 200_000,
            max_output_tokens: 64_000,
          },
          {
            slug: "codex-auto-review",
            display_name: "Codex Auto Review",
            visibility: "hide",
          },
          {
            slug: "codex-internal-fallback",
            display_name: "Codex Internal Fallback",
            visibility: "none",
          },
        ],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "oauth",
          apiKey: "stale-oauth-token",
          profileId: "openai:chatgpt",
          source: "profile",
        }),
        config: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI Codex live provider catalog");
      }
      expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
        profileId: "openai:chatgpt",
        lockedProfile: true,
      });
      expect(mocks.resolveProviderAuthProfileMetadata).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        profileId: "openai:chatgpt",
      });
      const openai = result.providers.openai;
      expect(openai?.api).toBe("openai-chatgpt-responses");
      expect(openai?.auth).toBe("oauth");
      expect(openai?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
      const shown = openai?.models.map((model) => model.id) ?? [];
      expect(shown).toEqual(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.3-codex-spark"]);
      // Entitlement keeps hidden rows that the picker omits.
      const hidden = ["codex-auto-review", "codex-internal-fallback"];
      expect(result.outcomes?.[0]?.listedModelIds).toEqual([...shown, ...hidden]);
      expect(openai?.models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
        contextWindow: 372_000,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      });
      const liveSol = openai?.models.find((model) => model.id === "gpt-5.6-sol");
      expect(
        provider.resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.6-sol",
          agentRuntime: "codex",
          api: "openai-chatgpt-responses",
          compat: liveSol?.compat,
        } as never)?.levels,
      ).toContainEqual({ id: "ultra" });
      expect(openai?.models.find((model) => model.id === "gpt-5.6-terra")).toMatchObject({
        contextWindow: 372_000,
        contextTokens: 272_000,
      });
      expect(openai?.models.find((model) => model.id === "gpt-5.3-codex-spark")).toMatchObject({
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(OPENAI_CODEX_MODELS_URL);
      const headers = fetchSpy.mock.calls[0]?.[1]?.headers;
      expect(headers).toBeInstanceOf(Headers);
      if (!(headers instanceof Headers)) {
        throw new Error("expected fetch headers");
      }
      expect(headers.get("Authorization")).toBe("Bearer fresh-oauth-token");
      expect(headers.get("ChatGPT-Account-ID")).toBe("acct-openai-workspace");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses runtime OAuth profiles when catalog auth resolution is empty", async () => {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      mode: "oauth",
      apiKey: "fresh-oauth-token",
      source: "profile:openai:chatgpt",
      profileId: "openai:chatgpt",
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: "openai:chatgpt",
      accountId: "acct-openai-workspace",
    });
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
          },
        ],
      }),
    );

    try {
      const result = await provider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "none",
          apiKey: undefined,
          discoveryApiKey: undefined,
          source: "none",
        }),
        config: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI Codex live provider catalog");
      }
      expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      });
      expect(result.providers.openai?.api).toBe("openai-chatgpt-responses");
      expect(result.providers.openai?.auth).toBe("oauth");
      expect(result.providers.openai?.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects Platform-only aliases while preserving GPT-5.6 ChatGPT capabilities", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.6",
            visibility: "list",
          },
          {
            slug: "chat-latest",
            visibility: "list",
          },
          {
            slug: "gpt-5.6-preview-2026-07-22",
            visibility: "list",
            context_window: 400_000,
            max_context_window: 1_050_000,
          },
          ...["sol", "terra", "luna"].map((tier) => ({
            slug: `gpt-5.6-${tier}`,
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "low" },
              { effort: "high", description: "high" },
              ...(tier === "luna" ? [{ effort: "ultra", description: "ultra" }] : []),
            ],
          })),
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token",
      fetchGuard,
    });

    expectNoCatalogEntry(provider.models, "gpt-5.6");
    expectNoCatalogEntry(provider.models, "chat-latest");
    expectCatalogEntry(provider.models, "gpt-5.6-preview-2026-07-22", {
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
    for (const tier of ["sol", "terra"] as const) {
      expect(provider.models.find((model) => model.id === `gpt-5.6-${tier}`)).toMatchObject({
        reasoning: true,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      });
    }
    expect(provider.models.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });
  });

  it("keeps an explicit empty Codex reasoning catalog authoritative", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            supported_reasoning_levels: [],
          },
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "empty-reasoning-oauth-token",
      fetchGuard,
    });
    const sol = provider.models.find((model) => model.id === "gpt-5.6-sol");

    expect(sol?.compat?.supportedReasoningEfforts).toEqual([]);
    expect(sol?.thinkingLevelMap).toEqual({ off: null });
    expect(
      buildOpenAIProvider().resolveThinkingProfile?.({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        agentRuntime: "codex",
        api: "openai-chatgpt-responses",
        compat: sol?.compat,
      } as never)?.levels,
    ).not.toContainEqual({ id: "ultra" });
  });

  registerOpenAIServiceTierCatalogTests({
    modelsUrl: OPENAI_CODEX_MODELS_URL,
    runCatalogWithFetchGuard,
  });

  it("reports account access denial for the selected OAuth profile", async () => {
    const release = vi.fn(async () => undefined);
    const result = await runCatalogWithFetchGuard({
      auth: {
        mode: "oauth",
        apiKey: "oauth-token-no-visible-models",
        profileId: "openai:chatgpt",
        source: "profile",
      },
      accountId: "acct-openai-workspace",
      fetchGuard: async () => ({
        response: new Response("forbidden", { status: 403 }),
        finalUrl: OPENAI_CODEX_MODELS_URL,
        release,
      }),
    });

    expect(result.provider.api).toBe("openai-chatgpt-responses");
    expect(result.provider.auth).toBe("oauth");
    expect(result.provider.models).toEqual([]);
    expect(result.outcomes).toEqual([
      { provider: "openai", profileId: "openai:chatgpt", status: "auth-rejected" },
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["gpt-5.6-sol"])(
    "prefers auth-aware Codex runtime metadata for %s over static OpenAI catalog rows",
    (modelId) => {
      const provider = buildOpenAIProvider();

      expect(
        provider.preferRuntimeResolvedModel?.({
          provider: "openai",
          modelId,
        } as never),
      ).toBe(true);
    },
  );

  it("normalizes legacy OpenAI Codex hook aliases through the Codex transport", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.normalizeTransport?.({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      } as never),
    ).toEqual({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(
      provider.normalizeResolvedModel?.({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          provider: "openai",
          id: "gpt-5.4-codex",
          name: "gpt-5.4-codex",
          api: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api",
        },
      } as never),
    ).toMatchObject({
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text", "image"],
    });
  });

  it("upgrades catalog Completions metadata but preserves authored official adapters", () => {
    const provider = buildOpenAIProvider();
    const transport = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
    } as const;

    for (const baseUrl of [
      "https://api.openai.com/v1",
      "https://api.openai.com:443/v1",
      "https://api.openai.com./v1",
    ]) {
      expect(provider.normalizeTransport?.({ ...transport, baseUrl } as never)).toEqual({
        api: "openai-responses",
        baseUrl,
      });
    }
    expect(
      provider.normalizeTransport?.({
        ...transport,
        baseUrl: "http://api.openai.com/v1",
      } as never),
    ).toBeUndefined();
    for (const config of [
      {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5.5", api: "openai-completions" }],
            },
          },
        },
      },
      {
        models: {
          providers: {
            openai: {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              models: [{ id: "gpt-5.5", baseUrl: "https://api.openai.com/v1" }],
            },
          },
        },
      },
      {
        models: {
          providers: {
            OpenAI: {
              api: "openai-responses",
              baseUrl: "https://case-distinct.example/v1",
              models: [],
            },
            openai: {
              api: "openai-completions",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
    ]) {
      expect(provider.normalizeTransport?.({ ...transport, config } as never)).toBeUndefined();
      expect(
        provider.normalizeResolvedModel?.({
          ...transport,
          config,
          model: {
            provider: "openai",
            id: "gpt-5.5",
            name: "GPT-5.5",
            api: "openai-completions",
            baseUrl: "https://api.openai.com/v1",
          },
        } as never),
      ).toMatchObject({ api: "openai-completions" });
    }

    const legacyAliasConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            models: [{ id: "OpenAI/GPT-5.4-CODEX", api: "openai-completions" }],
          },
        },
      },
    };
    expect(
      provider.normalizeTransport?.({
        ...transport,
        modelId: "gpt-5.4",
        config: legacyAliasConfig,
      } as never),
    ).toBeUndefined();

    expect(
      provider.normalizeTransport?.({
        ...transport,
        provider: "OpenAI",
        config: {
          models: {
            providers: {
              OpenAI: { api: "openai-responses", models: [] },
              openai: { api: "openai-completions", models: [] },
            },
          },
        },
      } as never),
    ).toEqual({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("preserves authored Completions independently of route eligibility", () => {
    const provider = buildOpenAIProvider();
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: OPENAI_API_BASE_URL,
            models: [{ id: "gpt-5.3-codex-spark" }],
          },
        },
      },
    };
    const observedTransport = {
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
      config,
    } as const;

    expect(provider.normalizeTransport?.(observedTransport as never)).toEqual({
      api: "openai-completions",
      baseUrl: OPENAI_API_BASE_URL,
    });
    expect(
      provider.normalizeResolvedModel?.({
        ...observedTransport,
        model: {
          provider: "openai",
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          api: "openai-chatgpt-responses",
          baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
        },
      } as never),
    ).toMatchObject({
      api: "openai-completions",
      baseUrl: OPENAI_API_BASE_URL,
    });
  });

  it("preserves authored Responses", () => {
    const provider = buildOpenAIProvider();
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      baseUrl: OPENAI_API_BASE_URL,
    } as const;
    const authoredResponsesConfig = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: OPENAI_API_BASE_URL,
            models: [{ id: "gpt-5.5" }],
          },
        },
      },
    };

    expect(
      provider.normalizeResolvedModel?.({
        provider: "openai",
        modelId: "gpt-5.5",
        model,
        config: authoredResponsesConfig,
      } as never),
    ).toEqual(model);
    expect(
      provider.normalizeTransport?.({
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses",
        baseUrl: OPENAI_API_BASE_URL,
        config: authoredResponsesConfig,
      } as never),
    ).toBeUndefined();
  });

  it("keeps HTTP Platform routes out of Codex transport gates", () => {
    const provider = buildOpenAIProvider();
    const baseUrl = "http://api.openai.com/v1";
    const providerConfig = {
      api: "openai-responses",
      baseUrl,
      models: [],
    } as const;

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileMode: "oauth",
      providerConfig,
    } as never);
    expect(model?.api).toBe("openai-responses");

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: { effort: "high" },
        config: {
          models: { providers: { openai: providerConfig } },
          auth: {
            profiles: {
              "openai:default": { provider: "openai", mode: "oauth" },
            },
          },
        },
      } as never),
    ).toEqual({ effort: "high", transport: "sse" });
  });

  it("delegates an unlisted first-party model to its explicitly selected Codex runtime", () => {
    const provider = buildOpenAIProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-future",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
    } as never);

    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-future",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    });
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-future",
          agentRuntime: "codex",
          api: model?.api,
          compat: model?.compat,
        } as never)
        ?.levels.map((level) => level.id),
    ).toContain("max");
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-future",
          agentRuntime: "codex",
        } as never)
        ?.levels.map((level) => level.id),
    ).toEqual(expect.arrayContaining(["xhigh", "max"]));
  });

  it("does not invent an unlisted model for authored Platform credentials", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.resolveDynamicModel?.({
        provider: "openai",
        modelId: "gpt-future",
        modelRegistry: { find: () => null },
        agentRuntimeId: "codex",
        authProfileId: "openai:platform",
        authProfileMode: "api_key",
        providerConfig: {
          auth: "api-key",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      } as never),
    ).toBeUndefined();
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-future",
          agentRuntime: "codex",
          api: "openai-responses",
        } as never)
        ?.levels.map((level) => level.id),
    ).not.toContain("max");
  });

  it("restores gpt-5.3-codex-spark only through ChatGPT/Codex OAuth routing", () => {
    const provider = buildOpenAIProvider();

    const oauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      authProfileId: "openai:work",
      authProfileMode: "oauth",
    } as never);
    const apiKeyModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      providerConfig: {
        auth: "api-key",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    } as never);
    const runtimeModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
    } as never);
    const apiKeyRuntimeModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
      modelRegistry: { find: () => null },
      agentRuntimeId: "codex",
      authProfileId: "openai:api-key",
      authProfileMode: "api_key",
      providerConfig: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    } as never);
    const unknownModelHint = provider.buildUnknownModelHint?.({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    } as never);

    expectFields(oauthModel, {
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      contextWindow: 128_000,
      contextTokens: 128_000,
      maxTokens: 128_000,
    });
    expectFields(runtimeModel, {
      provider: "openai",
      id: "gpt-5.3-codex-spark",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      contextWindow: 128_000,
      contextTokens: 128_000,
      maxTokens: 128_000,
    });
    expect(apiKeyModel).toBeUndefined();
    expect(apiKeyRuntimeModel).toBeUndefined();
    expect(unknownModelHint).toContain("ChatGPT/Codex OAuth");
    expect(unknownModelHint).toContain("OpenAI API-key auth cannot use this model");
  });

  it("resolves chat-latest as an explicit direct API model override", () => {
    const provider = buildOpenAIProvider();

    const model = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "chat-latest",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.5"
            ? {
                id,
                name: "GPT-5.5",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
                contextWindow: 1_050_000,
                maxTokens: 128_000,
              }
            : null,
      } as never,
    });

    expectFields(model, {
      provider: "openai",
      id: "chat-latest",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });

    const fallback = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "chat-latest",
      modelRegistry: { find: () => null },
    } as never);

    expectFields(fallback, {
      provider: "openai",
      id: "chat-latest",
      api: "openai-responses",
      reasoning: false,
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it("passes the selected runtime into GPT-5.6 thinking policy", () => {
    const provider = buildOpenAIProvider();
    const openClawLuna = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "openclaw",
    } as never);
    const codexLuna = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "codex",
      api: "openai-responses",
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    } as never);
    const codexSolFromDirectCatalog = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      api: "openai-responses",
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    } as never);
    const codexSolFromNativeCatalog = provider.resolveThinkingProfile?.({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      api: "openai-chatgpt-responses",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    } as never);

    expect(openClawLuna?.levels.map((level) => level.id)).toContain("ultra");
    expect(codexLuna?.levels.map((level) => level.id)).not.toContain("ultra");
    expect(codexLuna?.levels.map((level) => level.id)).toContain("max");
    expect(codexSolFromDirectCatalog?.levels.map((level) => level.id)).toContain("ultra");
    expect(codexSolFromNativeCatalog?.levels.map((level) => level.id)).toContain("ultra");
  });

  it.each([{ modelId: "gpt-5.4", contextWindow: 1_050_000 }])(
    "restores native image capability to an existing $modelId catalog row",
    ({ modelId, contextWindow }) => {
      const provider = buildOpenAIProvider();
      const existingRoute = {
        provider: "openai",
        id: modelId,
        name: `Stale ${modelId}`,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        contextWindow: 8_192,
        cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      };

      const entries = provider.augmentModelCatalog?.({
        env: process.env,
        entries: [existingRoute],
      } as never);

      expectCatalogEntry(entries, modelId, {
        provider: "openai",
        id: modelId,
        name: modelId,
        api: existingRoute.api,
        baseUrl: existingRoute.baseUrl,
        reasoning: true,
        input: ["text", "image"],
        contextWindow,
        cost: existingRoute.cost,
      });
    },
  );

  it("keeps chat-latest and gpt-5.5 out of synthetic catalog metadata", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.5",
        } as never)
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");

    const entries = provider.augmentModelCatalog?.({
      env: process.env,
      entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }],
    } as never);

    expectNoCatalogEntry(entries, "gpt-5.5");
    expectNoCatalogEntry(entries, "chat-latest");
    expectCatalogEntry(entries, "gpt-5.5-pro", { provider: "openai", name: "gpt-5.5-pro" });
  });

  it("owns replay policy for OpenAI and Codex transports", () => {
    const provider = buildOpenAIProvider();
    const codexProvider = buildOpenAIProvider();

    expect(
      provider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      provider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai-completions",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
    });

    expect(
      codexProvider.buildReplayPolicy?.({
        provider: "openai",
        modelApi: "openai-chatgpt-responses",
        modelId: "gpt-5.4",
      } as never),
    ).toEqual({
      sanitizeMode: "images-only",
      applyAssistantFirstOrderingFix: false,
      sanitizeToolCallIds: false,
      validateGeminiTurns: false,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
      appendOnlyRuntimeContext: true,
    });
  });

  it("owns direct OpenAI wrapper composition for responses payloads", async () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }
    const extraParams = provider.prepareExtraParams?.({
      provider: "openai",
      modelId: "gpt-5.4",
      extraParams: {
        fastMode: true,
        serviceTier: "priority",
        textVerbosity: "low",
      },
    } as never);
    const result = await runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      extraParams: extraParams ?? undefined,
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 200_000,
      } as Model<"openai-responses">,
      payload: {
        reasoning: { effort: "none" },
      },
    });

    expectFields(extraParams, {
      transport: "sse",
    });
    expect(result.payload.store).toBe(true);
    expect(result.payload.context_management).toEqual([
      { type: "compaction", compact_threshold: 140_000 },
    ]);
    expect(result.payload.service_tier).toBe("priority");
    expect(result.payload.text).toEqual({ verbosity: "low" });
    expect(result.payload.reasoning).toEqual({ effort: "none" });
    expect(result.payload.tools).toEqual([{ type: "web_search" }]);
  });

  it("authorizes native OpenAI web search through the code mode wrapper chain", async () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }
    const allowedHostedToolTypes = new Set<string>();

    const result = await runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      context: {
        messages: [],
        tools: [
          { name: "exec", description: "", parameters: {} },
          { name: "wait", description: "", parameters: {} },
        ],
      },
      streamOptions: {
        openclawCodeModeToolSurface: true,
        openclawCodeModeAllowedHostedToolTypes: allowedHostedToolTypes,
      },
      payload: {
        tools: [
          { type: "function", name: "exec" },
          { type: "function", name: "wait" },
          { type: "function", name: "rogue" },
          { type: "function", name: "web_search" },
        ],
      },
    });

    expect(result.payload.tools).toEqual([
      { type: "function", name: "exec" },
      { type: "function", name: "wait" },
      { type: "web_search" },
    ]);
    expect(allowedHostedToolTypes).toEqual(new Set(["web_search"]));
  });

  it("keeps one native OpenAI web search tool when the payload is already patched", async () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const result = await runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        tools: [{ type: "web_search" }, { type: "function", name: "web_search" }],
        reasoning: { effort: "minimal" },
      },
    });

    expect(result.payload.tools).toEqual([{ type: "web_search" }]);
    expect(result.payload.reasoning).toEqual({ effort: "low" });
  });

  it("keeps managed OpenAI web_search when agent policy denies native web search", async () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const allowedHostedToolTypes = new Set<string>();
    const result = await runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      agentId: "main",
      nativeWebSearchAllowedByToolPolicy: false,
      streamOptions: {
        openclawCodeModeToolSurface: true,
        openclawCodeModeAllowedHostedToolTypes: allowedHostedToolTypes,
      },
      cfg: {
        agents: {
          entries: {
            main: {
              tools: { deny: ["web_search"] },
            },
          },
        },
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: {
        tools: [
          { type: "function", name: "read" },
          { type: "function", name: "web_search" },
        ],
      },
    });

    expect(result.payload.tools).toEqual([
      { type: "function", name: "read" },
      { type: "function", name: "web_search" },
    ]);
    expect(allowedHostedToolTypes).toEqual(new Set());
  });

  it("does not inject native OpenAI web search when disabled or proxied", async () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const disabledAllowedHostedToolTypes = new Set<string>();
    const disabled = await runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: false } } } },
      streamOptions: {
        openclawCodeModeAllowedHostedToolTypes: disabledAllowedHostedToolTypes,
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });
    const proxiedAllowedHostedToolTypes = new Set<string>();
    const proxied = await runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://example-proxy.invalid/v1",
      } as Model<"openai-responses">,
      streamOptions: {
        openclawCodeModeAllowedHostedToolTypes: proxiedAllowedHostedToolTypes,
      },
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(disabled.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(proxied.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(disabledAllowedHostedToolTypes).toEqual(new Set());
    expect(proxiedAllowedHostedToolTypes).toEqual(new Set());
  });

  it("keeps managed web_search when another search provider is configured", async () => {
    const provider = buildOpenAIProvider();
    const wrap = provider.wrapStreamFn;
    expect(wrap).toBeTypeOf("function");
    if (!wrap) {
      throw new Error("expected OpenAI wrapper");
    }

    const allowedHostedToolTypes = new Set<string>();
    const result = await runWrappedPayloadCase({
      wrap,
      provider: "openai",
      modelId: "gpt-5.4",
      cfg: { tools: { web: { search: { enabled: true, provider: "brave" } } } },
      streamOptions: {
        openclawCodeModeAllowedHostedToolTypes: allowedHostedToolTypes,
      },
      model: {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://api.openai.com/v1",
      } as Model<"openai-responses">,
      payload: { tools: [{ type: "function", name: "web_search" }] },
    });

    expect(result.payload.tools).toEqual([{ type: "function", name: "web_search" }]);
    expect(allowedHostedToolTypes).toEqual(new Set());
  });

  it("defaults direct OpenAI API-key traffic to SSE and preserves explicit WebSocket", () => {
    const provider = buildOpenAIProvider();

    const explicit = {
      transport: "websocket",
      fastMode: true,
    };

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        },
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                auth: "api-key",
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        },
        extraParams: { effort: "high" },
      } as never),
    ).toEqual({ effort: "high", transport: "sse" });

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("uses SSE for an unselected OAuth profile and native defaults for a Codex route", () => {
    const provider = buildOpenAIProvider();

    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: { effort: "high" },
        config: {
          auth: {
            profiles: {
              "openai:default": {
                provider: "openai",
                mode: "oauth",
              },
            },
          },
        },
      } as never),
    ).toEqual({
      effort: "high",
      transport: "sse",
    });
    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-chatgpt-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://chatgpt.com/backend-api/codex/responses",
        } as Model<"openai-chatgpt-responses">,
        extraParams: { effort: "high" },
      }),
    ).toEqual({
      effort: "high",
      transport: "auto",
    });

    const explicit = {
      transport: "sse",
    };
    expect(
      provider.prepareExtraParams?.({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });
});
describe("OpenAI model materialization", () => {
  it.each(["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"])(
    "materializes %s capabilities and preserves its registered Ultra opt-out",
    (modelId) => {
      const provider = buildOpenAIProvider();
      const initialModel = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        modelRegistry: { find: () => null },
      } as never);
      expect(initialModel).toMatchObject({
        id: modelId,
        provider: "openai",
        api: "openai-responses",
        compat: { supportedReasoningEfforts: expect.arrayContaining(["xhigh", "max"]) },
      });
      const registeredModel = {
        ...initialModel,
        contextWindow: 123_456,
        thinkingLevelMap: { max: null },
      };
      const resolvedModel = provider.resolveDynamicModel?.({
        provider: "openai",
        modelId,
        modelRegistry: { find: () => registeredModel },
      } as never);
      expect(resolvedModel).toBe(registeredModel);
      expect(
        resolveThinkingProfile({
          provider: "openai",
          modelId,
          agentRuntime: "openclaw",
          compat: resolvedModel?.compat,
          thinkingLevelMap: resolvedModel?.thinkingLevelMap,
        })?.levels.map(({ id }) => id),
      ).not.toContain("ultra");
    },
  );

  it("routes GPT forward-compat models by the projected route, not profile order", () => {
    const provider = buildOpenAIProvider();

    const openaiModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      providerConfig: {
        auth: "api-key",
      },
    } as never);
    const unselectedPlatformModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.6",
      modelRegistry: { find: () => null },
      authProfileId: "openai:oauth",
      authProfileMode: "oauth",
      config: {
        auth: {
          profiles: {
            "openai:oauth": {
              provider: "openai",
              mode: "oauth",
            },
            "openai:api-key": {
              provider: "openai",
              mode: "api_key",
            },
          },
          order: {
            openai: ["openai:oauth", "openai:api-key"],
          },
        },
      },
    } as never);
    const unprojectedOauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileId: "openai:oauth",
      authProfileMode: "oauth",
    } as never);
    const selectedOauthModel = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelRegistry: { find: () => null },
      authProfileId: "openai:work",
      authProfileMode: "oauth",
      providerConfig: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    } as never);

    expect(openaiModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
    expect(unselectedPlatformModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.6",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
    expect(unprojectedOauthModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(selectedOauthModel).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
