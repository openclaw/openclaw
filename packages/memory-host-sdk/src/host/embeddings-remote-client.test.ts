// Memory Host SDK tests cover embeddings remote client behavior.
import { describe, expect, it, vi } from "vitest";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";

describe("resolveRemoteEmbeddingBearerClient", () => {
  it("uses configured OpenAI provider baseUrl for memory embeddings", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        agentDir: "/tmp/openclaw-agent",
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://proxy.example.test/openai/v1",
              },
            },
          },
        } as never,
        model: "text-embedding-3-small",
        remote: {
          apiKey: "sk-test",
        },
      },
    });

    expect(client.baseUrl).toBe("https://proxy.example.test/openai/v1");
  });

  it("adds OpenClaw attribution to native OpenAI embedding requests", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      options: {
        config: { models: {} } as never,
        model: "text-embedding-3-large",
        remote: {
          apiKey: "sk-test",
          headers: {
            originator: "openclaw",
            "User-Agent": "openclaw",
          },
        },
      },
    });

    expect(client.headers).toEqual({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("resolves dispatcherPolicy from provider request.proxy config", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "cohere",
      defaultBaseUrl: "https://api.cohere.ai/v1",
      options: {
        agentDir: "/tmp/openclaw-agent",
        config: {
          models: {
            providers: {
              cohere: {
                baseUrl: "https://api.cohere.ai/v1",
                request: {
                  proxy: {
                    mode: "explicit-proxy",
                    url: "https://proxy.example.test:8443",
                  },
                },
              },
            },
          },
        } as never,
        model: "embed-multilingual-v3.0",
        remote: {
          apiKey: "sk-cohere-test",
        },
      },
    });

    expect(client.dispatcherPolicy).toBeDefined();
    expect(client.dispatcherPolicy?.mode).toBe("explicit-proxy");
    if (client.dispatcherPolicy?.mode === "explicit-proxy") {
      expect(client.dispatcherPolicy.proxyUrl).toBe("https://proxy.example.test:8443");
    }
  });

  it("resolves dispatcherPolicy as env-proxy from provider request config", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "cohere",
      defaultBaseUrl: "https://api.cohere.ai/v1",
      options: {
        agentDir: "/tmp/openclaw-agent",
        config: {
          models: {
            providers: {
              cohere: {
                baseUrl: "https://api.cohere.ai/v1",
                request: {
                  proxy: {
                    mode: "env-proxy",
                  },
                },
              },
            },
          },
        } as never,
        model: "embed-multilingual-v3.0",
        remote: {
          apiKey: "sk-cohere-test",
        },
      },
    });

    expect(client.dispatcherPolicy).toBeDefined();
    expect(client.dispatcherPolicy?.mode).toBe("env-proxy");
  });

  it("returns undefined dispatcherPolicy when no request config", async () => {
    const client = await resolveRemoteEmbeddingBearerClient({
      provider: "cohere",
      defaultBaseUrl: "https://api.cohere.ai/v1",
      options: {
        agentDir: "/tmp/openclaw-agent",
        config: {
          models: {
            providers: {},
          },
        } as never,
        model: "embed-multilingual-v3.0",
        remote: {
          apiKey: "sk-cohere-test",
        },
      },
    });

    expect(client.dispatcherPolicy).toBeUndefined();
  });
});
