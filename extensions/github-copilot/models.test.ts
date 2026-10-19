import { streamSimpleAnthropic } from "@openclaw/ai/internal/anthropic";
import { streamSimpleOpenAIResponses } from "@openclaw/ai/internal/openai";
import { expectDefined } from "@openclaw/normalization-core";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { makeResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";
import { resolveCopilotRuntimeAuth } from "./runtime-auth.js";
import { resolveCopilotStarterModel } from "./starter-model.js";

const catalogTransport = vi.hoisted(() => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
  releases: [] as Array<() => Promise<void>>,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn(async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      const result = await actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: catalogTransport.lookup,
      });
      const release = vi.fn(result.release);
      catalogTransport.releases.push(release);
      return { ...result, release };
    }),
  };
});

vi.mock("openclaw/plugin-sdk/provider-model-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-model-shared")>()),
  normalizeModelCompat: (model: Record<string, unknown>) => model,
  resolveProviderEndpoint: (baseUrl: string) => ({
    baseUrl,
    endpointClass: "custom",
    warnings: [],
  }),
}));

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/openclaw-state",
}));

import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/core";
import {
  COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS,
  fetchCopilotModelCatalog,
  resolveCopilotForwardCompatModel,
  selectCopilotStarterModel,
} from "./models.js";

function createMockCtx(
  modelId: string,
  registryModels: Record<string, Record<string, unknown>> = {},
): ProviderResolveDynamicModelContext {
  return {
    modelId,
    provider: "github-copilot",
    config: {},
    modelRegistry: {
      find: (provider: string, id: string) => registryModels[`${provider}/${id}`] ?? null,
    },
  } as unknown as ProviderResolveDynamicModelContext;
}

const requireResolvedModel = (ctx: ProviderResolveDynamicModelContext) =>
  expectDefined(resolveCopilotForwardCompatModel(ctx), `expected model ${ctx.modelId} to resolve`);

const messages = [{ role: "user" as const, content: "Reply OK", timestamp: 1 }];
const authenticate = (fetchImpl: typeof fetch) =>
  resolveCopilotRuntimeAuth({ githubToken: "github-source-token", fetchImpl });
