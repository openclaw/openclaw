import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import { bindingStoreKey } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

describe("Codex app-server binding reads", () => {
  it("keeps ordered failures without synchronous reads or retrying failed bulk acquisition", async () => {
    const state = createCodexTestBindingStateStore();
    const readValue = state.lookup.bind(state);
    const syncLookup = vi.spyOn(state, "lookup");
    const lookup = vi.spyOn(state.asyncReads, "lookup");
    const lookupMany = vi.fn(async (keys: readonly string[]) =>
      keys.map((key) => ({ ok: true as const, value: readValue(key) })),
    );
    const store = createLazyCodexAppServerBindingStore({
      ...state,
      asyncReads: { lookup, lookupMany },
    });
    const first = { kind: "conversation" as const, bindingId: "first" };
    const invalid = { kind: "conversation" as const, bindingId: " " };
    state.register(bindingStoreKey(first), {
      version: 1,
      state: "active",
      binding: { threadId: "", cwd: "/repo" },
    });
    await expect(collect(store.readMany([first, invalid]))).rejects.toThrow(
      "Invalid Codex app-server binding row: conversation:first",
    );
    expect(lookupMany).not.toHaveBeenCalled();
    state.delete(bindingStoreKey(first));
    await expect(collect(store.readMany([first, invalid]))).rejects.toThrow(
      "Codex app-server conversation binding requires a binding id",
    );
    lookup.mockClear();
    const failure = new Error("bulk database unavailable");
    lookupMany.mockImplementation(async () => {
      throw failure;
    });
    await expect(
      collect(store.readMany([first, { ...first, bindingId: "second" }])),
    ).rejects.toThrow(failure);
    expect(lookupMany).toHaveBeenCalledOnce();
    expect(lookup).not.toHaveBeenCalled();
    expect(syncLookup).not.toHaveBeenCalled();
  });

  it("keeps async fallback and oversized cohorts readable without synchronous acquisition", async () => {
    const state = createCodexTestBindingStateStore();
    const readValue = state.lookup.bind(state);
    const syncLookup = vi.spyOn(state, "lookup");
    const first = { kind: "conversation" as const, bindingId: "first" };
    const last = { kind: "conversation" as const, bindingId: "last" };
    const binding = { threadId: "owned", cwd: "/repo" };
    state.register(bindingStoreKey(last), { version: 1, state: "active", binding });
    const legacy = createLazyCodexAppServerBindingStore(state);
    expect(await collect(legacy.readMany([first, last]))).toEqual([undefined, binding]);
    const lookupMany = vi.fn(async (keys: readonly string[]) => {
      if (keys.length > 10_000) {
        throw new Error("host bulk limit exceeded");
      }
      return keys.map((key) => ({ ok: true as const, value: readValue(key) }));
    });
    const store = createLazyCodexAppServerBindingStore({
      ...state,
      asyncReads: { ...state.asyncReads, lookupMany },
    });
    const identities = [...Array.from({ length: 10_000 }, () => first), last];
    const result = await collect(store.readMany(identities));
    expect(result).toHaveLength(identities.length);
    expect(result.slice(0, -1).every((value) => value === undefined)).toBe(true);
    expect(result.at(-1)).toEqual(binding);
    expect(lookupMany.mock.calls.map(([keys]) => keys.length)).toEqual([10_000, 1]);
    expect(syncLookup).not.toHaveBeenCalled();
  });
});
