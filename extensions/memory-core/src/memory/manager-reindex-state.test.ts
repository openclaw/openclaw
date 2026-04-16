import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import {
  chunkingConfigDiffers,
  resolveConfiguredScopeHash,
  resolveConfiguredSourcesForMeta,
  shouldRunFullMemoryReindex,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";

function createMeta(overrides: Partial<MemoryIndexMeta> = {}): MemoryIndexMeta {
  return {
    model: "mock-embed-v1",
    provider: "openai",
    providerKey: "provider-key-v1",
    sources: ["memory"],
    scopeHash: "scope-v1",
    chunkTokens: 4000,
    chunkOverlap: 0,
    chunkingConfig: { strategy: "fixed-size", tokens: 4000, overlap: 0 },
    ftsTokenizer: "unicode61",
    ...overrides,
  };
}

function createFullReindexParams(
  overrides: {
    meta?: MemoryIndexMeta | null;
    provider?: { id: string; model: string } | null;
    providerKey?: string;
    configuredSources?: MemorySource[];
    configuredScopeHash?: string;
    chunking?: { strategy: string; [key: string]: unknown };
    vectorReady?: boolean;
    ftsTokenizer?: string;
  } = {},
) {
  return {
    meta: createMeta(),
    provider: { id: "openai", model: "mock-embed-v1" },
    providerKey: "provider-key-v1",
    configuredSources: ["memory"] as MemorySource[],
    configuredScopeHash: "scope-v1",
    chunking: { strategy: "fixed-size", tokens: 4000, overlap: 0 } as { strategy: string; [key: string]: unknown },
    vectorReady: false,
    ftsTokenizer: "unicode61",
    ...overrides,
  };
}

describe("memory reindex state", () => {
  it("requires a full reindex when the embedding model changes", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          provider: { id: "openai", model: "mock-embed-v2" },
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when the provider cache key changes", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          provider: { id: "gemini", model: "gemini-embedding-2-preview" },
          providerKey: "provider-key-dims-768",
          meta: createMeta({
            provider: "gemini",
            model: "gemini-embedding-2-preview",
            providerKey: "provider-key-dims-3072",
          }),
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when extraPaths change", () => {
    const workspaceDir = "/tmp/workspace";
    const firstScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/a"],
      multimodal: {
        enabled: false,
        modalities: [],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });
    const secondScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/b"],
      multimodal: {
        enabled: false,
        modalities: [],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });

    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when configured sources add sessions", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          configuredSources: ["memory", "sessions"],
        }),
      ),
    ).toBe(true);
  });

  it("requires a full reindex when multimodal settings change", () => {
    const workspaceDir = "/tmp/workspace";
    const firstScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/media"],
      multimodal: {
        enabled: false,
        modalities: [],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });
    const secondScopeHash = resolveConfiguredScopeHash({
      workspaceDir,
      extraPaths: ["/tmp/workspace/media"],
      multimodal: {
        enabled: true,
        modalities: ["image"],
        maxFileBytes: 20 * 1024 * 1024,
      },
    });

    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: createMeta({ scopeHash: firstScopeHash }),
          configuredScopeHash: secondScopeHash,
        }),
      ),
    ).toBe(true);
  });

  it("keeps older indexes with missing sources compatible with memory-only config", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: createMeta({ sources: undefined }),
          configuredSources: resolveConfiguredSourcesForMeta(new Set(["memory"])),
        }),
      ),
    ).toBe(false);
  });

  it("does not require reindex when chunking config is unchanged", () => {
    expect(shouldRunFullMemoryReindex(createFullReindexParams())).toBe(false);
  });

  it("requires reindex when strategy changes from fixed-size to sentence", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          chunking: { strategy: "sentence", targetTokens: 400, overlapSentences: 1 },
        }),
      ),
    ).toBe(true);
  });

  it("requires reindex when fixed-size tokens change", () => {
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          chunking: { strategy: "fixed-size", tokens: 800, overlap: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("requires reindex when sentence strategy parameter changes", () => {
    const meta = createMeta({
      chunkingConfig: { strategy: "sentence", targetTokens: 400, overlapSentences: 1 },
    });
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta,
          chunking: { strategy: "sentence", targetTokens: 800, overlapSentences: 1 },
        }),
      ),
    ).toBe(true);
  });

  it("does not require reindex when sentence config is identical", () => {
    const meta = createMeta({
      chunkingConfig: { strategy: "sentence", targetTokens: 400, overlapSentences: 1 },
    });
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta,
          chunking: { strategy: "sentence", targetTokens: 400, overlapSentences: 1 },
        }),
      ),
    ).toBe(false);
  });

  it("requires reindex when switching from old meta (no chunkingConfig.strategy) to non-fixed-size", () => {
    // Simulate legacy meta that only has chunkTokens/chunkOverlap
    const legacyMeta = createMeta({
      chunkingConfig: undefined,
    });
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: legacyMeta,
          chunking: { strategy: "markdown-heading", maxDepth: 3, maxTokens: 400 },
        }),
      ),
    ).toBe(true);
  });

  it("does not require reindex for legacy meta with matching fixed-size config", () => {
    const legacyMeta = createMeta({
      chunkingConfig: undefined,
      chunkTokens: 4000,
      chunkOverlap: 0,
    });
    expect(
      shouldRunFullMemoryReindex(
        createFullReindexParams({
          meta: legacyMeta,
          chunking: { strategy: "fixed-size", tokens: 4000, overlap: 0 },
        }),
      ),
    ).toBe(false);
  });
});

describe("chunkingConfigDiffers", () => {
  it("returns false when strategy and params match", () => {
    const meta = createMeta({
      chunkingConfig: { strategy: "lumber", theta: 550, completionModel: "gpt-4" },
    });
    expect(chunkingConfigDiffers(meta, { strategy: "lumber", theta: 550, completionModel: "gpt-4" })).toBe(false);
  });

  it("returns true when strategy name differs", () => {
    const meta = createMeta({
      chunkingConfig: { strategy: "fixed-size", tokens: 400, overlap: 80 },
    });
    expect(chunkingConfigDiffers(meta, { strategy: "sentence", targetTokens: 400, overlapSentences: 1 })).toBe(true);
  });

  it("returns true when hichunk parameter changes", () => {
    const meta = createMeta({
      chunkingConfig: { strategy: "hichunk", windowSize: 16384, lineMaxLen: 100, maxLevel: 10, recurrentType: 1, completionModel: "gpt-4" },
    });
    expect(chunkingConfigDiffers(meta, { strategy: "hichunk", windowSize: 8192, lineMaxLen: 100, maxLevel: 10, recurrentType: 1, completionModel: "gpt-4" })).toBe(true);
  });
});
