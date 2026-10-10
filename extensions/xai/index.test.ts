// Xai tests cover index plugin behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => providerAuthRuntimeMocks);

import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildLiveXaiOAuthProvider, buildLiveXaiProvider } from "./provider-catalog.js";
import setupPlugin from "./setup-api.js";
import {
  createXaiPayloadCaptureStream,
  expectXaiFastToolStreamShaping,
  runXaiGrok4ResponseStream,
} from "./test-helpers.js";

type XaiAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerXaiAutoEnableProbe(): XaiAutoEnableProbe {
  const probes: XaiAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected xAI setup plugin to register an auto-enable probe");
  }
  return probe;
}

type XaiBilledToolName = "code_execution" | "x_search";

function registerXaiBilledToolFactories() {
  const tools = new Map<string, Parameters<OpenClawPluginApi["registerTool"]>[0]>();
  plugin.register(
    createTestPluginApi({
      registerTool(tool, opts) {
        if (opts?.name) {
          tools.set(opts.name, tool);
        }
      },
    }),
  );

  function requireFactory(name: XaiBilledToolName) {
    const factory = tools.get(name);
    if (typeof factory !== "function") {
      throw new Error(`Expected ${name} to register a tool factory`);
    }
    return factory;
  }

  return {
    code_execution: requireFactory("code_execution"),
    x_search: requireFactory("x_search"),
  };
}

function createXaiBilledToolConfig(name: XaiBilledToolName, enabled?: boolean) {
  const toolConfig = enabled === undefined ? {} : { enabled };
  return {
    plugins: {
      entries: {
        xai: {
          config:
            name === "code_execution" ? { codeExecution: toolConfig } : { xSearch: toolConfig },
        },
      },
    },
  };
}

function mockXaiRuntimeOAuth() {
  providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
    apiKey: "xai-oauth-token",
    mode: "oauth",
    source: "profile:xai-profile",
    profileId: "xai-profile",
  });
}