const jsonFetch = (data: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
const capturePayload = () =>
  vi.fn((_payload: unknown) => {
    throw new Error("captured before sending");
  });

describe("resolveCopilotForwardCompatModel", () => {
  it("returns undefined for empty modelId", () => {
    expect(resolveCopilotForwardCompatModel(createMockCtx(""))).toBeUndefined();
    expect(resolveCopilotForwardCompatModel(createMockCtx("  "))).toBeUndefined();
  });

  it("returns undefined when model is already in registry", () => {
    const ctx = createMockCtx("gpt-4o", {
      "github-copilot/gpt-4o": { id: "gpt-4o", name: "gpt-4o" },
    });
    expect(resolveCopilotForwardCompatModel(ctx)).toBeUndefined();
  });

  it("disables eager tool streaming for synthetic Copilot Claude 4.5 models", () => {
    const result = requireResolvedModel(createMockCtx("claude-haiku-4.5"));
    expect(result.api).toBe("anthropic-messages");
    expect(result.compat).toEqual({ supportsEagerToolInputStreaming: false });
  });

  it("infers reasoning=true for Codex model IDs", () => {
    for (const id of ["gpt-5.4-codex", "gpt-5.5-codex", "gpt-5.4-codex-mini", "gpt-5.3-codex"]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
    }
  });
});

describe("github-copilot runtime auth", () => {
  it("validates and preserves the source token while resolving the account API endpoint", async () => {
    const fetchImpl = jsonFetch({
      endpoints: { api: "https://api.individual.githubcopilot.com/" },
    });
    expect(await authenticate(fetchImpl)).toEqual({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      source: "validated:https://api.github.com/copilot_internal/user",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/user",
      expect.objectContaining({
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer github-source-token",
        },
      }),
    );
  });

  it("uses a domain-safe fallback when account metadata omits the API endpoint", async () => {
    await expect(authenticate(jsonFetch({ copilot_plan: "individual" }))).resolves.toMatchObject({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
  });

  it.each([
    "http://api.individual.githubcopilot.com",
    "https://api.individual.githubcopilot.com.attacker.test",
    "https://user@api.individual.githubcopilot.com",
  ])("rejects an untrusted account endpoint: %s", async (api) => {
    await expect(authenticate(jsonFetch({ endpoints: { api } }))).rejects.toThrow(
      "untrusted endpoints.api URL",
    );
  });

  it("explains forbidden auth without waiting for capture", async () => {
    const response = new Response(new ReadableStream<Uint8Array>(), { status: 403 });
    const capture = response.clone();
    const rejection = authenticate(vi.fn<typeof fetch>().mockResolvedValue(response)).catch(
      (error: unknown) => error,
    );
    try {
      const error = await Promise.race([
        rejection,
        new Promise<undefined>((resolve) => {
          setImmediate(() => resolve(undefined));
        }),
      ]);
      expect(error).toBeInstanceOf(CopilotRuntimeAuthError);
      expect(error).toMatchObject({
        code: "github_copilot_auth_failed",
        reason: "http_error",
        status: 403,
        message: expect.stringContaining("login-github-copilot"),
      });
      expect(response.bodyUsed).toBe(true);
    } finally {
      await capture.body?.cancel();
      await rejection;
    }
  });

  it("maps a stalled response body to a runtime-auth timeout", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            signal?.addEventListener("abort", () => streamController.error(signal.reason), {
              once: true,
            });
            queueMicrotask(() => controller.abort(new DOMException("timed out", "TimeoutError")));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      await expect(authenticate(fetchImpl)).rejects.toMatchObject({
        name: "CopilotRuntimeAuthError",
        reason: "timeout",
        timeoutMs: 30_000,
      });
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe("fetchCopilotModelCatalog", () => {
  beforeEach(() => {
    catalogTransport.lookup.mockReset();
    catalogTransport.releases.length = 0;
    vi.mocked(fetchWithSsrFGuard).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    for (const release of catalogTransport.releases) {
      expect(release).toHaveBeenCalledOnce();
    }
  });

  function fetchCatalogWithFetch(
    fetchImpl: typeof fetch,
    params: Partial<Parameters<typeof fetchCopilotModelCatalog>[0]> = {},
  ) {
    vi.stubGlobal("fetch", fetchImpl);
    return fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
      ...params,
    });
  }

  function chatModel(
    id: string,
    [context, output, prompt]: [number, number, number?],
    supports: Record<string, unknown>,
    name = id,
  ) {
    return {
      id,
      name,
      capabilities: {
        type: "chat",
        limits: {
          max_context_window_tokens: context,
          max_output_tokens: output,
          ...(prompt === undefined ? {} : { max_prompt_tokens: prompt }),
        },
        supports,
      },
    };
  }

  const reasoning_effort = ["low", "medium", "high"];
  const sampleApiResponse = {
    data: [
      chatModel("gpt-5.5", [400000, 128000, 272000], { vision: true, reasoning_effort }, "GPT-5.5"),
      chatModel("gpt-5.3-codex", [400000, 128000], {
        vision: false,
        reasoning_effort,
      }),
      chatModel("gemini-3.1-pro-preview", [1_000_000, 65_536], {
        vision: true,
      }),
      chatModel("claude-opus-4.7-1m-internal", [1000000, 64000], {
        vision: true,
        reasoning_effort: [...reasoning_effort, "xhigh"],
      }),
      chatModel("claude-opus-4-5", [200000, 64000], {
        vision: true,
        reasoning_effort: [...reasoning_effort, "max"],
      }),
      { id: "accounts/msft/routers/abc123", capabilities: { type: "chat" } },
      { id: "text-embedding-3-small", capabilities: { type: "embedding" } },
    ],
  };

  function selectableModelEntry(params: {
    id: string;
    category?: string;
    contextWindow?: number;
    policyState?: string;
    preview?: boolean;
  }) {
    return {
      ...chatModel(params.id, [params.contextWindow ?? 200_000, 64_000], {
        streaming: true,
        tool_calls: true,
      }),
      object: "model",
      model_picker_enabled: true,
      model_picker_category: params.category ?? "versatile",
      policy: { state: params.policyState ?? "enabled" },
      preview: params.preview ?? false,
    };
  }

  const fetchSelectionFixture = (data: unknown[]) => fetchCatalogWithFetch(jsonFetch({ data }));

  it("keeps static catalog policy and xhigh Responses effort aligned", async () => {
    const model = {
      ...requireResolvedModel(createMockCtx("gpt-5.6-luna")),
      provider: "github-copilot",
      api: "openai-responses" as const,
      baseUrl: "https://api.githubcopilot.com",
    };
    const profile = resolveThinkingProfile({ ...model, modelId: model.id });
    expect(profile?.levels.some(({ id }) => id === "xhigh")).toBe(true);
    const onPayload = capturePayload();
    const result = await streamSimpleOpenAIResponses(
      model,
      { messages },
      { apiKey: "test-token", reasoning: "xhigh", onPayload },
    ).result();
    expect(result.errorMessage).toBe("captured before sending");
    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning: { effort: "xhigh", summary: "auto" } }),
      model,
    );
  });
  it("selects onboarding's starter model using the configured integration identity", async () => {
    catalogTransport.lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.endsWith("/copilot_internal/user")) {
        return Response.json({ endpoints: { api: "https://copilot-api.acme.ghe.com" } });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
      expect(headers.get("authorization")).toBe("Bearer setup-source-token");
      expect(headers.has("x-private-header")).toBe(false);
      return Response.json({ data: [selectableModelEntry({ id: "tenant-model" })] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = {
      baseUrl: "https://copilot-api.acme.ghe.com",
      models: [],
      headers: {
        "copilot-integration-id": "vscode-chat",
        "X-Private-Header": "not-for-catalog",
      },
    };
    await expect(
      resolveCopilotStarterModel({
        githubToken: "setup-source-token",
        githubDomain: "acme.ghe.com",
        config: { models: { providers: { "github-copilot": provider } } },
      }),
    ).resolves.toBe("github-copilot/tenant-model");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a deterministic eligible fallback when the preferred model is policy-disabled", async () => {
    const entries = [
      selectableModelEntry({ id: "preferred", policyState: "disabled" }),
      selectableModelEntry({ id: "preview", preview: true, contextWindow: 1_000_000 }),
      selectableModelEntry({ id: "powerful", category: "powerful", contextWindow: 1_000_000 }),
      selectableModelEntry({ id: "versatile-b", contextWindow: 400_000 }),
      selectableModelEntry({ id: "versatile-a", contextWindow: 400_000 }),
    ];
    const forward = await fetchSelectionFixture(entries);
    const reversed = await fetchSelectionFixture(entries.toReversed());
    expect(selectCopilotStarterModel(forward, "preferred")?.id).toBe("versatile-a");
    expect(selectCopilotStarterModel(reversed, "preferred")?.id).toBe("versatile-a");
  });

  it("maps Copilot /models entries to ModelDefinitionConfig with real context windows", async () => {
    const fetchImpl = jsonFetch(sampleApiResponse);
    const out = await fetchCatalogWithFetch(fetchImpl);
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://api.githubcopilot.com/models",
        policy: { allowedOrigins: ["https://api.githubcopilot.com"] },
      }),
    );
    expect(catalogTransport.lookup).toHaveBeenCalledWith("api.githubcopilot.com", { all: true });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "https://api.githubcopilot.com/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer tid=test",
          "Accept-Encoding": "identity",
        }),
      }),
    );
    expect(out).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400000,
        contextTokens: 272000,
        maxTokens: 128000,
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
        thinkingLevelMap: { minimal: "low", xhigh: null, max: null },
      },
      expect.objectContaining({
        id: "gpt-5.3-codex",
        input: ["text"],
        reasoning: true,
        contextWindow: 400000,
      }),
      expect.objectContaining({
        id: "gemini-3.1-pro-preview",
        api: "openai-completions",
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        },
      }),
      expect.objectContaining({
        id: "claude-opus-4.7-1m-internal",
        api: "anthropic-messages",
        contextWindow: 1_000_000,
        thinkingLevelMap: { xhigh: "xhigh", max: null },
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      }),
      expect.objectContaining({
        id: "claude-opus-4-5",
        thinkingLevelMap: { xhigh: null, max: null },
        compat: {
          supportsEagerToolInputStreaming: false,
          supportedReasoningEfforts: ["low", "medium", "high", "max"],
        },
      }),
    ]);
    expect(out[1]?.contextTokens).toBeUndefined();
  });

  it.each<[unknown, string, string, string]>([
    [undefined, "OpenAI", "endpoint-fixture", "openai-responses"],
    [null, "OpenAI", "endpoint-fixture", "openai-responses"],
    [[], "OpenAI", "endpoint-fixture", "openai-responses"],
    [{ unknown: true }, "OpenAI", "endpoint-fixture", "openai-responses"],
    [["/future-api"], "OpenAI", "endpoint-fixture", "openai-responses"],
    [[42, " /v1/chat/completions/ "], "OpenAI", "endpoint-fixture", "openai-completions"],
    [["/chat/completions", "/responses"], "OpenAI", "endpoint-fixture", "openai-responses"],
    [["/responses", "/v1/messages"], "Anthropic", "endpoint-fixture", "anthropic-messages"],
    [["/v1/messages"], "OpenAI", "endpoint-fixture", "anthropic-messages"],
    [["/v1/responses"], "OpenAI", "endpoint-fixture", "openai-responses"],
    [["/responses"], "Google", "gemini-endpoint-fixture", "openai-responses"],
    [["/chat/completions"], "Anthropic", "claude-sonnet-4.5", "openai-completions"],
    [["/responses"], "Anthropic", "claude-sonnet-4.5", "openai-responses"],
  ])("uses advertised transport %s for %s/%s (%s)", async (endpoints, vendor, id, api) => {
    const out = await fetchSelectionFixture([
      {
        id,
        vendor,
        supported_endpoints: endpoints,
        capabilities: {
          type: "chat",
          limits: { max_context_window_tokens: 1_048_576, max_prompt_tokens: 917_504 },
        },
      },
    ]);
    const model = expectDefined(out[0], "discovered endpoint fixture");
    expect(model).toMatchObject({ api, contextWindow: 1_048_576, contextTokens: 917_504 });
    if (api === "openai-completions") {
      expect(model.compat).toEqual({
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      });
    } else {
      expect(model.compat?.maxTokensField).toBeUndefined();
      expect(model.compat?.supportsEagerToolInputStreaming).toBeUndefined();
    }
  });
  it("routes each listed model through an endpoint the account lists", async () => {
    const models = await fetchSelectionFixture([
      {
        id: "kimi-k3",
        vendor: "Moonshot AI",
        supported_endpoints: ["/chat/completions"],
        capabilities: { type: "chat", supports: { reasoning_effort: ["low", "high", "max"] } },
      },
      {
        id: "gpt-5-mini",
        vendor: "Azure OpenAI",
        supported_endpoints: ["/chat/completions", "/responses", "ws:/responses"],
        capabilities: { type: "chat" },
      },
      {
        id: "claude-haiku-4.5",
        vendor: "Anthropic",
        supported_endpoints: ["/chat/completions", "/v1/messages"],
        capabilities: { type: "chat" },
      },
    ]);

    expect(models.map(({ id, api }) => [id, api])).toEqual([
      ["kimi-k3", "openai-completions"],
      ["gpt-5-mini", "openai-responses"],
      ["claude-haiku-4.5", "anthropic-messages"],
    ]);
    expect(models[0]?.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      supportedReasoningEfforts: ["low", "high", "max"],
    });
  });

  it("sends adaptive thinking for a listed Claude id OpenClaw does not know", async () => {
    const [listed] = await fetchSelectionFixture([
      {
        id: "claude-novel-9",
        vendor: "Anthropic",
        supported_endpoints: ["/v1/messages"],
        capabilities: {
          type: "chat",
          supports: { reasoning_effort: ["low", "medium", "high", "xhigh", "max"] },
        },
      },
    ]);
    const model = {
      ...expectDefined(listed, "listed Claude model"),
      provider: "github-copilot",
      api: "anthropic-messages" as const,
      baseUrl: "https://api.githubcopilot.com",
    };
    expect(model.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
    const onPayload = capturePayload();
    const result = await streamSimpleAnthropic(
      model,
      { messages },
      {
        apiKey: "test-token",
        reasoning: "high",
        onPayload,
      },
    ).result();
    expect(result.errorMessage).toBe("captured before sending");
    const payload = onPayload.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(payload).not.toHaveProperty("thinking.budget_tokens");
  });

  it.each(["redirect", "metadata DNS"] as const)(
    "blocks unsafe catalog %s targets",
    async (source) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          source === "redirect"
            ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } })
            : makeResponse(200, { data: [] }),
        );
      if (source === "metadata DNS") {
        catalogTransport.lookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
      }
      await expect(fetchCatalogWithFetch(fetchImpl)).rejects.toThrow(/blocked|private|metadata/i);
      expect(fetchImpl).toHaveBeenCalledTimes(source === "redirect" ? 1 : 0);
    },
  );

  it.each(["timeout", "caller"] as const)(
    "cancels pending catalog transport on %s abort",
    async (source) => {
      vi.useFakeTimers();
      const started = Promise.withResolvers<void>();
      const controller = new AbortController();
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = expectDefined(init?.signal, "catalog request signal");
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("Expected catalog abort to carry an Error"),
              ),
            { once: true },
          );
          started.resolve();
        });
      });
      const pending = fetchCatalogWithFetch(
        fetchImpl,
        source === "caller" ? { signal: controller.signal } : {},
      );
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await started.promise;
      if (source === "timeout") {
        await vi.advanceTimersByTimeAsync(COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS);
      } else {
        expect(vi.getTimerCount()).toBe(0);
        controller.abort();
      }
      await rejected;
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels stalled non-2xx response bodies before the caller falls back", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 401 });
    await expect(
      fetchCatalogWithFetch(vi.fn<typeof fetch>().mockResolvedValue(response), {
        copilotApiToken: "tid=bad",
      }),
    ).rejects.toThrow(/HTTP 401/);
    expect(cancel).toHaveBeenCalled();
  });

  it("throws provider-owned errors for malformed successful /models payloads", async () => {
    for (const payload of [[], { data: {} }, { data: [null] }]) {
      await expect(fetchCatalogWithFetch(jsonFetch(payload))).rejects.toThrow(
        "Copilot /models: malformed JSON response",
      );
    }
  });

  it.each(["copilotApiToken", "baseUrl"] as const)("rejects empty %s", async (field) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchCatalogWithFetch(fetchImpl, { [field]: "" })).rejects.toThrow(
      `${field} required`,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
