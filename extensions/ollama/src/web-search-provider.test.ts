import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOllamaWebSearchProvider as createContractOllamaWebSearchProvider } from "../web-search-contract-api.js";
import {
  __testing as testing,
  createOllamaWebSearchProvider,
  runOllamaWebSearch,
} from "./web-search-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

type OllamaProviderConfigOverride = Partial<{
  api: "ollama";
  apiKey: string;
  baseUrl: string;
  models: NonNullable<
    NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]
  >["models"];
}>;

function createOllamaConfig(provider: OllamaProviderConfigOverride = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        ollama: {
          baseUrl: "http://ollama.local:11434/v1",
          api: "ollama",
          models: [],
          ...provider,
        },
      },
    },
  };
}

function createOllamaConfigWithWebSearchBaseUrl(baseUrl: string): OpenClawConfig {
  return {
    ...createOllamaConfig(),
    plugins: {
      entries: {
        ollama: {
          config: {
            webSearch: {
              baseUrl,
            },
          },
        },
      },
    },
  };
}

function createSetupNotes() {
  const notes: Array<{ title?: string; message: string }> = [];
  return {
    notes,
    prompter: {
      note: async (message: string, title?: string) => {
        notes.push({ title, message });
      },
    },
  };
}

describe("ollama web search provider", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("registers a keyless web search provider", () => {
    expect(createContractOllamaWebSearchProvider()).toMatchObject({
      id: "ollama",
      label: "Ollama Web Search",
      requiresCredential: false,
      envVars: ["OLLAMA_API_KEY"],
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

  it("prefers the plugin web search base URL over the model provider host", () => {
    expect(
      testing.resolveOllamaWebSearchBaseUrl(
        createOllamaConfigWithWebSearchBaseUrl("http://localhost:11434/v1"),
      ),
    ).toBe("http://localhost:11434");
  });

  it("honors an explicit Ollama Cloud base URL", () => {
    expect(
      testing.resolveOllamaWebSearchBaseUrl(
        createOllamaConfig({
          baseUrl: "https://ollama.com",
        }),
      ),
    ).toBe("https://ollama.com");
  });

  it("prefers the stable Ollama search endpoint on the configured host", async () => {
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
      config: createOllamaConfig(),
    } as never);
    if (!tool) {
      throw new Error("Expected tool definition");
    }
    const result = await tool.execute({ query: "openclaw docs", count: 3 });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://ollama.local:11434/api/web_search",
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

  it("falls back to the experimental local endpoint when the stable local path returns 404", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            results: [
              {
                title: "OpenClaw",
                url: "https://openclaw.ai/docs",
                content: "Experimental endpoint still works",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      });

    await expect(
      runOllamaWebSearch({
        config: createOllamaConfig(),
        query: "openclaw docs",
      }),
    ).resolves.toMatchObject({
      provider: "ollama",
      count: 1,
    });

    expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0]?.url)).toEqual([
      "http://ollama.local:11434/api/web_search",
      "http://ollama.local:11434/api/experimental/web_search",
    ]);
  });

  it("falls back to Ollama Cloud after local 404s when a real api key is available", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            results: [
              {
                title: "OpenClaw",
                url: "https://openclaw.ai/docs",
                content: "Hosted fallback works",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      });

    const config = createOllamaConfig({
      apiKey: "OLLAMA_API_KEY",
    });
    const original = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "real-secret-from-env";

    try {
      await expect(
        runOllamaWebSearch({
          config,
          query: "openclaw docs",
        }),
      ).resolves.toMatchObject({
        provider: "ollama",
        count: 1,
      });
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }

    expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0]?.url)).toEqual([
      "http://ollama.local:11434/api/web_search",
      "http://ollama.local:11434/api/experimental/web_search",
      "https://ollama.com/api/web_search",
    ]);
    expect(
      (
        fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
          init?: { headers?: Record<string, string> };
        }
      ).init?.headers?.Authorization,
    ).toBeUndefined();
    expect(
      (
        fetchWithSsrFGuardMock.mock.calls[1]?.[0] as {
          init?: { headers?: Record<string, string> };
        }
      ).init?.headers?.Authorization,
    ).toBeUndefined();
    expect(
      (
        fetchWithSsrFGuardMock.mock.calls[2]?.[0] as {
          init?: { headers?: Record<string, string> };
        }
      ).init?.headers?.Authorization,
    ).toBe("Bearer real-secret-from-env");
  });

  it("sends a provider-configured bearer to local targets and skips the cloud fallback", async () => {
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          results: [
            {
              title: "OpenClaw",
              url: "https://openclaw.ai/docs",
              content: "Local bearer-gated host works",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
      release: vi.fn(async () => {}),
    });

    const original = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;

    try {
      await runOllamaWebSearch({
        config: createOllamaConfig({ apiKey: "local-host-bearer" }),
        query: "openclaw docs",
      });
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }

    expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0]?.url)).toEqual([
      "http://ollama.local:11434/api/web_search",
    ]);
    expect(
      (
        fetchWithSsrFGuardMock.mock.calls[0]?.[0] as {
          init?: { headers?: Record<string, string> };
        }
      ).init?.headers?.Authorization,
    ).toBe("Bearer local-host-bearer");
  });

  it("does not append the cloud fallback for a provider-config apiKey after local 404s", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      });

    const original = process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;

    try {
      await expect(
        runOllamaWebSearch({
          config: createOllamaConfig({ apiKey: "local-host-bearer" }),
          query: "openclaw docs",
        }),
      ).rejects.toThrow("Set OLLAMA_API_KEY for hosted Ollama web search");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }

    expect(fetchWithSsrFGuardMock.mock.calls.map((call) => call[0]?.url)).toEqual([
      "http://ollama.local:11434/api/web_search",
      "http://ollama.local:11434/api/experimental/web_search",
    ]);
  });

  it("surfaces the cloud-retry guidance when Ollama Cloud also returns 404", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      });

    const original = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "real-secret-from-env";

    try {
      await expect(
        runOllamaWebSearch({
          config: createOllamaConfig({ apiKey: "OLLAMA_API_KEY" }),
          query: "openclaw docs",
        }),
      ).rejects.toThrow("The Ollama Cloud retry also returned 404");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }
  });

  it("uses Ollama Cloud directly when the provider base URL is cloud", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          results: [
            {
              title: "OpenClaw",
              url: "https://openclaw.ai/docs",
              content: "Cloud path works",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
      release: vi.fn(async () => {}),
    });

    const original = process.env.OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = "real-secret-from-env";

    try {
      await expect(
        runOllamaWebSearch({
          config: createOllamaConfig({
            baseUrl: "https://ollama.com",
            apiKey: "OLLAMA_API_KEY",
          }),
          query: "openclaw docs",
        }),
      ).resolves.toMatchObject({
        provider: "ollama",
        count: 1,
      });
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock.mock.calls[0]?.[0]?.url).toBe(
      "https://ollama.com/api/web_search",
    );
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

  it("surfaces api key guidance for Ollama Cloud 401 responses", async () => {
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: new Response("", { status: 401 }),
      release: vi.fn(async () => {}),
    });

    await expect(
      runOllamaWebSearch({
        config: createOllamaConfig({
          baseUrl: "https://ollama.com",
        }),
        query: "latest openclaw release",
      }),
    ).rejects.toThrow("OLLAMA_API_KEY");
  });

  it("surfaces missing-endpoint guidance when the local host returns 404 without cloud fallback", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response("404 page not found", { status: 404 }),
        release: vi.fn(async () => {}),
      });

    await expect(
      runOllamaWebSearch({
        config: createOllamaConfig(),
        query: "latest openclaw release",
      }),
    ).rejects.toThrow("Set OLLAMA_API_KEY for hosted Ollama web search");
  });

  it("warns when Ollama is not reachable during setup without cancelling", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("connect failed"));

    const config = createOllamaConfig();
    const { notes, prompter } = createSetupNotes();

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter,
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
      const key = testing.resolveOllamaWebSearchApiKey(
        createOllamaConfig({
          apiKey: "OLLAMA_API_KEY",
          baseUrl: "http://localhost:11434",
        }),
      );
      expect(key).toBe("real-secret-from-env");
    } finally {
      if (original === undefined) {
        delete process.env.OLLAMA_API_KEY;
      } else {
        process.env.OLLAMA_API_KEY = original;
      }
    }
  });

  it("uses Ollama Cloud as a direct setup prerequisite path and warns when api key is missing", async () => {
    const config = createOllamaConfig({
      baseUrl: "https://ollama.com",
    });
    const { notes, prompter } = createSetupNotes();

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter,
    });

    expect(next).toBe(config);
    expect(notes).toEqual([
      expect.objectContaining({
        title: "Ollama Web Search",
        message: expect.stringContaining("OLLAMA_API_KEY"),
      }),
    ]);
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
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

    const config = createOllamaConfig();
    const { notes, prompter } = createSetupNotes();

    const next = await testing.warnOllamaWebSearchPrereqs({
      config,
      prompter,
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

  it("resolves local and hosted compatibility targets from config and api key state", () => {
    expect(
      testing.resolveOllamaWebSearchTargets({
        config: createOllamaConfig(),
        auth: { apiKey: undefined, source: "none" },
      }),
    ).toEqual([
      {
        kind: "local",
        baseUrl: "http://ollama.local:11434",
        path: "/api/web_search",
        url: "http://ollama.local:11434/api/web_search",
      },
      {
        kind: "local",
        baseUrl: "http://ollama.local:11434",
        path: "/api/experimental/web_search",
        url: "http://ollama.local:11434/api/experimental/web_search",
      },
    ]);

    expect(
      testing.resolveOllamaWebSearchTargets({
        config: createOllamaConfig(),
        auth: { apiKey: "real-secret-from-env", source: "env" },
      }),
    ).toEqual([
      {
        kind: "local",
        baseUrl: "http://ollama.local:11434",
        path: "/api/web_search",
        url: "http://ollama.local:11434/api/web_search",
      },
      {
        kind: "local",
        baseUrl: "http://ollama.local:11434",
        path: "/api/experimental/web_search",
        url: "http://ollama.local:11434/api/experimental/web_search",
      },
      {
        kind: "cloud",
        baseUrl: "https://ollama.com",
        path: "/api/web_search",
        url: "https://ollama.com/api/web_search",
      },
    ]);

    expect(
      testing.resolveOllamaWebSearchTargets({
        config: createOllamaConfig(),
        auth: { apiKey: "local-host-bearer", source: "provider-config" },
      }),
    ).toEqual([
      {
        kind: "local",
        baseUrl: "http://ollama.local:11434",
        path: "/api/web_search",
        url: "http://ollama.local:11434/api/web_search",
      },
      {
        kind: "local",
        baseUrl: "http://ollama.local:11434",
        path: "/api/experimental/web_search",
        url: "http://ollama.local:11434/api/experimental/web_search",
      },
    ]);

    expect(
      testing.resolveOllamaWebSearchTargets({
        config: createOllamaConfig({
          baseUrl: "https://ollama.com",
        }),
        auth: { apiKey: undefined, source: "none" },
      }),
    ).toEqual([
      {
        kind: "cloud",
        baseUrl: "https://ollama.com",
        path: "/api/web_search",
        url: "https://ollama.com/api/web_search",
      },
    ]);
  });
});
