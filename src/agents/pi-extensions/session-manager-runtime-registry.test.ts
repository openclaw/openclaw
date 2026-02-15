import { describe, expect, it } from "vitest";
import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

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
