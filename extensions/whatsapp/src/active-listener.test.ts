import { afterEach, describe, expect, it } from "vitest";
import type { ActiveWebListener } from "./active-listener.js";
import {
  getActiveWebListener,
  requireActiveWebListener,
  resolveWebAccountId,
  setActiveWebListener,
} from "./active-listener.js";

function createMockListener(overrides?: Partial<ActiveWebListener>): ActiveWebListener {
  return {
    sendMessage: async () => ({ messageId: "m1" }),
    sendPoll: async () => ({ messageId: "p1" }),
    sendReaction: async () => {},
    sendComposingTo: async () => {},
    ...overrides,
  };
}

describe("active-listener registry", () => {
  afterEach(() => {
    // Clean up all listeners after each test – clear the entire store
    // so newly added account IDs in future tests are covered automatically.
    globalThis.__openclaw_wa_web_listeners?.clear();
  });

  // ------------------------------------------------------------------
  // Basic set / get / require round-trips
  // ------------------------------------------------------------------

  it("set then require returns the same listener (default account)", () => {
    const listener = createMockListener();
    setActiveWebListener(listener);
    const result = requireActiveWebListener();
    expect(result.listener).toBe(listener);
    expect(result.accountId).toBe("default");
  });

  it("set then require returns the same listener (named account)", () => {
    const listener = createMockListener();
    setActiveWebListener("work", listener);
    const result = requireActiveWebListener("work");
    expect(result.listener).toBe(listener);
    expect(result.accountId).toBe("work");
  });

  it("require throws when no listener is registered", () => {
    expect(() => requireActiveWebListener()).toThrow("No active WhatsApp Web listener");
  });

  it("get returns null when no listener is registered", () => {
    expect(getActiveWebListener()).toBeNull();
  });

  it("set(null) removes the listener", () => {
    setActiveWebListener(createMockListener());
    expect(getActiveWebListener()).not.toBeNull();
    setActiveWebListener(null);
    expect(getActiveWebListener()).toBeNull();
  });

  it("set(accountId, null) removes a named listener", () => {
    setActiveWebListener("work", createMockListener());
    expect(getActiveWebListener("work")).not.toBeNull();
    setActiveWebListener("work", null);
    expect(getActiveWebListener("work")).toBeNull();
  });

  it("multiple accounts are independent", () => {
    const a = createMockListener();
    const b = createMockListener();
    setActiveWebListener(a);
    setActiveWebListener("work", b);
    expect(requireActiveWebListener().listener).toBe(a);
    expect(requireActiveWebListener("work").listener).toBe(b);
  });

  // ------------------------------------------------------------------
  // resolveWebAccountId edge cases
  // ------------------------------------------------------------------

  it("resolves empty / whitespace / null to default", () => {
    expect(resolveWebAccountId(null)).toBe("default");
    expect(resolveWebAccountId(undefined)).toBe("default");
    expect(resolveWebAccountId("")).toBe("default");
    expect(resolveWebAccountId("  ")).toBe("default");
  });

  it("trims whitespace from account IDs", () => {
    expect(resolveWebAccountId(" work ")).toBe("work");
  });

  // ------------------------------------------------------------------
  // Regression: globalThis singleton survives chunk-splitting (#45171)
  // ------------------------------------------------------------------

  it("globalThis singleton: set in one reference, require from another", () => {
    // This test verifies the fix for #45171. In the broken state, the
    // bundler duplicated the module-scoped Map into separate chunks.
    // After the fix, both paths share the same globalThis-anchored Map.
    //
    // We simulate the cross-chunk scenario by directly accessing the
    // globalThis store and verifying it is the same instance used by
    // the exported functions.

    const listener = createMockListener();
    setActiveWebListener("default", listener);

    // The globalThis store should contain the listener we just set.
    const store = globalThis.__openclaw_wa_web_listeners;
    expect(store).toBeDefined();
    expect(store!.get("default")).toBe(listener);

    // requireActiveWebListener should read from the same store.
    const result = requireActiveWebListener("default");
    expect(result.listener).toBe(listener);

    // Simulate what a second chunk's copy would do: read from globalThis.
    const storeFromGlobal = globalThis.__openclaw_wa_web_listeners!;
    expect(storeFromGlobal.get("default")).toBe(listener);
  });

  it("globalThis singleton: external write is visible to require", () => {
    // Simulate a second chunk writing to the globalThis store directly.
    const listener = createMockListener();
    const store = (globalThis.__openclaw_wa_web_listeners ??= new Map());
    store.set("default", listener);

    // requireActiveWebListener should see the externally written listener.
    const result = requireActiveWebListener("default");
    expect(result.listener).toBe(listener);
  });
});
