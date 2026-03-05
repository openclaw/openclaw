import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPumbleThreadBindingManager } from "./thread-bindings.manager.js";
import {
  BINDINGS_BY_THREAD_ROOT_ID,
  resetPumbleThreadBindingsForTests,
  setBindingRecord,
} from "./thread-bindings.state.js";
import type { PumbleThreadBindingRecord } from "./thread-bindings.types.js";

vi.mock("./client.js", () => ({
  createPumbleClient: () => ({
    apiBase: "https://api.pumble.com",
    getAuthHeaders: () => ({}),
  }),
  postPumbleMessage: vi.fn(async () => ({ id: "mock-msg-id" })),
}));

function makeBinding(
  overrides: Partial<PumbleThreadBindingRecord> = {},
): PumbleThreadBindingRecord {
  return {
    accountId: "default",
    channelId: "ch-1",
    threadRootId: `thread-${Math.random().toString(36).slice(2, 8)}`,
    targetKind: "subagent",
    targetSessionKey: "agent:test:session",
    agentId: "test",
    boundBy: "system",
    boundAt: Date.now(),
    ...overrides,
  };
}

describe("thread binding sweep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPumbleThreadBindingsForTests();
  });

  afterEach(() => {
    resetPumbleThreadBindingsForTests();
    vi.useRealTimers();
  });

  it("sweeps expired bindings after interval", () => {
    const now = Date.now();
    const manager = createPumbleThreadBindingManager({
      accountId: "default",
      botToken: "xoxb-test",
      persist: false,
      enableSweeper: true,
      sessionTtlMs: 60_000, // 1 minute TTL
    });

    // Manually insert an already-expired binding
    const expired = makeBinding({
      threadRootId: "thread-expired",
      boundAt: now - 120_000, // bound 2 minutes ago
      expiresAt: now - 60_000, // expired 1 minute ago
    });
    setBindingRecord(expired);

    // Also insert a still-valid binding
    const valid = makeBinding({
      threadRootId: "thread-valid",
      boundAt: now,
      expiresAt: now + 300_000, // expires in 5 minutes
    });
    setBindingRecord(valid);

    expect(manager.listBindings().length).toBe(2);

    // Advance past the sweep interval (120s)
    vi.advanceTimersByTime(120_001);

    // Expired binding should be removed
    expect(manager.getByThreadRootId("thread-expired")).toBeUndefined();
    // Valid binding should remain
    expect(manager.getByThreadRootId("thread-valid")).toBeDefined();
    expect(manager.listBindings().length).toBe(1);

    manager.stop();
  });

  it("does not sweep bindings without expiresAt when TTL is 0", () => {
    const manager = createPumbleThreadBindingManager({
      accountId: "default",
      botToken: "xoxb-test",
      persist: false,
      enableSweeper: true,
      sessionTtlMs: 0, // disabled
    });

    const binding = makeBinding({
      threadRootId: "thread-no-expire",
      boundAt: Date.now() - 999_999_999,
      expiresAt: undefined,
    });
    setBindingRecord(binding);

    vi.advanceTimersByTime(240_001);

    expect(manager.getByThreadRootId("thread-no-expire")).toBeDefined();

    manager.stop();
  });

  it("sweeper does nothing when no bindings exist", () => {
    const manager = createPumbleThreadBindingManager({
      accountId: "default",
      botToken: "xoxb-test",
      persist: false,
      enableSweeper: true,
      sessionTtlMs: 60_000,
    });

    // Should not throw
    vi.advanceTimersByTime(240_001);
    expect(manager.listBindings().length).toBe(0);

    manager.stop();
  });

  it("stop() clears the sweep timer", () => {
    const manager = createPumbleThreadBindingManager({
      accountId: "default",
      botToken: "xoxb-test",
      persist: false,
      enableSweeper: true,
      sessionTtlMs: 60_000,
    });

    const binding = makeBinding({
      threadRootId: "thread-to-expire",
      boundAt: Date.now(),
      expiresAt: Date.now() + 1000, // expires quickly
    });
    setBindingRecord(binding);

    manager.stop();

    // Advance past both expiry and sweep interval
    vi.advanceTimersByTime(240_001);

    // Binding should still exist because sweeper was stopped
    expect(BINDINGS_BY_THREAD_ROOT_ID.has("default:thread-to-expire")).toBe(true);
  });
});
