import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

describe("ollama web search provider", () => {
  let createOllamaWebSearchProvider: typeof import("./web-search-provider.js").createOllamaWebSearchProvider;
  let runOllamaWebSearch: typeof import("./web-search-provider.js").runOllamaWebSearch;
  let testing: typeof import("./web-search-provider.js").__testing;

  beforeAll(async () => {
    ({
      createOllamaWebSearchProvider,
      runOllamaWebSearch,
      __testing: testing,
    } = await import("./web-search-provider.js"));
  });

  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers a keyless web search provider", () => {
    const webSearchProviders: unknown[] = [];

    plugin.register({
      registerMemoryEmbeddingProvider() {},
      registerProvider() {},
      registerWebSearchProvider(provider: unknown) {
        webSearchProviders.push(provider);
      },
    } as never);

    expect(webSearchProviders).toHaveLength(1);
    expect(webSearchProviders[0]).toMatchObject({
      id: "ollama",
      label: "Ollama Web Search",
      requiresCredential: false,
      envVars: [],
    });
  });

  it("uses the configured Ollama host and enables the plugin in config", () => {
    const provider = createOllamaWebSearchProvider();
    if (!provider.applySelectionConfig) {
      throw new Error("Expected applySelectionConfig to be defined");
    }

    const applied = provider.applySelectionConfig({});

    expect(provider.credentialPath).toBe("");
    expect(applied.plugins?.entries?.ollama?.enabled).toBe(true);
    expect(
      testing.resolveOllamaWebSearchBaseUrl({
        models: {
          providers: {
            ollama: {
              baseUrl: "http://ollama.local:11434/v1",
              api: "ollama",
              models: [],
            },
          },
        },
      }),
    ).toBe("http://ollama.local:11434");
  });

  it("maps generic search args into the Ollama experimental search endpoint", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          results: [
            {
              title: "OpenClaw",
              url: "https://openclaw.ai/docs",
              content: "Gateway docs and setup details",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
      release,
    });

    const provider = createOllamaWebSearchProvider();
    const tool = provider.createTool({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://ollama.local:11434/v1",
              api: "ollama",
              models: [],
            },
          },
        },
      },
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({ query: "openclaw docs", count: 3 });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://ollama.local:11434/api/experimental/web_search",
        auditContext: "ollama-web-search.search",
      }),
    );
    expect(
      JSON.parse(
        String(
          (
            fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
              init?: { body?: string };
            }
          ).init?.body,
        ),
      ),
    ).toEqual({
      query: "openclaw docs",
      max_results: 3,
    });
    expect(result).toMatchObject({
      query: "openclaw docs",
      provider: "ollama",
      count: 1,
      results: [{ url: "https://openclaw.ai/docs" }],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("surfaces Ollama signin guidance for 401 responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("", { status: 401 }),
      release: vi.fn(async () => {}),
    });

    await expect(runOllamaWebSearch({ query: "latest openclaw release" })).rejects.toThrow(
      "ollama signin",
    );
  });

  it("warns when Ollama is not reachable during setup without cancelling", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));

    const notes: Array<{ title?: string; message: string }> = [];
    const config: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama.local:11434/v1",
            api: "ollama",
            models: [],
          },
        },
      },
    };

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter: {
        note: async (message: string, title?: string) => {
          notes.push({ title, message });
        },
      },
    });

    expect(next).toBe(config);
    expect(notes).toEqual([
      expect.objectContaining({
        title: "Ollama Web Search",
        message: expect.stringContaining("requires Ollama to be running"),
      }),
    ]);
  });

  it("resolves env var when config apiKey is a marker string", () => {
    const original = process.env.OLLAMA_API_KEY;
    try {
      process.env.OLLAMA_API_KEY = "real-secret-from-env";
      const key = testing.resolveOllamaWebSearchApiKey({
        models: {
          providers: {
            ollama: {
              apiKey: "OLLAMA_API_KEY",
              baseUrl: "http://localhost:11434",
              api: "ollama",
              models: [],
            },
          },
        },
      });
      expect(key).toBe("real-secret-from-env");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }
  });

  it("warns when ollama signin is missing during setup without cancelling", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({ error: "not signed in", signin_url: "https://ollama.com/signin" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      });

    const notes: Array<{ title?: string; message: string }> = [];
    const config: OpenClawConfig = {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama.local:11434/v1",
            api: "ollama",
            models: [],
          },
        },
      },
    };

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter: {
        note: async (message: string, title?: string) => {
          notes.push({ title, message });
        },
      },
    });

    expect(next).toBe(config);
    expect(notes).toEqual([
      expect.objectContaining({
        title: "Ollama Web Search",
        message: expect.stringContaining("Ollama Web Search requires `ollama signin`."),
      }),
    ]);
    expect(notes[0]?.message).toContain("https://ollama.com/signin");
  });
});
