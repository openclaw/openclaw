import assert from "node:assert/strict";
import type { OpenClawPluginApi, ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => providerAuthRuntimeMocks);

import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildLiveXaiProvider } from "./provider-catalog.js";
import setupPlugin from "./setup-api.js";
import { captureXaiRequest } from "./test-helpers.js";

type XaiAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerXaiAutoEnableProbe(): XaiAutoEnableProbe {
  const registerAutoEnableProbe = vi.fn<(probe: XaiAutoEnableProbe) => void>();
  setupPlugin.register(createTestPluginApi({ registerAutoEnableProbe }));
  const probe = registerAutoEnableProbe.mock.calls[0]?.[0];
  assert(probe, "expected xAI setup plugin to register an auto-enable probe");
  return probe;
}

type XaiBilledToolName = "code_execution" | "x_search";

function billedToolFactory(name: XaiBilledToolName) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  plugin.register(createTestPluginApi({ registerTool }));
  const factory = registerTool.mock.calls.find(([, opts]) => opts?.name === name)?.[0];
  assert(typeof factory === "function", `Expected ${name} to register a tool factory`);
  return factory;
}

function createXaiBilledToolConfig(name: XaiBilledToolName, enabled?: boolean) {
  const config = {
    [name === "code_execution" ? "codeExecution" : "xSearch"]:
      enabled === undefined ? {} : { enabled },
  };
  return { plugins: { entries: { xai: { config } } } };
}

function mockXaiRuntimeOAuth() {
  providerAuthRuntimeMocks.resolveApiKeyForProvider.mockResolvedValue({
    apiKey: "xai-oauth-token",
    mode: "oauth",
    source: "profile:xai-profile",
    profileId: "xai-profile",
  });
}

