import { describe, expect, it } from "vitest";

import { resolveMemorySearchConfig } from "./memory-search.js";

describe("memory search config", () => {
  it("returns null when disabled", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: { enabled: true },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: { enabled: false },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("merges defaults and overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            chunking: { tokens: 500, overlap: 100 },
            query: { maxResults: 4, minScore: 0.2 },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              chunking: { tokens: 320 },
              query: { maxResults: 8 },
            },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
    expect(resolved?.chunking.tokens).toBe(320);
    expect(resolved?.chunking.overlap).toBe(100);
    expect(resolved?.query.maxResults).toBe(8);
    expect(resolved?.query.minScore).toBe(0.2);
  });

  it("merges remote defaults with agent overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              baseUrl: "https://default.example/v1",
              apiKey: "default-key",
              headers: { "X-Default": "on" },
            },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              remote: {
                baseUrl: "https://agent.example/v1",
              },
            },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toEqual({
      baseUrl: "https://agent.example/v1",
      apiKey: "default-key",
      headers: { "X-Default": "on" },
    });
  });
});
