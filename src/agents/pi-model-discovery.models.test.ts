import { afterEach, describe, expect, it, vi } from "vitest";

const STALE_CODEX_MODEL = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  provider: "openai-codex",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text", "image"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
};

const OPENAI_MODEL = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text", "image"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@mariozechner/pi-coding-agent");
});

describe("discoverModels", () => {
  it("normalizes openai-codex models returned by registry discovery", async () => {
    vi.doMock("@mariozechner/pi-coding-agent", () => {
      class MockAuthStorage {}
      class MockModelRegistry {
        find(provider: string, modelId: string) {
          if (provider === "openai-codex" && modelId === "gpt-5.4") {
            return { ...STALE_CODEX_MODEL };
          }
          if (provider === "openai" && modelId === "gpt-5.4") {
            return { ...OPENAI_MODEL };
          }
          return null;
        }

        getAll() {
          return [{ ...STALE_CODEX_MODEL }, { ...OPENAI_MODEL }];
        }

        getAvailable() {
          return [{ ...STALE_CODEX_MODEL }];
        }
      }

      return {
        AuthStorage: MockAuthStorage,
        ModelRegistry: MockModelRegistry,
      };
    });

    const { discoverModels } = await import("./pi-model-discovery.js");
    const registry = discoverModels({} as never, "/tmp/openclaw-agent");

    expect(registry.find("openai-codex", "gpt-5.4")).toMatchObject({
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
    expect(registry.find("openai", "gpt-5.4")).toMatchObject({
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(registry.getAll()).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    );
    expect(registry.getAvailable()).toContainEqual(
      expect.objectContaining({
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    );
  });

  it("does not rewrite custom openai-codex proxy endpoints", async () => {
    vi.doMock("@mariozechner/pi-coding-agent", () => {
      class MockAuthStorage {}
      class MockModelRegistry {
        find() {
          return {
            ...STALE_CODEX_MODEL,
            baseUrl: "https://proxy.example.com/v1",
          };
        }
      }

      return {
        AuthStorage: MockAuthStorage,
        ModelRegistry: MockModelRegistry,
      };
    });

    const { discoverModels } = await import("./pi-model-discovery.js");
    const registry = discoverModels({} as never, "/tmp/openclaw-agent");

    expect(registry.find("openai-codex", "gpt-5.4")).toMatchObject({
      provider: "openai-codex",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
  });
});
