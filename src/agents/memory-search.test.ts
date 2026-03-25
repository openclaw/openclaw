import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemorySearchConfig } from "./memory-search.js";

const asConfig = (cfg: OpenClawConfig): OpenClawConfig => cfg;

describe("memory search config", () => {
  function configWithDefaultProvider(
    provider: "openai" | "local" | "gemini" | "mistral" | "ollama",
  ): OpenClawConfig {
    return asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider,
          },
        },
      },
    });
  }

  function expectDefaultRemoteBatch(resolved: ReturnType<typeof resolveMemorySearchConfig>): void {
    expect(resolved?.remote?.batch).toEqual({
      enabled: false,
      wait: true,
      concurrency: 2,
      pollIntervalMs: 2000,
      timeoutMinutes: 60,
    });
  }

  function expectEmptyMultimodalConfig(resolved: ReturnType<typeof resolveMemorySearchConfig>) {
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      modalities: [],
      maxFileBytes: 10 * 1024 * 1024,
    });
  }

  function configWithRemoteDefaults(remote: Record<string, unknown>) {
    return asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            remote,
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
    });
  }

  function expectMergedRemoteConfig(
    resolved: ReturnType<typeof resolveMemorySearchConfig>,
    apiKey: unknown,
  ) {
    expect(resolved?.remote).toEqual({
      baseUrl: "https://agent.example/v1",
      apiKey,
      headers: { "X-Default": "on" },
      batch: {
        enabled: false,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    });
  }

  it("returns null when disabled", () => {
    const cfg = asConfig({
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
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("defaults provider to auto when unspecified", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            enabled: true,
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("auto");
    expect(resolved?.fallback).toBe("none");
  });

  it("merges defaults and overrides", () => {
    const cfg = asConfig({
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
    });
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
    const cfg = asConfig({
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
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.extraPaths).toEqual(["/shared/notes", "docs", "../team-notes"]);
  });

  it("normalizes multimodal settings", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            multimodal: {
              enabled: true,
              modalities: ["all"],
              maxFileBytes: 8192,
            },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      modalities: ["image", "audio"],
      maxFileBytes: 8192,
    });
  });

  it("keeps an explicit empty multimodal modalities list empty", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            multimodal: {
              enabled: true,
              modalities: [],
            },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
    expect(resolved?.provider).toBe("gemini");
  });

  it("does not enforce multimodal provider validation when no modalities are active", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            fallback: "openai",
            multimodal: {
              enabled: true,
              modalities: [],
            },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectEmptyMultimodalConfig(resolved);
  });

  it("rejects multimodal memory on unsupported providers", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            multimodal: { enabled: true, modalities: ["image"] },
          },
        },
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memorySearch\.multimodal requires memorySearch\.provider = "gemini"/,
    );
  });

  it("rejects multimodal memory when fallback is configured", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            fallback: "openai",
            multimodal: { enabled: true, modalities: ["image"] },
          },
        },
      },
    });
    expect(() => resolveMemorySearchConfig(cfg, "main")).toThrow(
      /memorySearch\.multimodal does not support memorySearch\.fallback/,
    );
  });

  it("includes batch defaults for openai without remote overrides", () => {
    const cfg = configWithDefaultProvider("openai");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("keeps remote unset for local provider without overrides", () => {
    const cfg = configWithDefaultProvider("local");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toBeUndefined();
  });

  it("includes remote defaults for gemini without overrides", () => {
    const cfg = configWithDefaultProvider("gemini");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
  });

  it("includes remote defaults and model default for mistral without overrides", () => {
    const cfg = configWithDefaultProvider("mistral");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("mistral-embed");
  });

  it("includes remote defaults and model default for ollama without overrides", () => {
    const cfg = configWithDefaultProvider("ollama");
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectDefaultRemoteBatch(resolved);
    expect(resolved?.model).toBe("nomic-embed-text");
  });

  it("defaults session delta thresholds", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sync.sessions).toEqual({
      deltaBytes: 100000,
      deltaMessages: 50,
      postCompactionForce: true,
    });
  });

  it("merges remote defaults with agent overrides", () => {
    const cfg = configWithRemoteDefaults({
      baseUrl: "https://default.example/v1",
      apiKey: "default-key", // pragma: allowlist secret
      headers: { "X-Default": "on" },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expectMergedRemoteConfig(resolved, "default-key"); // pragma: allowlist secret
  });

  it("preserves SecretRef remote apiKey when merging defaults with agent overrides", () => {
    const cfg = configWithRemoteDefaults({
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
      headers: { "X-Default": "on" },
    });

    const resolved = resolveMemorySearchConfig(cfg, "main");

    expectMergedRemoteConfig(resolved, {
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("gates session sources behind experimental flag", () => {
    const cfg = asConfig({
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
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("allows session sources when experimental flag is enabled", () => {
    const cfg = asConfig({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            sources: ["memory", "sessions"],
            experimental: { sessionMemory: true },
          },
        },
      },
    });
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toContain("sessions");
  });
});
