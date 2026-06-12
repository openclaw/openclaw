// Tests for resolveFreshModel() — ensures post-turn reads use the latest
// registry model instead of the stale agent.state.model snapshot.
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../../llm/types.js";

/**
 * Pure implementation of resolveFreshModel for unit testing.
 * Mirrors the private method on AgentSession.
 */
function resolveFreshModel(
  currentModel: Model | undefined,
  find: (provider: string, id: string) => Model | undefined,
): Model | undefined {
  if (!currentModel) {
    return undefined;
  }
  return find(currentModel.provider, currentModel.id) ?? currentModel;
}

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    provider: "test-provider",
    contextWindow: 128_000,
    ...overrides,
  } as Model;
}

describe("resolveFreshModel", () => {
  it("returns undefined when current model is undefined", () => {
    const find = vi.fn();
    const result = resolveFreshModel(undefined, find);
    expect(result).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it("returns the registry model when found", () => {
    const snapshot = makeModel({ contextWindow: 128_000 });
    const fresh = makeModel({ contextWindow: 1_000_000 });
    const find = vi.fn().mockReturnValue(fresh);

    const result = resolveFreshModel(snapshot, find);
    expect(result).toBe(fresh);
    expect(find).toHaveBeenCalledWith("test-provider", "test-model");
  });

  it("falls back to the snapshot when registry has no entry", () => {
    const snapshot = makeModel({ contextWindow: 128_000 });
    const find = vi.fn().mockReturnValue(undefined);

    const result = resolveFreshModel(snapshot, find);
    expect(result).toBe(snapshot);
  });

  it("returns the same object when registry returns the identical reference", () => {
    const snapshot = makeModel({ contextWindow: 128_000 });
    const find = vi.fn().mockReturnValue(snapshot);

    const result = resolveFreshModel(snapshot, find);
    expect(result).toBe(snapshot);
  });

  it("reflects updated contextWindow from the registry", () => {
    const snapshot = makeModel({ contextWindow: 200_000 });
    const fresh = makeModel({ contextWindow: 1_000_000 });
    const find = vi.fn().mockReturnValue(fresh);

    const result = resolveFreshModel(snapshot, find);
    expect(result?.contextWindow).toBe(1_000_000);
  });

  it("reflects updated reasoning flag from the registry", () => {
    const snapshot = makeModel({ reasoning: false });
    const fresh = makeModel({ reasoning: true });
    const find = vi.fn().mockReturnValue(fresh);

    const result = resolveFreshModel(snapshot, find);
    expect(result?.reasoning).toBe(true);
  });

  it("reflects updated thinkingLevelMap from the registry", () => {
    const snapshot = makeModel({ thinkingLevelMap: undefined });
    const fresh = makeModel({
      thinkingLevelMap: { low: "1000", medium: "2000", high: "3000" },
    });
    const find = vi.fn().mockReturnValue(fresh);

    const result = resolveFreshModel(snapshot, find);
    expect(result?.thinkingLevelMap).toEqual({
      low: "1000",
      medium: "2000",
      high: "3000",
    });
  });

  it("returns registry model even when provider/id differ from snapshot", () => {
    const snapshot = makeModel({ provider: "openai", id: "gpt-4o" });
    const fresh = makeModel({ provider: "openai", id: "gpt-4o-mini" });
    const find = vi.fn().mockReturnValue(fresh);

    const result = resolveFreshModel(snapshot, find);
    expect(result).toBe(fresh);
    expect(result?.id).toBe("gpt-4o-mini");
  });

  it("uses fresh contextWindow for compaction threshold check", () => {
    const snapshot = makeModel({ contextWindow: 200_000 });
    const fresh = makeModel({ contextWindow: 1_000_000 });
    const find = vi.fn().mockReturnValue(fresh);

    const resolved = resolveFreshModel(snapshot, find);
    const contextWindow = resolved?.contextWindow ?? 0;

    const usageRatio = 180_000 / contextWindow;
    expect(contextWindow).toBe(1_000_000);
    expect(usageRatio).toBeLessThan(0.8);
  });
});
