import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("xai web search configured credential resolution", () => {
  it("uses plugins.entries.xai.config.webSearch.apiKey when legacy searchConfig is empty", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authHeader = new Headers(init?.headers).get("authorization");
      expect(authHeader).toBe("Bearer xai-config-key"); // pragma: allowlist secret

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "hello from mock" }],
            },
          ],
          citations: ["https://example.com"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const { createXaiWebSearchProvider } = await import("./web-search.js");
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      searchConfig: {},
      config: {
        plugins: {
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "xai-config-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      } as any,
    });

    expect(tool).not.toBeNull();

    const result = await tool!.execute({ query: "hello" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ provider: "grok" });
  });

  it("prefers plugins.entries.xai.config.webSearch.apiKey over legacy searchConfig.grok.apiKey when both are set", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authHeader = new Headers(init?.headers).get("authorization");
      expect(authHeader).toBe("Bearer xai-config-key"); // pragma: allowlist secret

      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "hello from mock" }],
            },
          ],
          citations: ["https://example.com"],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const { createXaiWebSearchProvider } = await import("./web-search.js");
    const provider = createXaiWebSearchProvider();
    const tool = provider.createTool({
      searchConfig: {
        grok: {
          apiKey: "legacy-config-key", // pragma: allowlist secret
        },
      },
      config: {
        plugins: {
          entries: {
            xai: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: "xai-config-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
      } as any,
    });

    expect(tool).not.toBeNull();

    const result = await tool!.execute({ query: "hello-precedence" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ provider: "grok" });
  });
});
