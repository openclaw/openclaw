import { describe, expect, it } from "vitest";
import { applyConfiguredContextWindows } from "./context.js";
import { createSessionManagerRuntimeRegistry } from "./pi-extensions/session-manager-runtime-registry.js";

describe("applyConfiguredContextWindows", () => {
  it("overrides discovered cache values with explicit models.providers contextWindow", () => {
    const cache = new Map<string, number>([["anthropic/claude-opus-4-6", 1_000_000]]);
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [{ id: "anthropic/claude-opus-4-6", contextWindow: 200_000 }],
          },
        },
      },
    });

    expect(cache.get("anthropic/claude-opus-4-6")).toBe(200_000);
  });

  it("adds config-only model context windows and ignores invalid entries", () => {
    const cache = new Map<string, number>();
    applyConfiguredContextWindows({
      cache,
      modelsConfig: {
        providers: {
          openrouter: {
            models: [
              { id: "custom/model", contextWindow: 150_000 },
              { id: "bad/model", contextWindow: 0 },
              { id: "", contextWindow: 300_000 },
            ],
          },
        },
      },
    });

    expect(cache.get("custom/model")).toBe(150_000);
    expect(cache.has("bad/model")).toBe(false);
  });
});

describe("createSessionManagerRuntimeRegistry", () => {
  it("stores, reads, and clears values by object identity", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    const key = {};
    expect(registry.get(key)).toBeNull();
    registry.set(key, { value: 1 });
    expect(registry.get(key)).toEqual({ value: 1 });
    registry.set(key, null);
    expect(registry.get(key)).toBeNull();
  });

  it("ignores non-object keys", () => {
    const registry = createSessionManagerRuntimeRegistry<{ value: number }>();
    registry.set(null, { value: 1 });
    registry.set(123, { value: 1 });
    expect(registry.get(null)).toBeNull();
    expect(registry.get(123)).toBeNull();
  });
});
