// Memory Core tests cover needsSelfHealReindex condition logic.
import { describe, expect, it } from "vitest";
import {
  resolveMemoryIndexIdentityState,
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
    ftsTokenizer: "unicode61",
    ...overrides,
  };
}

/**
 * Evaluate the needsSelfHealReindex guard:
 *
 *   indexIdentity.status === "missing" && hasIndexedChunks && !hasTargetSessionFiles
 *
 * Returns true only when identity is "missing" AND chunks already exist AND
 * there are no targeted session files (which would short-circuit to a
 * targeted sync instead of a full reindex).
 */
function needsSelfHealReindex(params: {
  indexIdentityStatus: string;
  hasIndexedChunks: boolean;
  hasTargetSessionFiles: boolean;
}): boolean {
  return (
    params.indexIdentityStatus === "missing" &&
    params.hasIndexedChunks &&
    !params.hasTargetSessionFiles
  );
}

describe("needsSelfHealReindex", () => {
  it("returns true when identity is missing and chunks exist", () => {
    expect(
      needsSelfHealReindex({
        indexIdentityStatus: "missing",
        hasIndexedChunks: true,
        hasTargetSessionFiles: false,
      }),
    ).toBe(true);
  });

  it("returns false when identity is mismatched", () => {
    expect(
      needsSelfHealReindex({
        indexIdentityStatus: "mismatched",
        hasIndexedChunks: true,
        hasTargetSessionFiles: false,
      }),
    ).toBe(false);
  });

  it("returns false when no indexed chunks exist", () => {
    expect(
      needsSelfHealReindex({
        indexIdentityStatus: "missing",
        hasIndexedChunks: false,
        hasTargetSessionFiles: false,
      }),
    ).toBe(false);
  });

  it("returns false when target session files are present", () => {
    expect(
      needsSelfHealReindex({
        indexIdentityStatus: "missing",
        hasIndexedChunks: true,
        hasTargetSessionFiles: true,
      }),
    ).toBe(false);
  });

  it("returns false when identity is valid", () => {
    expect(
      needsSelfHealReindex({
        indexIdentityStatus: "valid",
        hasIndexedChunks: true,
        hasTargetSessionFiles: false,
      }),
    ).toBe(false);
  });
});

describe("resolveMemoryIndexIdentityState — missing status", () => {
  it("returns missing when meta is null", () => {
    const state = resolveMemoryIndexIdentityState({
      meta: null,
      provider: { id: "openai", model: "mock-embed-v1" },
      providerKey: "provider-key-v1",
      configuredSources: ["memory"],
      configuredScopeHash: "scope-v1",
      chunkTokens: 4000,
      chunkOverlap: 0,
      vectorReady: false,
      hasIndexedChunks: true,
      ftsTokenizer: "unicode61",
    });
    expect(state).toEqual({
      status: "missing",
      reason: "index metadata is missing",
    });
  });

  it("returns mismatched when provider changes", () => {
    const state = resolveMemoryIndexIdentityState({
      meta: createMeta(),
      provider: { id: "ollama", model: "mock-embed-v1" },
      providerKey: "provider-key-ollama",
      configuredSources: ["memory"],
      configuredScopeHash: "scope-v1",
      chunkTokens: 4000,
      chunkOverlap: 0,
      vectorReady: false,
      hasIndexedChunks: true,
      ftsTokenizer: "unicode61",
    });
    expect(state.status).toBe("mismatched");
  });

  it("returns valid when all identity fields match", () => {
    const state = resolveMemoryIndexIdentityState({
      meta: createMeta(),
      provider: { id: "openai", model: "mock-embed-v1" },
      providerKey: "provider-key-v1",
      configuredSources: ["memory"],
      configuredScopeHash: "scope-v1",
      chunkTokens: 4000,
      chunkOverlap: 0,
      vectorReady: false,
      hasIndexedChunks: true,
      ftsTokenizer: "unicode61",
    });
    expect(state).toEqual({ status: "valid" });
  });
});
