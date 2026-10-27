// Memory Core tests cover the memory embedding provider sentinel handling.
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { describe, expect, it, vi } from "vitest";
import {
  resolveEffectiveMemorySearchSettings,
  resolveMemoryEmbeddingProviderRequirement,
} from "./manager-provider-lifecycle.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-embeddings")
  >()),
  getMemoryEmbeddingProvider: () => undefined,
}));

function createSettings(provider: string): ResolvedMemorySearchConfig {
  return {
    provider,
    store: {
      driver: "sqlite",
      databasePath: "/tmp/openclaw-test-workspace/memory-index.sqlite",
      fts: { tokenizer: "unicode61" },
      vector: { enabled: true },
    },
  } as unknown as ResolvedMemorySearchConfig;
}

function createConfig(provider: string): OpenClawConfig {
  return {
    memory: { search: { provider } },
  } as unknown as OpenClawConfig;
}

describe("memory embedding provider sentinel", () => {
  it("resolves a mixed-case none sentinel to FTS-only mode", () => {
    const requirement = resolveMemoryEmbeddingProviderRequirement({
      cfg: createConfig("None"),
      agentId: "main",
      settings: createSettings("None"),
    });
    expect(requirement.mode).toBe("fts-only");
  });

  it("disables the vector store for a mixed-case none sentinel", () => {
    const effective = resolveEffectiveMemorySearchSettings(createSettings("None"));
    expect(effective.store.vector.enabled).toBe(false);
  });

  it("keeps a real provider out of FTS-only mode", () => {
    const requirement = resolveMemoryEmbeddingProviderRequirement({
      cfg: createConfig("openai"),
      agentId: "main",
      settings: createSettings("openai"),
    });
    expect(requirement.mode).toBe("required");
  });
});
