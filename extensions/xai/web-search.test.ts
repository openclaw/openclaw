import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createNonExitingRuntime } from "openclaw/plugin-sdk/runtime-env";
import { jsonResponse, withEnvAsync, withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { resolveXaiForwardCompatModel } from "./provider-models.js";
import { createXaiWebSearchProvider as createXaiWebSearchContractProvider } from "./web-search-contract-api.js";
import { createXaiWebSearchProvider } from "./web-search.js";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn().mockResolvedValue({ source: "test", mode: "api-key" }),
}));

const providerAuthMocks = vi.hoisted(() => ({
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
    resolveApiKeyForProvider: providerAuthRuntimeMocks.resolveApiKeyForProvider,
  };
});

const resolveAuth = providerAuthRuntimeMocks.resolveApiKeyForProvider;

function profileAuth(
  apiKey: string,
  mode: "oauth" | "api-key" = "oauth",
  profileId = "xai:default",
) {
  return { apiKey, source: `profile:${profileId}`, mode, profileId };
}

function xaiAnswerResponse(text: string): Response {
  return jsonResponse({
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text }],
      },
    ],
  });
}

function installXaiWebSearchFetch(...responses: Response[]) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve(xaiAnswerResponse("Grounded Grok answer")),
  );
  if (responses.length) {
    mockFetch.mockReset();
  }
  for (const response of responses) {
    mockFetch.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}

function firstFetchUrl(mockFetch: ReturnType<typeof installXaiWebSearchFetch>) {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected xai web search fetch call");
  }
  const [url] = call;
  return String(url);
}

function firstFetchBody(mockFetch: ReturnType<typeof installXaiWebSearchFetch>) {
  const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
}

function fetchCallHeader(
  mockFetch: { mock: { calls: unknown[][] } },
  index: number,
  name: string,
): string | undefined {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers).get(name) ?? undefined;
}

