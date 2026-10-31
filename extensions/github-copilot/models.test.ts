import { streamSimpleAnthropic } from "@openclaw/ai/internal/anthropic";
import { streamSimpleOpenAIResponses } from "@openclaw/ai/internal/openai";
import { expectDefined } from "@openclaw/normalization-core";
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
const completionsCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
};

describe("resolveCopilotForwardCompatModel", () => {
  it("returns undefined for empty modelId", () => {
    expect(resolveCopilotForwardCompatModel(createMockCtx("  "))).toBeUndefined();
  });

  it("returns undefined when model is already in registry", () => {
    const ctx = createMockCtx("gpt-4o", {
      "github-copilot/gpt-4o": { id: "gpt-4o", name: "gpt-4o" },
    });
    expect(resolveCopilotForwardCompatModel(ctx)).toBeUndefined();
  });

  it("infers reasoning=true for Codex model IDs", () => {
    for (const id of ["gpt-5.4-codex-mini", "gpt-5.3-codex"]) {
      expect(requireResolvedModel(createMockCtx(id)).reasoning).toBe(true);
    }
  });
});

describe("github-copilot runtime auth", () => {
  it.each([undefined, "https://api.individual.githubcopilot.com/"])(
    "resolves account endpoint %s without exchanging the source token",
    async (api) => {
      const fetchImpl = jsonFetch({ endpoints: { api } });
      expect(await authenticate(fetchImpl)).toEqual({
        apiKey: "github-source-token",
        baseUrl: "https://api.individual.githubcopilot.com",
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
    },
  );

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
        message: "Copilot authentication failed: timed out after 30000ms",
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

  function selectableModelEntry(
    id: string,
    category = "versatile",
    contextWindow = 200_000,
    extra: { policy?: { state: string }; preview?: boolean } = {},
  ) {
    return {
      id,
      capabilities: {
        type: "chat",
        limits: {
          max_context_window_tokens: contextWindow,
          max_output_tokens: 64_000,
        },
        supports: { streaming: true, tool_calls: true },
      },
      object: "model",
      model_picker_enabled: true,
      model_picker_category: category,
      policy: { state: "enabled" },
      ...extra,
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
      expect(init?.method).toBe("GET");
      expect(headers.get("accept-encoding")).toBe("identity");
      expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
      expect(headers.get("authorization")).toBe("Bearer setup-source-token");
      expect(headers.has("x-private-header")).toBe(false);
      return Response.json({ data: [selectableModelEntry("tenant-model")] });
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
  });

  it("uses a deterministic eligible fallback when the preferred model is policy-disabled", async () => {
    const entries = [
      selectableModelEntry("preferred", "versatile", 200_000, { policy: { state: "disabled" } }),
      selectableModelEntry("preview", "versatile", 1_000_000, { preview: true }),
      selectableModelEntry("powerful", "powerful", 1_000_000),
      selectableModelEntry("versatile-b", "versatile", 400_000),
      selectableModelEntry("versatile-a", "versatile", 400_000),
    ];
    const forward = await fetchSelectionFixture(entries);
    const reversed = await fetchSelectionFixture(entries.toReversed());
    expect(selectCopilotStarterModel(forward, "preferred")?.id).toBe("versatile-a");
    expect(selectCopilotStarterModel(reversed, "preferred")?.id).toBe("versatile-a");
  });

  it("filters non-chat models and internal routers", async () => {
    const models = await fetchSelectionFixture([
      { id: "chat", capabilities: { type: "chat" } },
      { id: "accounts/msft/routers/abc123", capabilities: { type: "chat" } },
      { id: "text-embedding-3-small", capabilities: { type: "embedding" } },
    ]);
    expect(models.map(({ id }) => id)).toEqual(["chat"]);
  });

  it.each<[unknown, string | undefined, string, string]>([
    [undefined, "OpenAI", "endpoint-fixture", "openai-responses"],
    [undefined, undefined, "gemini-3.1-pro-preview", "openai-completions"],
    [undefined, "Acme Labs", "claude-lookalike-9", "anthropic-messages"],
    [[42, " /v1/chat/completions/ "], "OpenAI", "endpoint-fixture", "openai-completions"],
    [["/chat/completions", "/responses"], "OpenAI", "endpoint-fixture", "openai-responses"],
    [["/responses", "/v1/messages"], "Anthropic", "endpoint-fixture", "anthropic-messages"],
    [["/v1/messages"], "OpenAI", "endpoint-fixture", "anthropic-messages"],
    [["/responses"], "Google", "gemini-endpoint-fixture", "openai-responses"],
    [["/chat/completions"], "Anthropic", "claude-sonnet-4.5", "openai-completions"],
    [["/responses"], "Anthropic", "claude-sonnet-4.5", "openai-responses"],
    [["/messages"], "Anthropic", "claude-sonnet-4.5", "anthropic-messages"],
  ])("uses advertised transport %s for %s/%s (%s)", async (endpoints, vendor, id, api) => {
    const efforts = endpoints === undefined ? ["low", "medium", "high"] : ["low", "high", "max"];
    const vision = vendor === "OpenAI";
    const prompt = vendor === undefined ? undefined : 917_504;
    const out = await fetchSelectionFixture([
      {
        id,
        vendor,
        supported_endpoints: endpoints,
        capabilities: {
          type: "chat",
          limits: {
            max_context_window_tokens: 1_048_576,
            max_output_tokens: 128_000,
            max_prompt_tokens: prompt,
          },
          supports: { vision, reasoning_effort: efforts },
        },
      },
    ]);
    const model = expectDefined(out[0], "discovered endpoint fixture");
    expect(model).toMatchObject({
      api,
      contextWindow: 1_048_576,
      maxTokens: 128_000,
      reasoning: true,
      input: vision ? ["text", "image"] : ["text"],
    });
    expect(model.contextTokens).toBe(prompt);
    expect(model.family).toBe(
      vendor === "Acme Labs"
        ? undefined
        : vendor === "Anthropic"
          ? "anthropic"
          : vendor === "OpenAI"
            ? "openai"
            : "google",
    );
    if (api === "openai-completions") {
      expect(model.compat).toEqual({
        ...completionsCompat,
        supportedReasoningEfforts: efforts,
      });
    } else {
      expect(model.compat?.maxTokensField).toBeUndefined();
      expect(model.compat?.supportsEagerToolInputStreaming).toBe(
        id === "claude-sonnet-4.5" && api === "anthropic-messages" ? false : undefined,
      );
    }
    if (api === "openai-responses") {
      expect(model.thinkingLevelMap).toEqual({
        minimal: "low",
        xhigh: null,
        max: efforts.includes("max") ? "max" : null,
      });
    }
    if (id === "claude-sonnet-4.5" && api === "anthropic-messages") {
      expect(model.thinkingLevelMap).toEqual({ xhigh: null, max: null });
    }
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
      { apiKey: "test-token", reasoning: "high", onPayload },
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
            : Response.json({ data: [] }),
        );
      if (source === "metadata DNS") {
        catalogTransport.lookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
      }
      await expect(fetchCatalogWithFetch(fetchImpl)).rejects.toThrow(/blocked|private|metadata/i);
      expect(fetchImpl).toHaveBeenCalledTimes(source === "redirect" ? 1 : 0);
    },
  );

  it("cancels pending catalog transport on timeout", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<void>();
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
    const pending = fetchCatalogWithFetch(fetchImpl);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    await vi.advanceTimersByTimeAsync(COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

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