function stubXaiFetch(respond: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return await respond(url);
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function findXaiFetchInit(
  fetchMock: ReturnType<typeof stubXaiFetch>,
  url: string,
): RequestInit | undefined {
  return fetchMock.mock.calls.find(([input]) => input === url)?.[1];
}

async function runXaiCatalog(options: { auth?: "none"; apiKey?: false } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run({
    config: { models: {} },
    agentDir: "/agent",
    workspaceDir: "/workspace",
    env: {},
    resolveProviderAuth: () =>
      options.auth === "none"
        ? { apiKey: undefined, discoveryApiKey: undefined, mode: "none", source: "none" }
        : {
            apiKey: undefined,
            discoveryApiKey: "stale-oauth-token",
            mode: "oauth",
            source: "profile",
            profileId: "xai-profile",
          },
    resolveProviderApiKey: () => ({
      apiKey: options.apiKey === false ? undefined : "env-xai-key",
      discoveryApiKey: options.apiKey === false ? undefined : "env-xai-key",
    }),
  });
  if (!result || !("provider" in result)) {
    throw new Error("expected xAI catalog provider result");
  }
  return { provider, result: result.provider };
}

describe("xai provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockReset()
      .mockRejectedValue(new Error("No runtime credential"));
    vi.stubEnv("XAI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("registers SuperGrok usage through xAI OAuth only", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const oauth = vi.fn(async () => ({
      token: "oauth-token",
      accountId: "acct",
      email: "user@example.com",
    }));
    const apiKey = vi.fn();

    await expect(
      provider.resolveUsageAuth?.({
        config: {},
        agentDir: "/agent",
        env: {},
        provider: "xai",
        resolveOAuthToken: oauth,
        resolveApiKeyFromConfigAndStore: apiKey,
        resolveApiKeyCandidatesFromConfigAndStore: vi.fn(),
      }),
    ).resolves.toEqual({
      token: "oauth-token",
      accountId: "acct",
      email: "user@example.com",
    });

    expect(apiKey).not.toHaveBeenCalled();
    await expect(
      provider.resolveUsageAuth?.({
        config: {},
        agentDir: "/agent",
        env: { XAI_API_KEY: "xai-api-key" },
        provider: "xai",
        resolveOAuthToken: vi.fn(async () => null),
        resolveApiKeyFromConfigAndStore: apiKey,
        resolveApiKeyCandidatesFromConfigAndStore: vi.fn(),
      }),
    ).resolves.toEqual({ handled: true });
    expect(manifest.contracts).toMatchObject({ usageProviders: ["xai"] });
    expect(provider.fetchUsageSnapshot).toEqual(expect.any(Function));
  });

  it("shows every chat model the xAI API-key listing returns", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        data: [
          { id: "grok-4.7", object: "model" },
          { id: "grok-4.6", object: "model" },
          { id: "grok-4.5", object: "model" },
          { id: "grok-4.20-0309-reasoning", object: "model" },
          { id: "grok-4.20-0309-non-reasoning", object: "model" },
          { id: "grok-5-preview", object: "model" },
          { id: "grok-4.20-multi-agent-0309", object: "model" },
          { id: "grok-imagine-image", object: "model" },
          { id: "grok-imagine-video", object: "model" },
        ],
      }),
      finalUrl: "https://api.x.ai/v1/models",
      release,
    }));

    const provider = await buildLiveXaiProvider({
      apiKey: "xai-key",
      fetchGuard,
    });

    expect(provider.apiKey).toBe("xai-key");
    expect(provider.models.map((model) => model.id)).toEqual([
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-0309-reasoning",
      "grok-4.5",
      "grok-4.6",
      "grok-4.7",
      "grok-5-preview",
    ]);
    const fetchParams = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(fetchParams?.url).toBe("https://api.x.ai/v1/models");
    const init = fetchParams?.init;
    const headers = init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe("Bearer xai-key");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["Grok proxy", "https://cli-chat-proxy.grok.com/v1", true, undefined, undefined],
    ["native API", "https://api.x.ai/v1", false, undefined, undefined],
    ["unavailable Grok token", "https://cli-chat-proxy.grok.com/v1", true, false, false],
    ["cold prepared Grok token", "https://cli-chat-proxy.grok.com/v1", true, false, undefined],
    [
      "runtime-materialized Grok token",
      "https://cli-chat-proxy.grok.com/v1",
      true,
      undefined,
      false,
    ],
  ])(
    "keeps token catalog discovery on the $0",
    async (_route, baseUrl, subscription, resolves = true, prepared = true) => {
      const apiKey = "selected-xai-token";
      const profileId = "xai:selected-token";
      providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
        apiKey,
        mode: "token",
        profileId,
        source: `profile:${profileId}`,
      });
      if (!resolves) {
        providerAuthRuntimeMocks.resolveApiKeyForProvider.mockRejectedValue(
          new Error("Token unavailable"),
        );
      }
      const fetchMock = stubXaiFetch(() =>
        Response.json({ data: [{ id: "grok-4.3", api_backend: "responses" }] }),
      );
      const provider = await registerSingleProviderPlugin(plugin);
      const result = await provider.catalog?.run({
        config: baseUrl
          ? { models: { providers: { xai: { baseUrl, auth: "token", models: [] } } } }
          : {},
        env: {},
        resolveProviderAuth: () => ({
          apiKey: prepared ? apiKey : "MISSING_GROK_TOKEN",
          discoveryApiKey: prepared ? apiKey : undefined,
          mode: "token",
          profileId,
          source: "profile",
        }),
        resolveProviderApiKey: () => ({ apiKey: "unselected-api-key" }),
      });
      if (!resolves && !prepared) {
        expect(result).toEqual({
          providers: {},
          outcomes: [{ provider: "xai", profileId, status: "unavailable" }],
        });
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      if (!result || !("provider" in result)) {
        throw new Error("expected xAI token catalog");
      }
      const expectedBaseUrl = subscription
        ? "https://cli-chat-proxy.grok.com/v1"
        : "https://api.x.ai/v1";
      expect(result.provider.baseUrl).toBe(expectedBaseUrl);
      expect(result.provider.auth).toBe(subscription ? "token" : undefined);
      const requestedUrls = fetchMock.mock.calls.map(([input]) =>
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      expect(requestedUrls).toEqual([`${expectedBaseUrl}/models`]);
      for (const [, init] of fetchMock.mock.calls) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
      }
    },
  );

  it("uses the Grok OAuth proxy catalog for xAI OAuth discovery", async () => {
    mockXaiRuntimeOAuth();
    const fetchMock = stubXaiFetch(() => {
      return Response.json({
        data: [
          {
            id: "grok-composer-2.5-fast",
            model: "grok-composer-2.5-fast",
            name: "Composer 2.5",
            api_backend: "responses",
            context_window: 200_000,
          },
          {
            id: "grok-build",
            model: "grok-build",
            name: "Grok Build",
            api_backend: "responses",
            context_window: 512_000,
          },
          {
            id: "grok-imagine-image",
            model: "grok-imagine-image",
            name: "Grok Imagine",
            api_backend: "image",
          },
        ],
      });
    });
    const { provider, result } = await runXaiCatalog();

    expect(result.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
    expect(result.auth).toBe("oauth");
    expect(result.apiKey).toBeUndefined();
    expect(result.models.map((model) => model.id)).toEqual([
      "grok-composer-2.5-fast",
      "grok-build",
    ]);
    const composer = result.models.find((model) => model.id === "grok-composer-2.5-fast");
    if (!composer) {
      throw new Error("expected OAuth Composer model");
    }
    expect(composer.reasoning).toBe(true);
    expect(result.models.find((model) => model.id === "grok-build")?.reasoning).toBe(true);
    const normalizedComposer = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: composer.id,
      model: { ...composer, provider: "xai" },
    } as never);
    if (!normalizedComposer) {
      throw new Error("expected normalized OAuth Composer model");
    }
    const capture = createXaiPayloadCaptureStream();
    const wrapped = provider.wrapStreamFn?.({
      provider: "xai",
      modelId: normalizedComposer.id,
      extraParams: {},
      streamFn: capture.streamFn,
    } as never);
    if (!wrapped) {
      throw new Error("expected xAI stream wrapper");
    }
    void wrapped(normalizedComposer as never, { messages: [] } as never, {});
    expect(capture.getCapturedPayload()).not.toHaveProperty("reasoning");
    expect(capture.getCapturedPayload()?.include).toEqual(["reasoning.encrypted_content"]);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "xai",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      profileId: "xai-profile",
      lockedProfile: true,
    });
    const modelFetchInit = findXaiFetchInit(fetchMock, "https://cli-chat-proxy.grok.com/v1/models");
    expect(new Headers(modelFetchInit?.headers).get("Authorization")).toBe(
      "Bearer xai-oauth-token",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("publishes concrete OAuth rows without reading remote defaults or inventing prices", async () => {
    const urls: string[] = [];
    const fetchGuard: LiveModelCatalogFetchGuard = async ({ url }) => {
      urls.push(url);
      return {
        response: Response.json({
          data: [
            { id: "grok-4.6", api_backend: "responses" },
            { id: "grok-fixture-next", api_backend: "responses" },
          ],
        }),
        finalUrl: url,
        release: async () => undefined,
      };
    };
    const provider = await buildLiveXaiOAuthProvider({
      discoveryApiKey: "xai-oauth-token",
      fetchGuard,
    });

    expect(urls).toEqual(["https://cli-chat-proxy.grok.com/v1/models"]);
    expect(provider.models.map((model) => model.id)).toEqual(["grok-4.6", "grok-fixture-next"]);
    expect(provider.models[1]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("reports OAuth discovery failure without retrying with an API key", async () => {
    mockXaiRuntimeOAuth();
    const fetchMock = stubXaiFetch(() => new Response("temporarily unavailable", { status: 503 }));
    const provider = await registerSingleProviderPlugin(plugin);
    const resolveProviderApiKey = vi.fn(() => ({ apiKey: "alternate-key" }));
    const result = await provider.catalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey,
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    expect(result).toEqual({
      providers: {},
      outcomes: [{ provider: "xai", profileId: "xai-profile", status: "unavailable" }],
    });
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.every(([url]) =>
        (url instanceof Request ? url.url : url.toString()).startsWith(
          "https://cli-chat-proxy.grok.com/",
        ),
      ),
    ).toBe(true);
  });

  it("uses fallback API-key credentials consistently for xAI live discovery", async () => {
    const fetchMock = stubXaiFetch(() =>
      Response.json({
        data: [{ id: "grok-4.3", object: "model" }],
      }),
    );
    const { result } = await runXaiCatalog({ auth: "none" });

    expect(result.apiKey).toBe("env-xai-key");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer env-xai-key",
    );
  });

  it("classifies Grok usage and spending limit errors", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
      }),
    ).toBe("billing");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '429 {"code":"Some resource has been exhausted","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
      }),
    ).toBe("billing");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '429 {"code":"Some resource has been exhausted","error":"Rate limit exceeded"}',
      }),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({
        errorMessage:
          '400 {"code":"Client specified an invalid argument","error":"Incorrect API key provided: xa***en. You can obtain an API key from https://console.x.ai."}',
      }),
    ).toBeUndefined();
  });

  it("forwards exact caller cancellation through the registered lazy X search factory", async () => {
    const factory = registerXaiBilledToolFactories().x_search;
    const tool = factory({
      config: createXaiBilledToolConfig("x_search", true),
      activeModel: { provider: "xai" },
      hasAuthForProvider: (providerId) => providerId === "xai",
      resolveApiKeyForProvider: async (providerId) =>
        providerId === "xai" ? "xai-lazy-cancel-key" : undefined,
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one registered lazy X search tool");
    }
    expect(tool.resultContentSource).toBe("network");
    const controller = new AbortController();
    const reason = new Error("operator cancelled lazy X search");
    let transportSignal: AbortSignal | undefined;
    const mockFetch = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          transportSignal = init?.signal ?? undefined;
          transportSignal?.addEventListener("abort", () => reject(reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort(reason));
        }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      tool.execute("lazy-xai-cancel", { query: "registered lazy cancellation" }, controller.signal),
    ).rejects.toBe(reason);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(transportSignal?.reason).toBe(reason);
  });

  describe.each(["code_execution", "x_search"] as const)("%s exposure", (toolName) => {
    it.each([
      ["hides when explicitly disabled for an xAI model", "xai", true, false, false],
      ["hides by default for a known non-xAI model", "openai", true, false, undefined],
      [
        "exposes when explicitly enabled for a known non-xAI model with auth",
        "openai",
        true,
        true,
        true,
      ],
      ["hides when the active provider is missing", undefined, true, false, true],
      ["hides an xAI model without auth", "xai", false, false, undefined],
    ])("$0", (_label, provider, hasAuth, expected, enabled) => {
      const factory = registerXaiBilledToolFactories()[toolName];
      const tool = factory({
        config: createXaiBilledToolConfig(toolName, enabled),
        activeModel: provider === undefined ? {} : { provider },
        hasAuthForProvider: (providerId) => hasAuth && providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          hasAuth && providerId === "xai" ? "xai-test-key" : undefined,
      });

      expect(tool).toEqual(expected ? expect.objectContaining({ name: toolName }) : null);
    });

    it.each([
      ["runtime false overrides source true", "xai", true, false, false],
      [
        "runtime true overrides source false for a known non-xAI provider",
        "openai",
        false,
        true,
        true,
      ],
    ])("$0", (_label, provider, sourceEnabled, runtimeEnabled, expected) => {
      const factory = registerXaiBilledToolFactories()[toolName];
      const tool = factory({
        config: createXaiBilledToolConfig(toolName, sourceEnabled),
        runtimeConfig: createXaiBilledToolConfig(toolName, runtimeEnabled),
        activeModel: { provider },
        hasAuthForProvider: (providerId) => providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          providerId === "xai" ? "xai-test-key" : undefined,
      });

      expect(tool).toEqual(expected ? expect.objectContaining({ name: toolName }) : null);
    });
  });

  it("declares setup auto-enable reasons for plugin-owned tool config", () => {
    const probe = registerXaiAutoEnableProbe();

    expect(
      probe({
        config: { plugins: { entries: { xai: { config: { xSearch: { enabled: true } } } } } },
        env: {},
      }),
    ).toBe("xai tool configured");
    expect(
      probe({
        config: {
          plugins: { entries: { xai: { config: { codeExecution: { enabled: true } } } } },
        },
        env: {},
      }),
    ).toBe("xai tool configured");
    expect(probe({ config: {}, env: {} })).toBeNull();
  });

  it("wires provider stream shaping for fast mode and tool-stream defaults", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capture = createXaiPayloadCaptureStream();

    const wrapped = provider.wrapStreamFn?.({
      provider: "xai",
      modelId: "grok-4",
      extraParams: { fastMode: true },
      streamFn: capture.streamFn,
    } as never);

    runXaiGrok4ResponseStream(wrapped);
    expectXaiFastToolStreamShaping(capture);
  });

  it("defaults tool_stream extra params but preserves explicit values", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: { fastMode: true },
      } as never),
    ).toEqual({
      fastMode: true,
      tool_stream: true,
    });

    const explicit = { fastMode: true, tool_stream: false };
    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("owns forward-compatible Grok model resolution", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "xai",
      modelId: "grok-4.3",
      modelRegistry: { find: () => null } as never,
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      },
    } as never);
    expect(resolved?.id).toBe("grok-4.3");
    expect(resolved?.provider).toBe("xai");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe("https://api.x.ai/v1");
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text", "image"]);
    expect(resolved?.contextWindow).toBe(1_000_000);

    const buildAlias = provider.resolveDynamicModel?.({
      provider: "xai",
      modelId: "grok-build-latest",
      modelRegistry: { find: () => null } as never,
      providerConfig: {
        api: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      },
    } as never);
    expect(buildAlias?.id).toBe("grok-4.5");
    expect(buildAlias?.reasoning).toBe(true);
    expect(buildAlias?.contextWindow).toBe(500_000);
  });

  it("marks modern Grok refs without accepting multi-agent ids", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.6",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.3",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.20-multi-agent-experimental-beta-0304",
      } as never),
    ).toBe(false);
  });

  it("follows the listed reasoning efforts for a Grok model the ID rules do not cover", async () => {
    mockXaiRuntimeOAuth();
    stubXaiFetch(() =>
      Response.json({
        data: [
          {
            id: "grok-fixture-fast",
            api_backend: "responses",
            supports_reasoning_effort: true,
            reasoning_efforts: [
              { id: "xhigh", value: "xhigh" },
              { id: "high", value: "high", default: true },
              { id: "medium", value: "medium" },
              { id: "low", value: "low" },
            ],
          },
        ],
      }),
    );
    const { provider, result } = await runXaiCatalog();
    const model = result.models.find((entry) => entry.id === "grok-fixture-fast");

    expect(
      provider.resolveThinkingProfile?.({
        provider: "xai",
        modelId: "grok-fixture-fast",
        reasoning: model?.reasoning,
        compat: model?.compat,
      }),
    ).toEqual({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
      defaultLevel: "high",
    });
    const normalized = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: "grok-fixture-fast",
      model: { ...model, provider: "xai" },
    } as never);
    expect(normalized?.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    });
    // The listing offers no "none", so off is not a selectable effort.
    expect(normalized?.thinkingLevelMap).toEqual({
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    });
  });
});
