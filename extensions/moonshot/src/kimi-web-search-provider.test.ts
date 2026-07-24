// Moonshot tests cover kimi web search provider plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { withEnv, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "../test-api.js";
import { createKimiWebSearchProvider } from "./kimi-web-search-provider.js";

const kimiApiKeyEnv = ["KIMI_API", "KEY"].join("_");
const moonshotApiKeyEnv = ["MOONSHOT_API", "KEY"].join("_");
const kimiSecretRefApiKeyEnv = ["KIMI_WEB_SEARCH_REF", "KEY"].join("_");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function executeKimiSearch(
  query: string,
  config: OpenClawConfig = {},
): Promise<Record<string, unknown>> {
  const provider = createKimiWebSearchProvider();
  const tool = provider.createTool({ config, searchConfig: {} });
  if (!tool) {
    throw new Error("Expected tool definition");
  }
  return await tool.execute({ query });
}

function expectStringFieldContains(result: Record<string, unknown>, field: string, text: string) {
  const value = result[field];
  expect(typeof value).toBe("string");
  expect(value).toContain(text);
}

describe("kimi web search provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("points missing-key users to fetch/browser alternatives", async () => {
    await withEnvAsync({ KIMI_API_KEY: undefined, MOONSHOT_API_KEY: undefined }, async () => {
      const provider = createKimiWebSearchProvider();
      const tool = provider.createTool({ config: {}, searchConfig: {} });
      if (!tool) {
        throw new Error("Expected tool definition");
      }

      const result = await tool.execute({ query: "OpenClaw docs" });

      expect(result.error).toBe("missing_kimi_api_key");
      expectStringFieldContains(
        result,
        "message",
        "use web_fetch for a specific URL or the browser tool",
      );
    });
  });

  it("resolves configured env SecretRef apiKey", () => {
    const configuredApiKey = {
      source: "env",
      provider: "default",
      id: kimiSecretRefApiKeyEnv,
    };

    withEnv(
      {
        [kimiSecretRefApiKeyEnv]: "sample",
        [kimiApiKeyEnv]: undefined,
        [moonshotApiKeyEnv]: undefined,
      },
      () => {
        expect(testing.resolveKimiApiKey({ apiKey: configuredApiKey })).toBe("sample");
      },
    );
  });

  it("does not use ambient env fallback when configured env SecretRef is missing", () => {
    const configuredApiKey = {
      source: "env",
      provider: "default",
      id: kimiSecretRefApiKeyEnv,
    };

    withEnv(
      {
        [kimiSecretRefApiKeyEnv]: undefined,
        [kimiApiKeyEnv]: "dummy",
        [moonshotApiKeyEnv]: "example",
      },
      () => {
        expect(testing.resolveKimiApiKey({ apiKey: configuredApiKey })).toBeUndefined();
      },
    );
  });

  it("resolves configured env SecretRef apiKey through plugin config", async () => {
    const configuredApiKey = {
      source: "env",
      provider: "default",
      id: kimiSecretRefApiKeyEnv,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        search_results: [{ url: "https://example.test/kimi" }],
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Kimi configured ref answer." },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync(
      {
        [kimiSecretRefApiKeyEnv]: "sample",
        [kimiApiKeyEnv]: undefined,
        [moonshotApiKeyEnv]: undefined,
      },
      async () => {
        const result = await executeKimiSearch("kimi configured SecretRef search", {
          plugins: {
            entries: {
              moonshot: {
                config: { webSearch: { apiKey: configuredApiKey } },
              },
            },
          },
        });

        const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(result).not.toHaveProperty("error");
        expect(requestInit?.headers).toMatchObject({ Authorization: "Bearer sample" });
      },
    );
  });

  it("uses configured model and base url overrides with sane defaults", () => {
    expect(testing.resolveKimiModel()).toBe("kimi-k2.6");
    expect(testing.resolveKimiModel({ model: "kimi-k2" })).toBe("kimi-k2");
    expect(testing.resolveKimiBaseUrl()).toBe("https://api.moonshot.ai/v1");
    expect(testing.resolveKimiBaseUrl({ baseUrl: "https://kimi.example/v1" })).toBe(
      "https://kimi.example/v1",
    );
  });

  it("inherits native Moonshot chat baseUrl when kimi baseUrl is unset", () => {
    const cnConfig = {
      models: { providers: { moonshot: { baseUrl: "https://api.moonshot.cn/v1" } } },
    } as unknown as OpenClawConfig;
    const cnConfigWithTrailingSlash = {
      models: { providers: { moonshot: { baseUrl: "https://api.moonshot.cn/v1/" } } },
    } as unknown as OpenClawConfig;

    expect(testing.resolveKimiBaseUrl(undefined, cnConfig)).toBe("https://api.moonshot.cn/v1");
    expect(testing.resolveKimiBaseUrl(undefined, cnConfigWithTrailingSlash)).toBe(
      "https://api.moonshot.cn/v1",
    );
  });

  it("does not inherit non-native Moonshot baseUrl for web search", () => {
    const proxyConfig = {
      models: { providers: { moonshot: { baseUrl: "https://proxy.example/v1" } } },
    } as unknown as OpenClawConfig;

    expect(testing.resolveKimiBaseUrl(undefined, proxyConfig)).toBe("https://api.moonshot.ai/v1");
  });

  it("keeps explicit kimi baseUrl over models.providers.moonshot.baseUrl", () => {
    const moonshotConfig = {
      models: { providers: { moonshot: { baseUrl: "https://api.moonshot.cn/v1" } } },
    } as unknown as OpenClawConfig;

    expect(
      testing.resolveKimiBaseUrl({ baseUrl: "https://api.moonshot.ai/v1" }, moonshotConfig),
    ).toBe("https://api.moonshot.ai/v1");
  });

  it("extracts unique citations from search results and tool call arguments", () => {
    expect(
      testing.extractKimiCitations({
        search_results: [{ url: "https://a.test" }, { url: "https://b.test" }],
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    arguments: JSON.stringify({
                      url: "https://a.test",
                      search_results: [{ url: "https://c.test" }],
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
  });

  it("returns a structured failure for ungrounded chat-only responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "I cannot browse the internet." },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const result = await executeKimiSearch("kimi ungrounded chat fallback");

      expect(result.error).toBe("kimi_web_search_ungrounded");
      expect(result.provider).toBe("kimi");
      expectStringFieldContains(result, "message", "without native web-search grounding");
    });
  });

  it("reports malformed Kimi API JSON with a stable provider error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{ nope"));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      await expect(executeKimiSearch("kimi malformed response")).rejects.toThrow(
        "Kimi API error: malformed JSON response",
      );
    });
  });

  it("rejects wrong-root Kimi success JSON with a stable provider error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      await expect(executeKimiSearch("kimi wrong root response")).rejects.toThrow(
        "Kimi API error: malformed JSON response",
      );
    });
  });

  it("rejects Kimi success JSON without a final message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      await expect(executeKimiSearch("kimi missing final message")).rejects.toThrow(
        "Kimi API error: malformed JSON response",
      );
    });
  });

  it("accepts final responses backed by Kimi web search tool replay", async () => {
    const toolArguments = JSON.stringify({
      query: "OpenClaw GitHub repository",
      usage: { total_tokens: 1200 },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "call-1",
                    function: {
                      name: "$web_search",
                      arguments: toolArguments,
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "OpenClaw is available on GitHub." },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const result = await executeKimiSearch("kimi grounded tool replay");

      expect(result.provider).toBe("kimi");
      expectStringFieldContains(result, "content", "OpenClaw is available on GitHub.");
      expect(result.citations).toEqual([]);
      expect(result).not.toHaveProperty("error");
    });
  });

  it("accepts final responses with search result citations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        search_results: [{ title: "OpenClaw", url: "https://github.com/openclaw/openclaw" }],
        choices: [
          {
            finish_reason: "stop",
            message: { content: "OpenClaw is on GitHub." },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await withEnvAsync({ KIMI_API_KEY: "kimi-test-key" }, async () => {
      const result = await executeKimiSearch("kimi grounded citation");

      expect(result.provider).toBe("kimi");
      expectStringFieldContains(result, "content", "OpenClaw is on GitHub.");
      expect(result.citations).toEqual(["https://github.com/openclaw/openclaw"]);
      expect(result).not.toHaveProperty("error");
    });
  });

  it("returns original tool arguments as tool content", () => {
    const rawArguments = '  {"query":"MacBook Neo","usage":{"total_tokens":123}}  ';

    expect(
      testing.extractKimiToolResultContent({
        function: {
          arguments: rawArguments,
        },
      }),
    ).toBe(rawArguments);

    expect(
      testing.extractKimiToolResultContent({
        function: {
          arguments: "   ",
        },
      }),
    ).toBeUndefined();
  });

  it("uses config apiKey when provided", () => {
    expect(testing.resolveKimiApiKey({ apiKey: "kimi-test-key" })).toBe("kimi-test-key");
  });

  it("falls back to env apiKey", () => {
    withEnv({ [kimiApiKeyEnv]: "kimi-env-key" }, () => {
      expect(testing.resolveKimiApiKey({})).toBe("kimi-env-key");
    });
  });
});
