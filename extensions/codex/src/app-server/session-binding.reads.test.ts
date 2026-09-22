import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyCodexAppServerBindingStore } from "./session-binding-store.js";
import { bindingStoreKey, createCodexAppServerBindingStore } from "./session-binding.js";
import { createCodexTestBindingStateStore } from "./session-binding.test-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  resetPluginStateStoreForTests();
});

describe("Codex app-server binding reads", () => {
  it.each([
    { name: "eager", create: createCodexAppServerBindingStore },
    { name: "lazy", create: createLazyCodexAppServerBindingStore },
  ])(
    "keeps ordered failures and never retries failed bulk acquisition in the $name facade",
    ({ create }) => {
      const state = createCodexTestBindingStateStore();
      const readValue = state.lookup.bind(state);
      const lookup = vi.spyOn(state, "lookup");
      const lookupMany = vi.fn((keys: readonly string[]) =>
        keys.map((key) => ({ ok: true as const, value: readValue(key) })),
      );
      const store = create({ ...state, lookupMany });
      const first = { kind: "conversation" as const, bindingId: "first" };
      const invalid = { kind: "conversation" as const, bindingId: " " };
      state.register(bindingStoreKey(first), {
        version: 1,
        state: "active",
        binding: { threadId: "", cwd: "/repo" },
      });
      expect(() => [...store.readMany!([first, invalid])]).toThrow(
        "Invalid Codex app-server binding row: conversation:first",
      );
      expect(lookupMany).not.toHaveBeenCalled();
      state.delete(bindingStoreKey(first));
      expect(() => [...store.readMany!([first, invalid])]).toThrow(
        "Codex app-server conversation binding requires a binding id",
      );
      lookup.mockClear();
      const failure = new Error("bulk database unavailable");
      lookupMany.mockImplementation(() => {
        throw failure;
      });
      expect(() => [...store.readMany!([first, { ...first, bindingId: "second" }])]).toThrow(
        failure,
      );
      expect(lookupMany).toHaveBeenCalledOnce();
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("keeps all rows readable when the host lacks bulk reads or the cohort exceeds its limit", () => {
    const state = createCodexTestBindingStateStore();
    const first = { kind: "conversation" as const, bindingId: "first" };
    const last = { kind: "conversation" as const, bindingId: "last" };
    const binding = { threadId: "owned", cwd: "/repo" };
    state.register(bindingStoreKey(last), { version: 1, state: "active", binding });
    const legacy = createLazyCodexAppServerBindingStore(state);
    expect(legacy.readMany).toBeUndefined();
    expect([legacy.read(first), legacy.read(last)]).toEqual([undefined, binding]);
    const lookupMany = vi.fn(() => {
      throw new Error("host bulk limit exceeded");
    });
    const store = createLazyCodexAppServerBindingStore({ ...state, lookupMany });
    const identities = [...Array.from({ length: 10_000 }, () => first), last];
    const result = [...store.readMany!(identities)];
    expect(result).toHaveLength(identities.length);
    expect(result.slice(0, -1).every((value) => value === undefined)).toBe(true);
    expect(result.at(-1)).toEqual(binding);
    expect(lookupMany).not.toHaveBeenCalled();
  });
});
