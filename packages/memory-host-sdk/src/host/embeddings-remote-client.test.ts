import { describe, expect, it, vi } from "vitest";
import { resolveRemoteEmbeddingBearerClient } from "./embeddings-remote-client.js";

vi.mock("./openclaw-runtime-auth.js", () => ({
  requireApiKey: (auth: { apiKey?: string }, provider: string) => {
    if (!auth.apiKey) throw new Error(`No API key found for provider "${provider}"`);
    return auth.apiKey;
  },
  resolveApiKeyForProvider: vi.fn(),
}));

import { resolveApiKeyForProvider } from "./openclaw-runtime-auth.js";

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
            originator: "pi",
            "User-Agent": "pi",
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

  describe("openai-codex OAuth fallback", () => {
    const mockedResolve = vi.mocked(resolveApiKeyForProvider);

    it("falls back to openai-codex when openai provider has no key on native route", async () => {
      mockedResolve
        .mockRejectedValueOnce(new Error('No API key found for provider "openai"'))
        .mockResolvedValueOnce({ apiKey: "oauth-token-123", source: "oauth", mode: "oauth" });

      const client = await resolveRemoteEmbeddingBearerClient({
        provider: "openai",
        defaultBaseUrl: "https://api.openai.com/v1",
        options: {
          config: { models: {} } as never,
          model: "text-embedding-3-small",
          remote: {},
        },
      });

      expect(client.headers.Authorization).toBe("Bearer oauth-token-123");
      expect(mockedResolve).toHaveBeenCalledTimes(2);
      expect(mockedResolve).toHaveBeenLastCalledWith(
        expect.objectContaining({ provider: "openai-codex" }),
      );
    });

    it("does NOT fall back to openai-codex for custom baseUrl endpoints", async () => {
      mockedResolve.mockRejectedValue(new Error('No API key found for provider "openai"'));

      await expect(
        resolveRemoteEmbeddingBearerClient({
          provider: "openai",
          defaultBaseUrl: "https://api.openai.com/v1",
          options: {
            config: {
              models: {
                providers: {
                  openai: { baseUrl: "https://custom-proxy.example.com/v1" },
                },
              },
            } as never,
            model: "text-embedding-3-small",
            remote: {},
          },
        }),
      ).rejects.toThrow('No API key found for provider "openai"');

      // Should only try "openai", never "openai-codex"
      expect(mockedResolve).toHaveBeenCalledTimes(1);
      expect(mockedResolve).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai" }));
    });

    it("does NOT fall back for non-openai providers", async () => {
      mockedResolve.mockRejectedValue(new Error('No API key found for provider "anthropic"'));

      await expect(
        resolveRemoteEmbeddingBearerClient({
          provider: "anthropic",
          defaultBaseUrl: "https://api.anthropic.com/v1",
          options: {
            config: { models: {} } as never,
            model: "voyage-3",
            remote: {},
          },
        }),
      ).rejects.toThrow('No API key found for provider "anthropic"');

      expect(mockedResolve).toHaveBeenCalledTimes(1);
    });
  });
});
