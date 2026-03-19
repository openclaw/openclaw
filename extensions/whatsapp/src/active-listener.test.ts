import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveWebListener,
  requireActiveWebListener,
  setActiveWebListener,
} from "./active-listener.js";
import type { ActiveWebListener } from "./active-listener.js";

function makeListener(): ActiveWebListener {
  return {
    sendMessage: async () => ({ messageId: "x" }),
    sendPoll: async () => ({ messageId: "x" }),
    sendReaction: async () => {},
    sendComposingTo: async () => {},
  };
}

afterEach(() => {
  // Clean up default and named accounts after each test.
  setActiveWebListener(null);
  setActiveWebListener("work", null);
});

describe("setActiveWebListener / getActiveWebListener", () => {
  it("registers and retrieves a listener for the default account", () => {
    const l = makeListener();
    setActiveWebListener(l);
    expect(getActiveWebListener()).toBe(l);
  });

  it("registers and retrieves a listener for a named account", () => {
    const l = makeListener();
    setActiveWebListener("work", l);
    expect(getActiveWebListener("work")).toBe(l);
  });

  it("clears the listener unconditionally when expected is omitted", () => {
    const l = makeListener();
    setActiveWebListener(l);
    setActiveWebListener(null);
    expect(getActiveWebListener()).toBeNull();
  });

  it("clears the listener when expected matches the current registration", () => {
    const l = makeListener();
    setActiveWebListener("work", l);
    setActiveWebListener("work", null, l);
    expect(getActiveWebListener("work")).toBeNull();
  });

  it("does NOT clear the listener when expected does not match (stale shutdown guard)", () => {
    const oldListener = makeListener();
    const newListener = makeListener();

    // New instance registers first (restart scenario).
    setActiveWebListener("work", newListener);

    // Old instance's closeListener fires with its own stale reference.
    setActiveWebListener("work", null, oldListener);

    // New instance's slot must still be intact.
    expect(getActiveWebListener("work")).toBe(newListener);
  });

  it("replaces an existing listener with a newer one", () => {
    const l1 = makeListener();
    const l2 = makeListener();
    setActiveWebListener(l1);
    setActiveWebListener(l2);
    expect(getActiveWebListener()).toBe(l2);
  });
});

describe("requireActiveWebListener", () => {
  it("returns the listener and accountId when registered", () => {
    const l = makeListener();
    setActiveWebListener(l);
    const result = requireActiveWebListener();
    expect(result.listener).toBe(l);
    expect(result.accountId).toBe("default");
  });

  it("throws when no listener is registered", () => {
    expect(() => requireActiveWebListener()).toThrow(/No active WhatsApp Web listener/);
  });
});
