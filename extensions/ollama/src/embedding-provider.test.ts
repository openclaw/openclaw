import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(async ({ init, url }: { init?: RequestInit; url: string }) => ({
    response: await fetch(url, init),
    release: async () => {},
  })),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

let createOllamaEmbeddingProvider: typeof import("./embedding-provider.js").createOllamaEmbeddingProvider;

beforeAll(async () => {
  ({ createOllamaEmbeddingProvider } = await import("./embedding-provider.js"));
});

beforeEach(() => {
  fetchWithSsrFGuardMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function mockEmbeddingFetch(embedding: number[]) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ embedding }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ollama embedding provider", () => {
  it("calls /api/embeddings and returns normalized vectors", async () => {
    const fetchMock = mockEmbeddingFetch([3, 4]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    const vector = await provider.embedQuery("hi");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });

  it("resolves configured base URL, API key, and headers", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "provider-host-bearer", // pragma: allowlist secret
              headers: {
                "X-Provider-Header": "provider",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer provider-host-bearer",
          "X-Provider-Header": "provider",
        }),
      }),
    );
  });

  it("fails fast when memory-search remote apiKey is an unresolved SecretRef", async () => {
    await expect(
      createOllamaEmbeddingProvider({
        config: {} as OpenClawConfig,
        provider: "ollama",
        model: "nomic-embed-text",
        fallback: "none",
        remote: {
          baseUrl: "http://127.0.0.1:11434",
          apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
        },
      }),
    ).rejects.toThrow(/agents\.\*\.memorySearch\.remote\.apiKey: unresolved SecretRef/i);
  });

  it("resolves an unresolved env SecretRef in provider config as a provider-scoped key", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });

  it("attaches env OLLAMA_API_KEY when the resolved base URL is Ollama Cloud", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com",
              apiKey: { source: "env", provider: "default", id: "OLLAMA_API_KEY" },
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });

  it("attaches env OLLAMA_API_KEY when remote.baseUrl resolves to Ollama Cloud", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://ollama.com" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });

  it("matches Ollama Cloud case-insensitively when attaching env OLLAMA_API_KEY", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://OLLAMA.COM",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer ollama-env");
  });

  it("attaches remote.apiKey to the provider's base URL when remote.baseUrl is not overridden", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { apiKey: "memory-search-bearer" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer memory-search-bearer",
        }),
      }),
    );
  });

  it("attaches provider-config apiKey when no baseUrl is configured and the default is used", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              apiKey: "provider-host-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer provider-host-bearer",
        }),
      }),
    );
  });

  it("attaches a remote.apiKey to the matching remote baseUrl", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: {
        baseUrl: "https://memory.example.com",
        apiKey: "remote-host-bearer",
      },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://memory.example.com/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer remote-host-bearer",
        }),
      }),
    );
  });

  it("filters env OLLAMA_API_KEY when the env value is a known placeholder marker", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-local");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("does not reuse a provider-scoped key across reverse-proxy path prefixes on the same host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://proxy.example.com/team-a",
              apiKey: "team-a-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://proxy.example.com/team-b" },
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("falls back to env OLLAMA_API_KEY on a cloud remote.baseUrl when the provider-config key is scoped to a different host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-cloud-key");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "local-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://ollama.com" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ollama.com/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-cloud-key",
        }),
      }),
    );
  });

  it("honors a remote.apiKey placeholder as an explicit no-auth opt-out", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { apiKey: "ollama-local" }, // pragma: allowlist secret
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("does not resolve the ollama-local placeholder through env, so env cloud keys cannot leak to a local host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "real-cloud-key");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "ollama-local", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("treats [::1] as the same provider host as 127.0.0.1 when remote.baseUrl restates it", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://[::1]:11434",
              apiKey: "provider-host-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer provider-host-bearer",
        }),
      }),
    );
  });

  it("treats localhost and 127.0.0.1 as the same provider host when remote.baseUrl restates it", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://localhost:11434" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer provider-host-bearer",
        }),
      }),
    );
  });

  it("keeps provider-config apiKey attached when remote.baseUrl redundantly names the provider's own host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434/v1" },
    });

    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer provider-host-bearer",
        }),
      }),
    );
  });

  it("recognizes Ollama Cloud base URLs given with an explicit default port", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "https://ollama.com:443",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer ollama-env");
  });

  it("does not attach provider-config apiKey to a remote baseUrl from a different config block", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "provider-host-bearer",
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "https://memory.example.com" },
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("treats a provider-config env marker as a declaration scoped to the provider host", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "OLLAMA_API_KEY", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    // Marker in provider config means the user declared env as the provider's
    // auth. The resolved env value attaches on the provider's host.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/embeddings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-env",
        }),
      }),
    );
  });

  it("ignores provider-config markers when env resolves to another placeholder marker", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-local");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://127.0.0.1:11434",
              apiKey: "OLLAMA_API_KEY", // pragma: allowlist secret
              models: [],
            },
          },
        },
      } as unknown as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  it("does not attach pure-env OLLAMA_API_KEY to a local host when no config declaration links them", async () => {
    const fetchMock = mockEmbeddingFetch([1, 0]);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-env");

    const { provider } = await createOllamaEmbeddingProvider({
      config: {} as OpenClawConfig,
      provider: "ollama",
      model: "nomic-embed-text",
      fallback: "none",
      remote: { baseUrl: "http://127.0.0.1:11434" },
    });

    await provider.embedQuery("hello");

    const [, init] = (fetchMock.mock.calls[0] ?? []) as unknown as [
      string,
      RequestInit | undefined,
    ];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });
});
