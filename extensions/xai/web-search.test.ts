import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { jsonResponse, withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { resolveXaiForwardCompatModel } from "./provider-models.js";
import { createXaiWebSearchProvider as createXaiWebSearchContractProvider } from "./web-search-contract-api.js";
import { createXaiWebSearchProvider } from "./web-search.js";

const providerAuthMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn().mockResolvedValue({ source: "test", mode: "api-key" }),
  listUsableProviderAuthProfileIdsAsync: vi.fn(async () => ({
    agentDir: "",
    profileIds: [] as string[],
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => {
  throw new Error("xAI web search must not load the broad agent runtime");
});

vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>();
  return {
    ...original,
    listUsableProviderAuthProfileIdsAsync: providerAuthMocks.listUsableProviderAuthProfileIdsAsync,
  };
});

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...original,
    resolveApiKeyForProvider: providerAuthMocks.resolveApiKeyForProvider,
  };
});

const resolveAuth = providerAuthMocks.resolveApiKeyForProvider;

function profileAuth(
  apiKey: string,
  mode: "oauth" | "api-key" = "oauth",
  profileId = "xai:default",
) {
  return { apiKey, source: `profile:${profileId}`, mode, profileId };
}

function answerPayload(text: string) {
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

function xaiAnswerResponse(text: string): Response {
  return jsonResponse(answerPayload(text));
}

function installXaiWebSearchFetch(
  payload: Record<string, unknown> = answerPayload("Grounded Grok answer"),
) {
  const mockFetch = vi.fn((_input?: unknown, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(payload)),
  );
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}

function firstFetchBody(mockFetch: ReturnType<typeof installXaiWebSearchFetch>) {
  const init = mockFetch.mock.calls[0]?.[1];
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

function authorizationHeaders(mockFetch: { mock: { calls: unknown[][] } }) {
  return mockFetch.mock.calls.map(([, init]) =>
    new Headers((init as RequestInit | undefined)?.headers).get("Authorization"),
  );
}

function xaiPluginConfig(options: {
  enabled?: boolean;
  webSearch?: Record<string, unknown>;
  xSearch?: Record<string, unknown>;
}) {
  const { enabled, ...config } = options;
  const xai = { ...(enabled === undefined ? {} : { enabled }), config };
  return { plugins: { entries: { xai } } };
}

function requireXaiWebSearchTool(
  ctx: Parameters<ReturnType<typeof createXaiWebSearchProvider>["createTool"]>[0] = {
    config: xaiPluginConfig({ webSearch: { apiKey: "xai-test-key" } }),
  },
) {
  const tool = createXaiWebSearchProvider().createTool(ctx);
  if (!tool) {
    throw new Error("Expected xAI web search tool");
  }
  return tool;
}

function search(
  query: string,
  ctx?: Parameters<typeof requireXaiWebSearchTool>[0],
  signal?: AbortSignal,
) {
  return requireXaiWebSearchTool(ctx).execute({ query }, signal ? { signal } : undefined);
}

const defaultAgentConfig = {
  agents: {
    entries: { main: { agentDir: "/tmp/openclaw-xai-main-agent" } },
  },
};

function setupConfig(options: Parameters<typeof xaiPluginConfig>[0]) {
  return {
    ...xaiPluginConfig(options),
    tools: { web: { search: { provider: "grok", enabled: true } } },
  };
}

function runSetup(config: ReturnType<typeof setupConfig>, prompter = createTestWizardPrompter()) {
  return createXaiWebSearchProvider().runSetup?.({
    config,
    prompter,
    runtime: createNonExitingRuntime(),
  });
}

function cacheSearch(query: string) {
  return (cacheTtlMinutes: number) =>
    requireXaiWebSearchTool({
      config: xaiPluginConfig({ webSearch: { apiKey: "xai-cache-key" } }),
      searchConfig: { cacheTtlMinutes },
    }).execute({ query });
}

function resolveForwardModel(modelId: string) {
  return resolveXaiForwardCompatModel({
    providerId: "xai",
    ctx: {
      provider: "xai",
      modelId,
      modelRegistry: { find: () => null } as never,
      providerConfig: { api: "openai-responses", baseUrl: "https://api.x.ai/v1" },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  providerAuthMocks.listUsableProviderAuthProfileIdsAsync.mockReset().mockResolvedValue({
    agentDir: "",
    profileIds: [],
  });
  resolveAuth.mockReset().mockResolvedValue({ source: "test", mode: "api-key" });
});

describe("xai web search config resolution", () => {
  it("advertises xAI auth profiles in runtime and setup contracts", () => {
    expect(createXaiWebSearchProvider().authProviderId).toBe("xai");
    expect(createXaiWebSearchContractProvider().authProviderId).toBe("xai");
  });

  it("treats unresolved non-env SecretRefs as missing credentials instead of using env fallback", async () => {
    await withEnvAsync({ XAI_API_KEY: "ambient-xai-test-key" }, async () => {
      const result = await search("OpenClaw", {
        config: xaiPluginConfig({
          enabled: true,
          webSearch: {
            apiKey: {
              source: "file",
              provider: "vault",
              id: "/providers/xai/web-search",
            },
          },
        }),
      });

      expect(result).toMatchObject({
        error: "missing_xai_api_key",
        message: expect.stringContaining("use web_fetch for a specific URL or the browser tool"),
      });
    });
  });

  it("uses the active agentDir for xAI OAuth web search auth", async () => {
    resolveAuth.mockResolvedValue(profileAuth("active-agent-oauth-token", "oauth", "xai:active"));
    const mockFetch = installXaiWebSearchFetch();
    await search("OpenClaw Grok active agent OAuth web search", {
      agentDir: "/tmp/openclaw-xai-active-agent",
      config: {
        agents: {
          entries: {
            main: { agentDir: "/tmp/openclaw-xai-main-agent" },
            side: { agentDir: "/tmp/openclaw-xai-active-agent" },
          },
        },
      },
    });

    expect(resolveAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-active-agent",
      }),
    );
    expect(authorizationHeaders(mockFetch)).toEqual(["Bearer active-agent-oauth-token"]);
  });

  it.each([
    {
      name: "refreshes OAuth",
      credentials: [profileAuth("expired-oauth-token"), profileAuth("fresh-oauth-token")],
      expectedAuth: {
        cfg: expect.objectContaining(defaultAgentConfig),
        profileId: "xai:default",
        lockedProfile: true,
        forceRefresh: true,
      },
      profileIds: [],
    },
    {
      name: "falls back to an API-key profile when stale OAuth remains first",
      credentials: [
        profileAuth("expired-oauth-token"),
        profileAuth("expired-oauth-token"),
        profileAuth("expired-oauth-token"),
        profileAuth("xai-profile-api-key", "api-key", "xai:key"),
      ],
      expectedAuth: {
        agentDir: "/tmp/openclaw-xai-main-agent",
        profileId: "xai:key",
        lockedProfile: true,
      },
      profileIds: ["xai:key"],
    },
    {
      name: "falls back to env auth after a stale API-key profile",
      credentials: [
        profileAuth("stale-profile-key", "api-key"),
        { apiKey: "xai-env-fallback-key", source: "XAI_API_KEY", mode: "api-key" },
      ],
      expectedAuth: {
        cfg: expect.objectContaining(defaultAgentConfig),
        credentialPrecedence: "env-first",
      },
      profileIds: [],
    },
  ])("$name after a 401", async ({ name, credentials, expectedAuth, profileIds }) => {
    for (const credential of credentials) {
      resolveAuth.mockResolvedValueOnce(credential);
    }
    if (profileIds.length) {
      providerAuthMocks.listUsableProviderAuthProfileIdsAsync.mockResolvedValue({
        agentDir: "/tmp/openclaw-xai-main-agent",
        profileIds,
      });
    }
    const mockFetch = installXaiWebSearchFetch()
      .mockReset()
      .mockResolvedValueOnce(
        new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
      )
      .mockResolvedValueOnce(xaiAnswerResponse(name));
    const result = await search(name, {
      config: { ...defaultAgentConfig, tools: { web: { search: { provider: "grok" } } } },
    });
    expect(result.content).toContain(name);
    expect(resolveAuth).toHaveBeenNthCalledWith(
      credentials.length,
      expect.objectContaining({ provider: "xai", ...expectedAuth }),
    );
    expect(authorizationHeaders(mockFetch)).toEqual(
      [credentials[0], credentials.at(-1)].map((credential) => `Bearer ${credential?.apiKey}`),
    );
  });

  it("offers plugin-owned xSearch setup after Grok is selected", async () => {
    const select = vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("grok-4.3");
    const next = await runSetup(
      setupConfig({ enabled: true, webSearch: { apiKey: "xai-test-key" } }),
      createTestWizardPrompter({ select: select as never }),
    );
    expect(next?.plugins?.entries?.xai?.config?.xSearch).toMatchObject({
      enabled: true,
      model: "grok-4.3",
    });
  });

  it("keeps explicit xSearch disablement untouched during provider-owned setup", async () => {
    const config = setupConfig({ xSearch: { enabled: false } });
    const prompter = createTestWizardPrompter();

    expect(await runSetup(config, prompter)).toEqual(config);
    expect(prompter.note).not.toHaveBeenCalled();
  });

  it("routes Grok web search through plugin webSearch.baseUrl", async () => {
    const mockFetch = installXaiWebSearchFetch();
    const inlineCitation = { start_index: 0, end_index: 8, url: "https://example.test/source" };
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        output: [{ type: "message", content: [{ type: "output_text", text: "Grounded" }] }],
        inline_citations: [inlineCitation],
      }),
    );
    const result = await search("OpenClaw Grok proxy test", {
      config: xaiPluginConfig({
        webSearch: {
          apiKey: "xai-config-test",
          baseUrl: "https://api.x.ai/proxy/v1/",
          inlineCitations: true,
          model: "grok-4-fast-reasoning",
        },
      }),
      searchConfig: { provider: "grok" },
    });

    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("https://api.x.ai/proxy/v1/responses");
    expect(firstFetchBody(mockFetch)).toMatchObject({
      model: "grok-4-fast",
      store: false,
      tools: [{ type: "web_search" }],
    });
    expect(result.inlineCitations).toEqual([inlineCitation]);
  });

  it("reports missing xAI web search answers without blaming JSON decoding", async () => {
    installXaiWebSearchFetch({ status: "incomplete", output: [] });
    await expect(search("OpenClaw")).rejects.toThrow(
      "xAI web search failed: no answer text returned; try a simpler request",
    );
  });

  it("converts internal xAI timeout aborts into structured tool errors", async () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(search("OpenClaw timeout")).rejects.toMatchObject({
      name: "TimeoutError",
      cause: abort,
      code: "ETIMEDOUT",
      timeoutMs: 60_000,
    });
  });

  it("bounds actual generic xAI provider content after special-token expansion", async () => {
    installXaiWebSearchFetch({ output_text: "<s>".repeat(6_666), citations: [] });
    const result = await search("bounded sanitized xAI answer");

    expect(result.truncated).toBe(true);
    expect(String(result.content).length).toBeLessThan(20_200);
    expect(String(result.content)).not.toContain("<s>");
  });

  it("preserves caller abort identity through the registered generic xAI provider", async () => {
    const controller = new AbortController();
    const reason = new DOMException("operator cancelled generic search", "AbortError");
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
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    await expect(
      search("generic xAI provider cancellation", undefined, controller.signal),
    ).rejects.toBe(reason);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(transportSignal?.reason).toBe(reason);
  });

  it("does not cache a Grok result completed after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("Grok search cancelled after response");
    const mockFetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return xaiAnswerResponse("Cancelled Grok answer");
      })
      .mockResolvedValueOnce(xaiAnswerResponse("Recovered Grok answer"));
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    const tool = requireXaiWebSearchTool();
    const query = "unique Grok late-cancel cache regression";

    await expect(tool.execute({ query }, { signal: controller.signal })).rejects.toBe(reason);
    const recovered = await tool.execute({ query });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(recovered.content).toContain("Recovered Grok answer");
  });

  it("bypasses populated Grok cache reads and writes at zero TTL", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const mockFetch = installXaiWebSearchFetch(answerPayload("Fresh Grok answer"));
    const cachedSearch = cacheSearch("Grok zero TTL cache policy true");
    mockFetch.mockResolvedValueOnce(xaiAnswerResponse("Original Grok answer"));
    await cachedSearch(15);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const uncached = await cachedSearch(0);
      expect(uncached.cached).toBeUndefined();
      expect(uncached.content).toContain("Fresh Grok answer");
    }
    const enabled = await cachedSearch(15);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(enabled).toMatchObject({
      cached: true,
      content: expect.stringContaining("Original Grok answer"),
    });
  });

  it("applies a shortened Grok cache TTL to an existing result", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const mockFetch = installXaiWebSearchFetch(
      answerPayload("Fresh Grok answer"),
    ).mockResolvedValueOnce(xaiAnswerResponse("Original Grok answer"));
    const cachedSearch = cacheSearch("Grok shortened TTL cache policy");
    await cachedSearch(15);
    now.mockReturnValue(1_060_000);

    const refreshed = await cachedSearch(1);
    const cached = await cachedSearch(1);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(refreshed.cached).toBeUndefined();
    expect(refreshed.content).toContain("Fresh Grok answer");
    expect(cached).toMatchObject({ cached: true, content: refreshed.content });
  });

  it("does not contact the generic xAI provider when the caller is already cancelled", async () => {
    const mockFetch = installXaiWebSearchFetch();
    const controller = new AbortController();
    const reason = new Error("generic xAI request cancelled before billing");
    controller.abort(reason);
    await expect(search("cancelled generic request", undefined, controller.signal)).rejects.toBe(
      reason,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("xai provider models", () => {
  it("resolves curated rows and their aliases from the manifest", () => {
    expect(resolveXaiCatalogEntry("xai/GROK-4.3")).toMatchObject({
      id: "grok-4.3",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    });
  });

  it("builds forward-compatible runtime models for newer Grok ids", () => {
    const expectModel = (input: string, id: string, fields: Record<string, unknown> = {}) => {
      expect(resolveForwardModel(input)).toEqual(
        expect.objectContaining({
          provider: "xai",
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
          reasoning: true,
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          id,
          ...fields,
        }),
      );
    };
    const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const thinking = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" };
    expectModel("grok-4-1-fast", "grok-4-1-fast", { cost: zeroCost });
    expectModel("grok-4.5-latest", "grok-4.5", {
      thinkingLevelMap: { off: null, ...thinking },
      input: ["text", "image"],
      contextWindow: 500_000,
    });
    expectModel("grok-4.3-latest", "grok-4.3", {
      thinkingLevelMap: { off: "none", ...thinking },
      input: ["text", "image"],
    });
    expectModel("grok-4.20-0309-reasoning", "grok-4.20-0309-reasoning", {
      input: ["text", "image"],
      maxTokens: 30_000,
    });
    expectModel("grok-3-mini-fast", "grok-3-mini-fast", { input: ["text"], cost: zeroCost });
  });

  it("refuses the unsupported multi-agent endpoint ids", () => {
    expect(resolveForwardModel("grok-4.20-multi-agent-experimental-beta-0304")).toBeUndefined();
  });
});