function xaiPluginConfig({
  enabled,
  webSearch,
  xSearch,
}: {
  enabled?: boolean;
  webSearch?: Record<string, unknown>;
  xSearch?: Record<string, unknown>;
}) {
  return {
    plugins: {
      entries: {
        xai: {
          ...(enabled === undefined ? {} : { enabled }),
          config: {
            ...(webSearch ? { webSearch } : {}),
            ...(xSearch ? { xSearch } : {}),
          },
        },
      },
    },
  };
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

const defaultAgentConfig = {
  agents: {
    entries: { main: { agentDir: "/tmp/openclaw-xai-main-agent" } },
  },
};

function createAuthSearchTool() {
  return requireXaiWebSearchTool({
    config: {
      ...defaultAgentConfig,
      tools: { web: { search: { provider: "grok" } } },
    },
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
  providerAuthMocks.listUsableProviderAuthProfileIdsAsync.mockReset();
  providerAuthMocks.listUsableProviderAuthProfileIdsAsync.mockResolvedValue({
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
      const maybeTool = requireXaiWebSearchTool({
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

      const result = await maybeTool.execute({ query: "OpenClaw" });
      expect(result.error).toBe("missing_xai_api_key");
      expect(result.message).toContain("use web_fetch for a specific URL or the browser tool");
    });
  });

  it("uses the active agentDir for xAI OAuth web search auth", async () => {
    resolveAuth.mockResolvedValue(profileAuth("active-agent-oauth-token", "oauth", "xai:active"));
    const mockFetch = installXaiWebSearchFetch();
    const tool = requireXaiWebSearchTool({
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

    await tool.execute({ query: "OpenClaw Grok active agent OAuth web search" });

    expect(resolveAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-active-agent",
      }),
    );
    expect(fetchCallHeader(mockFetch, 0, "Authorization")).toBe("Bearer active-agent-oauth-token");
  });

  it("refreshes xAI OAuth auth and retries web search after a 401", async () => {
    resolveAuth
      .mockResolvedValueOnce(profileAuth("expired-oauth-token"))
      .mockResolvedValueOnce(profileAuth("fresh-oauth-token"));
    const mockFetch = installXaiWebSearchFetch(
      new Response("expired", { status: 401, statusText: "Unauthorized" }),
      xaiAnswerResponse("Fresh OAuth Grok answer"),
    );
    const tool = createAuthSearchTool();

    const result = await tool.execute({ query: "OpenClaw Grok OAuth refresh test" });

    expect(result.content).toContain("Fresh OAuth Grok answer");
    expect(resolveAuth).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "xai",
        cfg: expect.objectContaining(defaultAgentConfig),
        profileId: "xai:default",
        lockedProfile: true,
        forceRefresh: true,
      }),
    );
    expect(fetchCallHeader(mockFetch, 0, "Authorization")).toBe("Bearer expired-oauth-token");
    expect(fetchCallHeader(mockFetch, 1, "Authorization")).toBe("Bearer fresh-oauth-token");
  });

  it("falls back to an xAI API-key auth profile when stale OAuth remains first", async () => {
    resolveAuth
      .mockResolvedValueOnce(profileAuth("expired-oauth-token"))
      .mockResolvedValueOnce(profileAuth("expired-oauth-token"))
      .mockResolvedValueOnce(profileAuth("expired-oauth-token"))
      .mockResolvedValueOnce(profileAuth("xai-profile-api-key", "api-key", "xai:key"));
    providerAuthMocks.listUsableProviderAuthProfileIdsAsync.mockResolvedValue({
      agentDir: "/tmp/openclaw-xai-main-agent",
      profileIds: ["xai:key"],
    });
    const mockFetch = installXaiWebSearchFetch(
      new Response("revoked", { status: 401, statusText: "Unauthorized" }),
      xaiAnswerResponse("Profile API key Grok answer"),
    );
    const tool = createAuthSearchTool();

    const result = await tool.execute({ query: "OpenClaw Grok profile fallback test" });

    expect(result.content).toContain("Profile API key Grok answer");
    expect(resolveAuth).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        provider: "xai",
        agentDir: "/tmp/openclaw-xai-main-agent",
        profileId: "xai:key",
        lockedProfile: true,
      }),
    );
    expect(fetchCallHeader(mockFetch, 1, "Authorization")).toBe("Bearer xai-profile-api-key");
  });

  it("falls back to env auth after a stale xAI API-key auth profile returns unauthorized", async () => {
    resolveAuth
      .mockResolvedValueOnce(profileAuth("stale-profile-key", "api-key"))
      .mockResolvedValueOnce({
        apiKey: "xai-env-fallback-key",
        source: "XAI_API_KEY",
        mode: "api-key",
      });
    const mockFetch = installXaiWebSearchFetch(
      new Response("stale api key", { status: 401, statusText: "Unauthorized" }),
      xaiAnswerResponse("Env fallback Grok answer"),
    );
    const tool = createAuthSearchTool();

    const result = await tool.execute({ query: "OpenClaw Grok API-key fallback test" });

    expect(result.content).toContain("Env fallback Grok answer");
    expect(resolveAuth).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "xai",
        cfg: expect.objectContaining(defaultAgentConfig),
        credentialPrecedence: "env-first",
      }),
    );
    expect(fetchCallHeader(mockFetch, 0, "Authorization")).toBe("Bearer stale-profile-key");
    expect(fetchCallHeader(mockFetch, 1, "Authorization")).toBe("Bearer xai-env-fallback-key");
  });

  it("offers plugin-owned xSearch setup after Grok is selected", async () => {
    const provider = createXaiWebSearchProvider();
    const select = vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("grok-4.3");
    const prompter = createTestWizardPrompter({
      select: select as never,
    });

    const next = await provider.runSetup?.({
      config: {
        ...xaiPluginConfig({
          enabled: true,
          webSearch: { apiKey: "xai-test-key" },
        }),
        tools: {
          web: {
            search: {
              provider: "grok",
              enabled: true,
            },
          },
        },
      },
      runtime: createNonExitingRuntime(),
      prompter,
    });

    const xSearch = next?.plugins?.entries?.xai?.config?.xSearch as
      | { enabled?: boolean; model?: string }
      | undefined;
    expect(xSearch?.enabled).toBe(true);
    expect(xSearch?.model).toBe("grok-4.3");
  });

  it("keeps explicit xSearch disablement untouched during provider-owned setup", async () => {
    const provider = createXaiWebSearchProvider();
    const config = {
      ...xaiPluginConfig({ xSearch: { enabled: false } }),
      tools: {
        web: {
          search: {
            provider: "grok",
            enabled: true,
          },
        },
      },
    };
    const prompter = createTestWizardPrompter();

    const next = await provider.runSetup?.({
      config,
      runtime: createNonExitingRuntime(),
      prompter,
    });

    expect(next).toEqual(config);
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
    const tool = requireXaiWebSearchTool({
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

    const result = await tool.execute({ query: "OpenClaw Grok proxy test" });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/proxy/v1/responses");
    expect(firstFetchBody(mockFetch)).toMatchObject({
      model: "grok-4-fast",
      store: false,
      tools: [{ type: "web_search" }],
    });
    expect(result.inlineCitations).toEqual([inlineCitation]);
  });

  it("reports missing xAI web search answers without blaming JSON decoding", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve(jsonResponse({ status: "incomplete", output: [] })),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    const tool = requireXaiWebSearchTool();

    await expect(tool.execute({ query: "OpenClaw" })).rejects.toThrow(
      "xAI web search failed: no answer text returned; try a simpler request",
    );
  });

  it("converts internal xAI timeout aborts into structured tool errors", async () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    const tool = requireXaiWebSearchTool();
    await expect(tool.execute({ query: "OpenClaw timeout" })).rejects.toMatchObject({
      name: "TimeoutError",
      cause: abort,
      code: "ETIMEDOUT",
      timeoutMs: 60_000,
    });
  });

  it("bounds actual generic xAI provider content after special-token expansion", async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({ output_text: "<s>".repeat(6_666), citations: [] }),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    const tool = requireXaiWebSearchTool();

    const result = await tool.execute({ query: "bounded sanitized xAI answer" });

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
    const tool = requireXaiWebSearchTool();

    await expect(
      tool.execute({ query: "generic xAI provider cancellation" }, { signal: controller.signal }),
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
    const mockFetch = vi.fn(async () => xaiAnswerResponse("Fresh Grok answer"));
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    const query = "Grok zero TTL cache policy true";
    const search = cacheSearch(query);
    mockFetch.mockResolvedValueOnce(xaiAnswerResponse("Original Grok answer"));
    await search(15);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const uncached = await search(0);
      expect(uncached.cached).toBeUndefined();
      expect(uncached.content).toContain("Fresh Grok answer");
    }
    const enabled = await search(15);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(enabled.cached).toBe(true);
    expect(enabled.content).toContain("Original Grok answer");
  });

  it("applies a shortened Grok cache TTL to an existing result", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const mockFetch = vi
      .fn(async () => xaiAnswerResponse("Fresh Grok answer"))
      .mockResolvedValueOnce(xaiAnswerResponse("Original Grok answer"));
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
    const query = "Grok shortened TTL cache policy";
    const search = cacheSearch(query);
    await search(15);
    now.mockReturnValue(1_060_000);

    const refreshed = await search(1);
    const cached = await search(1);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(refreshed.cached).toBeUndefined();
    expect(refreshed.content).toContain("Fresh Grok answer");
    expect(cached.cached).toBe(true);
    expect(cached.content).toBe(refreshed.content);
  });

  it("does not contact the generic xAI provider when the caller is already cancelled", async () => {
    const mockFetch = installXaiWebSearchFetch();
    const controller = new AbortController();
    const reason = new Error("generic xAI request cancelled before billing");
    controller.abort(reason);
    const tool = requireXaiWebSearchTool();

    await expect(
      tool.execute({ query: "cancelled generic request" }, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("xai provider models", () => {
  it("resolves curated rows and their aliases from the manifest", () => {
    const grok43 = {
      id: "grok-4.3",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
    };
    expect(resolveXaiCatalogEntry("xai/GROK-4.3")).toMatchObject(grok43);
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
    const model = resolveForwardModel("grok-4.20-multi-agent-experimental-beta-0304");

    expect(model).toBeUndefined();
  });
});
