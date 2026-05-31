import { readFileSync } from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type {
  AnyAgentTool,
  OpenClawPluginToolFactory,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
import { buildPluginApi } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import xaiPlugin from "./index.js";
import { createXSearchTool } from "./x-search.js";

function registerXaiTools(config: Record<string, unknown> = {}) {
  const tools: Array<AnyAgentTool | OpenClawPluginToolFactory> = [];
  const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const api = buildPluginApi({
    id: "xai",
    name: "xAI Plugin",
    source: "test",
    registrationMode: "full",
    config: config as OpenClawConfig,
    pluginConfig: {},
    runtime: {} as PluginRuntime,
    logger: noopLogger,
    resolvePath: (input) => input,
    handlers: {
      registerTool(tool) {
        tools.push(tool as never);
      },
    },
  });
  xaiPlugin.register(api);
  return tools;
}

function installXSearchFetch(payload?: Record<string, unknown>) {
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          payload ?? {
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: "Found X posts",
                    annotations: [{ type: "url_citation", url: "https://x.com/openclaw/status/1" }],
                  },
                ],
              },
            ],
            citations: ["https://x.com/openclaw/status/1"],
          },
        ),
    } as Response),
  );
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}

function installFxTwitterPostFetch(params?: {
  id?: string;
  handle?: string;
  createdTimestamp?: number;
}) {
  const id = params?.id ?? "1580661436132757506";
  const handle = params?.handle ?? "Twitter";
  const createdTimestamp = params?.createdTimestamp ?? 1665694028;
  const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          code: 200,
          status: {
            type: "status",
            id,
            url: `https://twitter.com/${handle}/status/${id}`,
            text: "a hit Tweet",
            created_at: "Thu Oct 13 20:47:08 +0000 2022",
            created_timestamp: createdTimestamp,
            author: { name: handle, screen_name: handle },
            likes: 43852,
            reposts: 2422,
            quotes: 12,
            replies: 4675,
            views: 100000,
            media: {
              photos: [{ type: "photo", url: "https://pbs.twimg.com/media/example.jpg" }],
            },
            raw_text: "raw-only-injection",
            extra_payload: {
              prompt: "raw-only-prompt-injection",
            },
          },
        }),
    } as Response),
  );
  vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
  return mockFetch;
}

function firstFetchCall(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const [call] = mockFetch.mock.calls;
  if (!call) {
    throw new Error("expected x_search fetch call");
  }
  return call;
}

function firstFetchUrl(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const [url] = firstFetchCall(mockFetch);
  return String(url);
}

function firstFetchInit(mockFetch: ReturnType<typeof installXSearchFetch>): RequestInit {
  const [, init] = firstFetchCall(mockFetch);
  if (!init || typeof init !== "object" || Array.isArray(init)) {
    throw new Error("expected x_search fetch init");
  }
  return init as RequestInit;
}

function firstAuthorizationHeader(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const headers = firstFetchInit(mockFetch).headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("expected x_search request headers");
  }
  return (headers as Record<string, string>).Authorization;
}

function parseFirstRequestBody(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const requestBody = firstFetchInit(mockFetch).body;
  return JSON.parse(typeof requestBody === "string" ? requestBody : "{}") as Record<
    string,
    unknown
  >;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("xai plugin x_search registration", () => {
  it("keeps x_search in the default manifest tool set for key-free exact post reads", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { toolMetadata?: Record<string, { optional?: boolean }> };

    expect(manifest.toolMetadata?.x_search?.optional).not.toBe(true);
  });

  it("registers the lazy x_search tool without an xAI key so exact FxTwitter posts can run", async () => {
    const tools = registerXaiTools({});
    const tool = tools
      .filter((entry): entry is OpenClawPluginToolFactory => typeof entry === "function")
      .flatMap((factory) => {
        const registration = factory({ config: {}, runtimeConfig: {} });
        return Array.isArray(registration) ? registration : [registration];
      })
      .find((entry) => entry?.name === "x_search");

    expect(tool?.name).toBe("x_search");
    const result = await tool?.execute?.("x-search:missing-key", {
      query: "openclaw from:openclaw",
    });
    expect(result?.details).toMatchObject({ error: "missing_xai_api_key" });
  });
});

