import { afterEach, describe, expect, it, vi } from "vitest";

const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logSessionStateChange: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
  diagnosticLogger: diagnosticMocks.diag,
}));

import {
  clearActiveEmbeddedRun,
  queueEmbeddedPiMessage,
  setActiveEmbeddedRun,
  waitForEmbeddedPiRunEnd,
} from "./runs.js";

describe("embedded run registry", () => {
  afterEach(() => {
    vi.useRealTimers();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.diag.debug.mockReset();
    diagnosticMocks.diag.warn.mockReset();
  });

  it("resolves waiters when run is cleared", async () => {
    const sessionId = `sess-${Date.now()}-clear`;
    const handle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle);
    const waiter = waitForEmbeddedPiRunEnd(sessionId, 1000);
    clearActiveEmbeddedRun(sessionId, handle);
    await expect(waiter).resolves.toBe(true);
  });

  it("returns false when wait times out", async () => {
    vi.useFakeTimers();
    const sessionId = `sess-${Date.now()}-timeout`;
    const handle = {
      queueMessage: vi.fn(async () => {}),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle);
    const waiter = waitForEmbeddedPiRunEnd(sessionId, 100);
    await vi.advanceTimersByTimeAsync(110);
    await expect(waiter).resolves.toBe(false);
    clearActiveEmbeddedRun(sessionId, handle);
  });

  it("logs queueMessage promise rejections without throwing", async () => {
    const sessionId = `sess-${Date.now()}-queue-error`;
    const handle = {
      queueMessage: vi.fn(async () => {
        throw new Error("steer failed");
      }),
      isStreaming: vi.fn(() => true),
      isCompacting: vi.fn(() => false),
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle);
    const queued = queueEmbeddedPiMessage(sessionId, "hello");
    expect(queued).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(diagnosticMocks.diag.warn).toHaveBeenCalledWith(
      expect.stringContaining("queue message error"),
    );
    clearActiveEmbeddedRun(sessionId, handle);
  });
});
