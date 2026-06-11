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

function parseFirstRequestBody(mockFetch: ReturnType<typeof installXSearchFetch>) {
  const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  const requestBody = request?.body;
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
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("api.x.ai/v1/responses");
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
              id: "1580661436132757506",
              url: "https://twitter.com/Twitter/status/1580661436132757506",
              text: "a hit Tweet",
              created_at: "Thu Oct 13 20:47:08 +0000 2022",
              created_timestamp: 1665694028,
              author: { name: "Twitter", screen_name: "Twitter" },
              likes: 43852,
              reposts: 2422,
              quotes: 12,
              replies: 4675,
              views: 100000,
              media: {
                photos: [{ type: "photo", url: "https://pbs.twimg.com/media/example.jpg" }],
              },
            },
          }),
      } as Response),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(mockFetch));
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
    expect(details.post).toMatchObject({ id: "1580661436132757506" });
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

    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("https://api.x.ai/xai-search/v1/responses");
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

    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("https://api.x.ai/legacy/v1/responses");
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

    expect(String(mockFetch.mock.calls[0]?.[0])).toBe("https://api.x.ai/shared/v1/responses");
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

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer xai-plugin-key",
    );
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

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer x-search-runtime-key",
    );
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

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer xai-legacy-key",
    );
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

    const request = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((request?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer migrated-runtime-key",
    );
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