function stubXaiFetch(respond: () => Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubXaiModels(...data: unknown[]) {
  return stubXaiFetch(() => Response.json({ data }));
}

function xaiToolContext(
  name: XaiBilledToolName,
  provider: string | undefined,
  enabled?: boolean,
  hasAuth = true,
) {
  return {
    config: createXaiBilledToolConfig(name, enabled),
    activeModel: provider === undefined ? {} : { provider },
    hasAuthForProvider: (id: string) => hasAuth && id === "xai",
    resolveApiKeyForProvider: async (id: string) =>
      hasAuth && id === "xai" ? "xai-test-key" : undefined,
  };
}

function catalogContext(
  auth: ReturnType<ProviderCatalogContext["resolveProviderAuth"]>,
  config: OpenClawConfig = {},
) {
  return {
    config,
    env: {},
    resolveProviderAuth: () => auth,
    resolveProviderApiKey: () => ({ apiKey: "env-xai-key", discoveryApiKey: "env-xai-key" }),
  };
}

async function runXaiCatalog(options: { auth?: "none" } = {}) {
  const provider = await registerSingleProviderPlugin(plugin);
  const result = await provider.catalog?.run({
    ...catalogContext(
      options.auth === "none"
        ? { apiKey: undefined, discoveryApiKey: undefined, mode: "none", source: "none" }
        : {
            apiKey: undefined,
            discoveryApiKey: "stale-oauth-token",
            mode: "oauth",
            source: "profile",
            profileId: "xai-profile",
          },
      { models: {} },
    ),
    agentDir: "/agent",
    workspaceDir: "/workspace",
  });
  assert(result && "provider" in result, "expected xAI catalog provider result");
  return { provider, result: result.provider };
}

describe("xai provider plugin", () => {
  let registeredProvider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  beforeEach(async () => {
    clearLiveCatalogCacheForTests();
    providerAuthRuntimeMocks.resolveApiKeyForProvider
      .mockReset()
      .mockRejectedValue(new Error("No runtime credential"));
    vi.stubEnv("XAI_API_KEY", "");
    registeredProvider = await registerSingleProviderPlugin(plugin);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const proxyUrl = "https://cli-chat-proxy.grok.com/v1";
  const apiUrl = "https://api.x.ai/v1";
  it.each([
    ["oauth", undefined, proxyUrl, "oauth"],
    ["token", proxyUrl, proxyUrl, "token"],
    ["token", apiUrl, apiUrl, undefined],
    ["api_key", undefined, apiUrl, undefined],
  ] as const)(
    "keeps the static catalog on the selected %s route (%s)",
    async (mode, baseUrl, expectedUrl, expectedAuth) => {
      const result = await registeredProvider.staticCatalog?.run(
        catalogContext(
          { mode, source: "profile", apiKey: undefined, discoveryApiKey: "selected-fixture" },
          baseUrl ? { models: { providers: { xai: { baseUrl, models: [] } } } } : {},
        ),
      );
      assert(result && "provider" in result, "expected a static xAI catalog");
      expect([result.provider.baseUrl, result.provider.auth]).toEqual([expectedUrl, expectedAuth]);
    },
  );

  it.each([
    { name: "an existing selection", primary: "xai/grok-4.5", expected: "xai/grok-4.5" },
    { name: "a fresh selection", primary: undefined, expected: "xai/grok-4.7" },
  ])("applies registered API-key setup with $name", async ({ primary, expected }) => {
    const method = registeredProvider.auth.find((entry) => entry.id === "api-key");
    assert(method?.runNonInteractive, "expected the non-interactive xAI API-key method");
    const fallbacks = ["xai/grok-4.3", "xai/grok-build-0.1"];
    const pinned = { alias: "Pinned", params: { temperature: 0.7 } };
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { ...(primary ? { primary } : {}), fallbacks: [...fallbacks] },
          models: { "xai/grok-4.5": structuredClone(pinned) },
        },
      },
    };
    const result = await method.runNonInteractive({
      authChoice: "xai-api-key",
      config,
      baseConfig: config,
      opts: {},
      runtime: createNonExitingRuntime(),
      resolveApiKey: async () => ({ key: "synthetic-existing-profile", source: "profile" }),
      toApiKeyCredential: () => {
        throw new Error("Existing profile must not be rewritten");
      },
    });
    expect(result?.agents?.defaults?.model).toEqual({ primary: expected, fallbacks });
    expect(result?.agents?.defaults?.models?.["xai/grok-4.5"]).toEqual(pinned);
  });

  it("registers SuperGrok usage through xAI OAuth only", async () => {
    const credentials = { token: "oauth-token", accountId: "acct", email: "user@example.com" };
    const apiKey = vi.fn();
    const context = {
      config: {},
      agentDir: "/agent",
      env: {},
      provider: "xai",
      resolveOAuthToken: vi.fn(async () => credentials),
      resolveApiKeyFromConfigAndStore: apiKey,
      resolveApiKeyCandidatesFromConfigAndStore: vi.fn(),
    };

    await expect(registeredProvider.resolveUsageAuth?.(context)).resolves.toEqual(credentials);

    expect(apiKey).not.toHaveBeenCalled();
    await expect(
      registeredProvider.resolveUsageAuth?.({
        ...context,
        env: { XAI_API_KEY: "xai-api-key" },
        resolveOAuthToken: vi.fn(async () => null),
      }),
    ).resolves.toEqual({ handled: true });
    expect(manifest.contracts).toMatchObject({ usageProviders: ["xai"] });
    expect(registeredProvider.fetchUsageSnapshot).toEqual(expect.any(Function));
  });

  it("shows every chat model the xAI API-key listing returns", async () => {
    const chatModels = ["grok-4.7", "grok-5-preview"];
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        data: [
          ...chatModels.toReversed(),
          "grok-4.20-multi-agent-0309",
          "grok-imagine-image",
          "grok-imagine-video",
        ].map((id) => ({ id, object: "model" })),
      }),
      finalUrl: "https://api.x.ai/v1/models",
      release,
    }));

    const provider = await buildLiveXaiProvider({ apiKey: "xai-key", fetchGuard });
    expect(provider.models.map((model) => model.id)).toEqual(chatModels);
    const fetchParams = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(fetchParams?.url).toBe("https://api.x.ai/v1/models");
    expect(new Headers(fetchParams?.init?.headers).get("Authorization")).toBe("Bearer xai-key");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["Grok proxy", "https://cli-chat-proxy.grok.com/v1", true, undefined, undefined],
    ["native API", "https://api.x.ai/v1", false, undefined, undefined],
    ["unavailable Grok token", "https://cli-chat-proxy.grok.com/v1", true, false, false],
    ["runtime-materialized Grok token", "https://cli-chat-proxy.grok.com/v1", true, true, false],
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
      const fetchMock = stubXaiModels({ id: "grok-4.3", api_backend: "responses" });
      const result = await registeredProvider.catalog?.run(
        catalogContext(
          {
            apiKey: prepared ? apiKey : "MISSING_GROK_TOKEN",
            discoveryApiKey: prepared ? apiKey : undefined,
            mode: "token",
            profileId,
            source: "profile",
          },
          { models: { providers: { xai: { baseUrl, auth: "token", models: [] } } } },
        ),
      );
      if (!resolves && !prepared) {
        expect(result).toEqual({
          providers: {},
          outcomes: [{ provider: "xai", profileId, status: "unavailable" }],
        });
        expect(fetchMock).not.toHaveBeenCalled();
        return;
      }
      assert(result && "provider" in result, "expected xAI token catalog");
      expect(result.provider.baseUrl).toBe(baseUrl);
      expect(result.provider.auth).toBe(subscription ? "token" : undefined);
      expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([`${baseUrl}/models`]);
      for (const [, init] of fetchMock.mock.calls) {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
      }
    },
  );

  it("lets a known subscription model's listed efforts replace its bundled profile", async () => {
    mockXaiRuntimeOAuth();
    stubXaiModels({
      id: "grok-4.7",
      api_backend: "responses",
      supports_reasoning_effort: true,
      reasoning_efforts: ["low", "high", "xhigh"],
    });
    const { result } = await runXaiCatalog();
    const compat = result.models.find((entry) => entry.id === "grok-4.7")?.compat;
    expect(compat).toMatchObject({ supportedReasoningEfforts: ["low", "high", "xhigh"] });
    expect(compat).not.toHaveProperty("thinkingLevels");
    expect(compat).not.toHaveProperty("defaultThinkingLevel");
  });

  it("uses the Grok OAuth proxy catalog for xAI OAuth discovery", async () => {
    mockXaiRuntimeOAuth();
    const fetchMock = stubXaiModels(
      { id: "grok-composer-2.5-fast", api_backend: "responses" },
      { id: "grok-build", api_backend: "responses" },
      { id: "grok-imagine-image", api_backend: "image" },
      {
        id: "grok-fixture-fast",
        api_backend: "responses",
        supports_reasoning_effort: true,
        reasoning_efforts: ["xhigh", "high", "medium", "low"].map((value) =>
          value === "high" ? { id: value, value, default: true } : { id: value, value },
        ),
      },
    );
    const { provider, result } = await runXaiCatalog();

    expect(result).toMatchObject({ baseUrl: "https://cli-chat-proxy.grok.com/v1", auth: "oauth" });
    expect(result.apiKey).toBeUndefined();
    expect(result.models.map(({ id, reasoning }) => ({ id, reasoning }))).toEqual([
      { id: "grok-composer-2.5-fast", reasoning: true },
      { id: "grok-build", reasoning: true },
      { id: "grok-fixture-fast", reasoning: true },
    ]);
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
    const composer = result.models[0];
    assert(composer, "expected OAuth Composer model");
    const normalizedComposer = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: composer.id,
      model: { ...composer, provider: "xai" },
    } as never);
    assert(normalizedComposer, "expected normalized OAuth Composer model");
    assert(provider.wrapStreamFn, "expected xAI stream wrapper");
    const { payload } = captureXaiRequest(normalizedComposer as never, {
      wrap: provider.wrapStreamFn,
    });
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.include).toEqual(["reasoning.encrypted_content"]);
    expect(payload.tool_stream).toBe(true);
    expect(payload).toHaveProperty("tools.0.function.strict", true);
    expect(providerAuthRuntimeMocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "xai",
      cfg: { models: {} },
      agentDir: "/agent",
      workspaceDir: "/workspace",
      profileId: "xai-profile",
      lockedProfile: true,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer xai-oauth-token",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports OAuth discovery failure without retrying with an API key", async () => {
    mockXaiRuntimeOAuth();
    const fetchMock = stubXaiFetch(() => new Response("temporarily unavailable", { status: 503 }));
    const resolveProviderApiKey = vi.fn(() => ({ apiKey: "alternate-key" }));
    const result = await registeredProvider.catalog?.run({
      ...catalogContext({ apiKey: undefined, mode: "none", source: "none" }),
      resolveProviderApiKey,
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
    const fetchMock = stubXaiModels({ id: "grok-4.3" });
    const { result } = await runXaiCatalog({ auth: "none" });

    expect(result.apiKey).toBe("env-xai-key");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer env-xai-key",
    );
  });

  it.each([
    [403, "The caller does not have permission to execute the specified operation", "billing"],
    [429, "Some resource has been exhausted", "billing"],
    [429, "Some resource has been exhausted", "rate_limit"],
    [400, "Client specified an invalid argument", undefined],
  ])("classifies Grok error %s / %s as %s", (status, code, expected) => {
    const error =
      expected === "billing"
        ? "Your team has either used all available credits or reached its monthly spending limit."
        : expected === "rate_limit"
          ? "Rate limit exceeded"
          : "Incorrect API key provided: xa***en.";
    expect(
      registeredProvider.classifyFailoverReason?.({
        errorMessage: `${status} ${JSON.stringify({ code, error })}`,
      }),
    ).toBe(expected);
  });

  it("forwards exact caller cancellation through the registered lazy X search factory", async () => {
    const factory = billedToolFactory("x_search");
    const tool = factory(xaiToolContext("x_search", "xai", true));
    assert(tool && !Array.isArray(tool), "Expected one registered lazy X search tool");
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

    expect(transportSignal?.reason).toBe(reason);
  });

  describe.each(["code_execution", "x_search"] as const)("%s exposure", (toolName) => {
    it.each([
      ["explicitly disabled", "xai", true, false, false, undefined],
      ["non-xAI default", "openai", true, false, undefined, undefined],
      ["non-xAI explicit consent", "openai", true, true, true, undefined],
      ["missing provider", undefined, true, false, true, undefined],
      ["missing auth", "xai", false, false, undefined, undefined],
      ["runtime disable overrides source", "xai", true, false, true, false],
      ["runtime consent overrides source", "openai", true, true, false, true],
    ])("%s", (_label, provider, hasAuth, expected, enabled, runtimeEnabled) => {
      const factory = billedToolFactory(toolName);
      const tool = factory({
        ...xaiToolContext(toolName, provider, enabled, hasAuth),
        ...(runtimeEnabled === undefined
          ? {}
          : {
              runtimeConfig: createXaiBilledToolConfig(toolName, runtimeEnabled),
            }),
      });

      expect(tool).toEqual(expected ? expect.objectContaining({ name: toolName }) : null);
    });
  });

  it("declares setup auto-enable reasons for plugin-owned tool config", () => {
    const probe = registerXaiAutoEnableProbe();

    for (const name of ["x_search", "code_execution"] as const) {
      expect(probe({ config: createXaiBilledToolConfig(name, true), env: {} })).toBe(
        "xai tool configured",
      );
    }
    expect(probe({ config: {}, env: {} })).toBeNull();
  });

  function resolveModel(modelId: string, api = "openai-responses") {
    return registeredProvider.resolveDynamicModel?.({
      provider: "xai",
      modelId,
      modelRegistry: { find: () => null } as never,
      providerConfig: { api, baseUrl: "https://api.x.ai/v1" },
    } as never);
  }

  it("registers model resolution with normalized IDs and configured transport", () => {
    expect(resolveModel("xai/GROK-4.3", "openai-completions")).toMatchObject({
      id: "grok-4.3",
      provider: "xai",
      api: "openai-completions",
      baseUrl: apiUrl,
    });
  });

  it("refuses the unsupported multi-agent endpoint ids", () => {
    expect(resolveModel("grok-4.20-multi-agent-experimental-beta-0304")).toBeUndefined();
  });

  it("marks modern Grok refs without accepting multi-agent ids", () => {
    const modern = (modelId: string) =>
      registeredProvider.isModernModelRef?.({ provider: "xai", modelId } as never);
    expect(["grok-4.6", "grok-4.3"].map(modern)).toEqual([true, true]);
    expect(
      ["grok-4.20-multi-agent-experimental-beta-0304", "grok-3-mini-fast"].map(modern),
    ).toEqual([false, false]);
  });

  async function fetchUsage(payload: unknown, status = 200) {
    assert(registeredProvider.fetchUsageSnapshot, "xAI usage provider is registered");
    const snapshot = await registeredProvider.fetchUsageSnapshot({
      config: {},
      env: {},
      provider: "xai",
      token: "oauth-token",
      timeoutMs: 5000,
      fetchFn: createProviderUsageFetch(async (url, init) => {
        expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer oauth-token",
          Accept: "application/json",
          "x-grok-client-mode": "cli",
          "x-grok-client-version": "1.0.4",
        });
        return makeResponse(status, payload);
      }),
    });
    assert(snapshot, "xAI usage provider returns a snapshot");
    return snapshot;
  }

  const weekly = {
    type: "USAGE_PERIOD_TYPE_WEEKLY",
    start: "2026-09-21T12:01:29Z",
    end: "2026-09-28T12:01:29Z",
  };
  const omitted = { windows: [], summary: "Included usage omitted" };
  const monthlyEnd = "2026-09-30T00:00:00Z";

  describe("fetchXaiUsage", () => {
    it.each([
      [
        "explicit zero weekly usage",
        { creditUsagePercent: 0, currentPeriod: weekly, prepaidBalance: { val: "1250" } },
        { subscription_tier: "SuperGrok Heavy" },
        { windows: [{ label: "Weekly", usedPercent: 0, resetAt: Date.parse(weekly.end) }] },
        "SuperGrok Heavy",
        12.5,
      ],
      [
        "legacy monthly counters",
        { used: { val: 2500 }, monthly_limit: { val: 10000 }, billing_period_end: monthlyEnd },
        { subscriptionTier: "Premium+" },
        { windows: [{ label: "Monthly", usedPercent: 25, resetAt: Date.parse(monthlyEnd) }] },
        "Premium+",
        0,
      ],
      [
        "omitted weekly usage despite on-demand counters",
        {
          currentPeriod: weekly,
          onDemandCap: { val: 10000 },
          onDemandUsed: { val: 2500 },
          isUnifiedBillingUser: true,
          prepaidBalance: { val: 0 },
          billingPeriodStart: weekly.start,
          billingPeriodEnd: weekly.end,
        },
        {},
        omitted,
        "SuperGrok",
        0,
      ],
      [
        "omitted monthly usage",
        { currentPeriod: { ...weekly, type: "USAGE_PERIOD_TYPE_MONTHLY" } },
        {},
        omitted,
        "SuperGrok",
        0,
      ],
    ] as const)(
      "fetches billing with CLI headers and preserves %s",
      async (_name, config, tier, expected, plan, balance) => {
        await expect(fetchUsage({ ...tier, config })).resolves.toEqual({
          provider: "xai",
          displayName: "SuperGrok",
          billing: [{ type: "balance", label: "Prepaid balance", amount: balance, unit: "USD" }],
          plan,
          ...expected,
        });
      },
    );

    it("returns token-expired errors for billing auth failures", async () => {
      await expect(fetchUsage({ error: "expired" }, 401)).resolves.toEqual({
        provider: "xai",
        displayName: "xAI",
        windows: [],
        error: "Token expired",
      });
    });

    it.each([
      ["malformed JSON", "{not-json", "Malformed billing response"],
      ["missing config", {}, "Malformed billing response"],
      ["missing usage fields", { config: { prepaidBalance: { val: "100" } } }, "No usage data"],
      [
        "weekly period without bounds",
        { config: { currentPeriod: { type: weekly.type } } },
        "No usage data",
      ],
      [
        "unusable included-usage percent",
        { config: { creditUsagePercent: -1, currentPeriod: weekly } },
        "No usage data",
      ],
    ])("returns a stable error for %s", async (_name, payload, error) => {
      const result = await fetchUsage(payload);
      expect(result.error).toBe(error);
      expect(result.windows).toHaveLength(0);
    });
  });
});
