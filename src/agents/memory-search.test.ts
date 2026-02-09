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

  it("defaults provider to auto when unspecified", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("auto");
    expect(resolved?.fallback).toBe("none");
  });

  it("merges defaults and overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: {
              vector: {
                enabled: false,
                extensionPath: "/opt/sqlite-vec.dylib",
              },
            },
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
              store: {
                vector: {
                  enabled: true,
                },
              },
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
    expect(resolved?.store.vector.enabled).toBe(true);
    expect(resolved?.store.vector.extensionPath).toBe("/opt/sqlite-vec.dylib");
  });

  it("merges extra memory paths from defaults and overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            extraPaths: ["/shared/notes", " docs "],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              extraPaths: ["/shared/notes", "../team-notes"],
            },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.extraPaths).toEqual(["/shared/notes", "docs", "../team-notes"]);
  });

  it("includes batch defaults for openai without remote overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote?.batch).toEqual({
      enabled: true,
      wait: true,
      concurrency: 2,
      pollIntervalMs: 2000,
      timeoutMinutes: 60,
    });
  });

  it("keeps remote unset for local provider without overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toBeUndefined();
  });

  it("includes remote defaults for gemini without overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote?.batch).toEqual({
      enabled: true,
      wait: true,
      concurrency: 2,
      pollIntervalMs: 2000,
      timeoutMinutes: 60,
    });
  });

  it("defaults session delta thresholds", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sync.sessions).toEqual({
      deltaBytes: 100000,
      deltaMessages: 50,
    });
  });

  it("merges remote defaults with agent overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
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
      batch: {
        enabled: true,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    });
  });

  it("gates session sources behind experimental flag", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              experimental: { sessionMemory: false },
            },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("allows session sources when experimental flag is enabled", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
            experimental: { sessionMemory: true },
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toContain("sessions");
  });

  it("preserves qdrant endpoint failover settings with auto driver", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            store: {
              driver: "auto",
              qdrant: {
                url: "http://127.0.0.1:6333",
                collection: "jarvis_memory_chunks",
                endpoints: [
                  {
                    url: "http://spark.lan:6333",
                    priority: 0,
                    healthUrl: "http://spark.lan:6333/collections",
                  },
                  {
                    url: "http://127.0.0.1:6333",
                    priority: 10,
                    healthUrl: "http://127.0.0.1:6333/collections",
                  },
                ],
              },
            },
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.store.driver).toBe("auto");
    expect(resolved?.store.qdrant.url).toBe("http://127.0.0.1:6333");
    expect(resolved?.store.qdrant.endpoints).toHaveLength(2);
    expect(resolved?.store.qdrant.endpoints?.[0]?.url).toBe("http://spark.lan:6333");
  });

  it("defaults to qdrant store and default collection", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
            provider: "local",
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.store.driver).toBe("qdrant");
    expect(resolved?.store.qdrant.collection).toBe("jarvis_memory_chunks");
    expect(resolved?.chunking.tokens).toBe(800);
    expect(resolved?.chunking.overlap).toBe(100);
  });
});