describe("xai x_search tool", () => {
  it("enables x_search when runtime config carries the shared xAI key", () => {
    const tool = createXSearchTool({
      config: {},
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "x-search-runtime-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("x_search");
  });

  it("enables x_search from an xAI auth profile and uses it for requests", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {},
      auth: {
        hasAuthForProvider: (providerId) => providerId === "xai",
        resolveApiKeyForProvider: async (providerId) =>
          providerId === "xai" ? "xai-profile-key" : undefined, // pragma: allowlist secret
      },
    });

    expect(tool?.name).toBe("x_search");
    await tool?.execute?.("x-search:auth-profile", {
      query: "auth profile search",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-profile-key");
  });

  it("enables x_search when the xAI plugin web search key is configured", () => {
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    expect(tool?.name).toBe("x_search");
  });

  it("uses the xAI Responses x_search tool with structured filters", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // pragma: allowlist secret
                },
                xSearch: {
                  model: "grok-4-1-fast-non-reasoning",
                  maxTurns: 2,
                },
              },
            },
          },
        },
      },
    });

    const result = await tool?.execute?.("x-search:1", {
      query: "dinner recipes",
      allowed_x_handles: ["openclaw"],
      excluded_x_handles: ["spam"],
      from_date: "2026-03-01",
      to_date: "2026-03-20",
      enable_image_understanding: true,
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(firstFetchUrl(mockFetch)).toContain("api.x.ai/v1/responses");
    const body = parseFirstRequestBody(mockFetch);
    expect(body.model).toBe("grok-4-1-fast-non-reasoning");
    expect(body.max_turns).toBe(2);
    expect(body.tools).toEqual([
      {
        type: "x_search",
        allowed_x_handles: ["openclaw"],
        excluded_x_handles: ["spam"],
        from_date: "2026-03-01",
        to_date: "2026-03-20",
        enable_image_understanding: true,
      },
    ]);
    expect((result?.details as { citations?: string[] } | undefined)?.citations).toEqual([
      "https://x.com/openclaw/status/1",
    ]);
  });

  it("reads an exact X post URL through key-free FxTwitter without an xAI key", async () => {
    const mockFetch = installFxTwitterPostFetch();
    const tool = createXSearchTool({ config: {} });

    const result = await tool?.execute?.("x-search:fxtwitter", {
      query: "https://x.com/Twitter/status/1580661436132757506",
    });

    expect(tool?.name).toBe("x_search");
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain(
      "https://api.fxtwitter.com/2/status/1580661436132757506",
    );
    const details = result?.details as { provider?: string; content?: string; post?: unknown };
    expect(details.provider).toBe("fxtwitter");
    expect(details.content).toContain("a hit Tweet");
    expect(details.content).toContain("likes: 43852");
    expect(details.post).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain("raw-only-injection");
    expect(JSON.stringify(details)).not.toContain("raw-only-prompt-injection");
  });

  it("bypasses stale xAI auth resolution for exact FxTwitter post URLs", async () => {
    installFxTwitterPostFetch();
    const resolveApiKeyForProvider = vi.fn(async () => {
      throw new Error("stale xAI OAuth profile");
    });
    const tool = createXSearchTool({
      config: {},
      auth: {
        hasAuthForProvider: (providerId) => providerId === "xai",
        resolveApiKeyForProvider,
      },
    });

    const result = await tool?.execute?.("x-search:fxtwitter-stale-auth", {
      query: "https://x.com/Twitter/status/1580661436132757506",
    });

    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(result?.details).toMatchObject({
      provider: "fxtwitter",
      statusId: "1580661436132757506",
    });
  });

  it("filters exact FxTwitter posts by allowed handle", async () => {
    installFxTwitterPostFetch({ id: "1580661436132757510", handle: "Twitter" });
    const tool = createXSearchTool({ config: {} });

    const result = await tool?.execute?.("x-search:fxtwitter-allowed-filter", {
      query: "https://x.com/Twitter/status/1580661436132757510",
      allowed_x_handles: ["openclaw"],
    });

    expect(result?.details).toMatchObject({
      provider: "fxtwitter",
      filtered: true,
      filterReason: "post_author_not_in_allowed_x_handles",
      handle: "Twitter",
    });
  });

  it("filters exact FxTwitter posts by excluded handle", async () => {
    installFxTwitterPostFetch({ id: "1580661436132757511", handle: "Twitter" });
    const tool = createXSearchTool({ config: {} });

    const result = await tool?.execute?.("x-search:fxtwitter-excluded-filter", {
      query: "https://x.com/Twitter/status/1580661436132757511",
      excluded_x_handles: ["twitter"],
    });

    expect(result?.details).toMatchObject({
      provider: "fxtwitter",
      filtered: true,
      filterReason: "post_author_in_excluded_x_handles",
      handle: "Twitter",
    });
  });

  it("filters exact FxTwitter posts outside the requested date range", async () => {
    installFxTwitterPostFetch({
      id: "1580661436132757512",
      handle: "Twitter",
      createdTimestamp: 1665694028,
    });
    const tool = createXSearchTool({ config: {} });

    const result = await tool?.execute?.("x-search:fxtwitter-date-filter", {
      query: "https://x.com/Twitter/status/1580661436132757512",
      from_date: "2026-01-01",
    });

    expect(result?.details).toMatchObject({
      provider: "fxtwitter",
      filtered: true,
      filterReason: "post_before_from_date",
      handle: "Twitter",
    });
  });

  it("keeps exact FxTwitter cache entries filter-safe", async () => {
    const mockFetch = installFxTwitterPostFetch({
      id: "1580661436132757513",
      handle: "Twitter",
    });
    const tool = createXSearchTool({ config: {} });

    const unfiltered = await tool?.execute?.("x-search:fxtwitter-cache-open", {
      query: "https://x.com/Twitter/status/1580661436132757513",
    });
    const filtered = await tool?.execute?.("x-search:fxtwitter-cache-filtered", {
      query: "https://x.com/Twitter/status/1580661436132757513",
      excluded_x_handles: ["Twitter"],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(unfiltered?.details).toMatchObject({ provider: "fxtwitter" });
    expect((unfiltered?.details as { filtered?: unknown } | undefined)?.filtered).toBeUndefined();
    expect(filtered?.details).toMatchObject({
      provider: "fxtwitter",
      filtered: true,
      filterReason: "post_author_in_excluded_x_handles",
    });
  });

  it("keeps generic x_search on the xAI missing-key path", async () => {
    const tool = createXSearchTool({ config: {} });

    const result = await tool?.execute?.("x-search:missing-key", {
      query: "openclaw from:openclaw",
    });

    expect(result?.details).toMatchObject({ error: "missing_xai_api_key" });
  });

  it("routes x_search through plugin-owned xSearch.baseUrl", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // pragma: allowlist secret
                },
                xSearch: {
                  enabled: true,
                  baseUrl: "https://api.x.ai/xai-search/v1/",
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:plugin-base-url", {
      query: "base url route",
    });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/xai-search/v1/responses");
  });

  it("falls back to Grok web search baseUrl for x_search", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "xai-legacy-key", // pragma: allowlist secret
                baseUrl: "https://api.x.ai/legacy/v1/",
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:legacy-grok-base-url", {
      query: "legacy base url route",
    });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/legacy/v1/responses");
  });

  it("shares plugin webSearch.baseUrl with x_search when xSearch.baseUrl is unset", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                  baseUrl: "https://api.x.ai/shared/v1/",
                },
                xSearch: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:web-search-base-url", {
      query: "shared base url route",
    });

    expect(firstFetchUrl(mockFetch)).toBe("https://api.x.ai/shared/v1/responses");
  });

  it("reuses the xAI plugin web search key for x_search requests", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:plugin-key", {
      query: "latest post from huntharo",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-plugin-key");
  });

  it("reports malformed x_search JSON as a provider error", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new SyntaxError("Unexpected token")),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
                xSearch: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:malformed-json", {
        query: "malformed x_search response probe",
      }),
    ).rejects.toThrow("xAI X search failed: malformed JSON response");
  });

  it("rejects x_search success JSON without answer text", async () => {
    const mockFetch = vi.fn((_input?: unknown, _init?: unknown) =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ output: [] }),
      } as Response),
    );
    global.fetch = withFetchPreconnect(mockFetch);
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key", // pragma: allowlist secret
                },
                xSearch: {
                  enabled: true,
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:missing-text", {
        query: "malformed x_search missing text probe",
      }),
    ).rejects.toThrow("xAI X search failed: malformed JSON response");
  });

  it("prefers the active runtime config for shared xAI keys", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "X_SEARCH_KEY_REF" },
                },
              },
            },
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "x-search-runtime-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:runtime-key", {
      query: "runtime key search",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer x-search-runtime-key");
  });

  it("reuses the legacy grok web search key for x_search requests", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "xai-legacy-key", // pragma: allowlist secret
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:legacy-key", {
      query: "latest legacy-key post from huntharo",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer xai-legacy-key");
  });

  it("uses migrated runtime auth when the source config still carries legacy x_search apiKey", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        tools: {
          web: {
            x_search: {
              apiKey: "legacy-x-search-key", // pragma: allowlist secret
              enabled: true,
            } as Record<string, unknown>,
          },
        },
      },
      runtimeConfig: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "migrated-runtime-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await tool?.execute?.("x-search:migrated-runtime-key", {
      query: "migrated runtime auth",
    });

    expect(firstAuthorizationHeader(mockFetch)).toBe("Bearer migrated-runtime-key");
  });

  it("rejects invalid date ordering before calling xAI", async () => {
    const mockFetch = installXSearchFetch();
    const tool = createXSearchTool({
      config: {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-config-test", // pragma: allowlist secret
                },
              },
            },
          },
        },
      },
    });

    await expect(
      tool?.execute?.("x-search:bad-dates", {
        query: "dinner recipes",
        from_date: "2026-03-20",
        to_date: "2026-03-01",
      }),
    ).rejects.toThrow(/from_date must be on or before to_date/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
