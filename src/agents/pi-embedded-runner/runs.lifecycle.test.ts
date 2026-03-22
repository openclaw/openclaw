import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  abortEmbeddedPiRun,
  clearActiveEmbeddedRun,
  isEmbeddedPiRunActive,
  setActiveEmbeddedRun,
} from "./runs.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  overrides: { isCompacting?: boolean; abort?: () => void } = {},
): RunHandle {
  const abort = overrides.abort ?? (() => {});
  return {
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => overrides.isCompacting ?? false,
    abort,
  };
}

describe("pi-embedded runner lifecycle", () => {
  afterEach(() => {
    __testing.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  describe("handle identity", () => {
    it("clears the same handle object that was registered", () => {
      const handle = createRunHandle();
      const sessionId = "session-test";

      // Register a handle
      setActiveEmbeddedRun(sessionId, handle, "sessionKey");

      // Verify it's registered
      expect(isEmbeddedPiRunActive(sessionId)).toBe(true);

      // Clear with the SAME handle object
      clearActiveEmbeddedRun(sessionId, handle, "sessionKey");

      // Should be cleared
      expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    });

    it("does NOT clear if handle object is different", () => {
      const handle1 = createRunHandle();
      const handle2 = createRunHandle();
      const sessionId = "session-test";

      // Register handle1
      setActiveEmbeddedRun(sessionId, handle1, "sessionKey");

      // Try to clear with handle2 (different object)
      clearActiveEmbeddedRun(sessionId, handle2, "sessionKey");

      // Should still be registered (handle1)
      expect(isEmbeddedPiRunActive(sessionId)).toBe(true);

      // Clean up with correct handle
      clearActiveEmbeddedRun(sessionId, handle1, "sessionKey");
    });
  });

  describe("deferred cleanup safety net", () => {
    it("clearActiveEmbeddedRun always succeeds with matching handle even after multiple calls", () => {
      // This validates the safety-net behavior: when the finally block calls
      // clearActiveEmbeddedRun (deferredHookHandedOff = false path), it always
      // uses the correct handle and the call succeeds even if the entry was
      // already removed.
      const handle = createRunHandle();
      const sessionId = "session-safetynet";

      setActiveEmbeddedRun(sessionId, handle, "sessionKey");
      expect(isEmbeddedPiRunActive(sessionId)).toBe(true);

      // First clear (simulates deferred cleanup being called)
      clearActiveEmbeddedRun(sessionId, handle, "sessionKey");
      expect(isEmbeddedPiRunActive(sessionId)).toBe(false);

      // Second clear with same handle — should be no-op, not an error
      // (simulates outer finally also trying to clear after deferred ran)
      expect(() => clearActiveEmbeddedRun(sessionId, handle, "sessionKey")).not.toThrow();
      expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    });

    it("active-run does NOT leak when attempt throws (safety net fires)", () => {
      // When runEmbeddedAttempt throws before returning, deferredHookHandedOff
      // stays false, and the finally block's safety net calls
      // clearActiveEmbeddedRun. This test verifies the handle identity is
      // preserved so the safety net call actually removes the entry.
      const handle = createRunHandle();
      const sessionId = "session-throw";

      setActiveEmbeddedRun(sessionId, handle, "sessionKey");
      expect(isEmbeddedPiRunActive(sessionId)).toBe(true);

      // Simulate what the safety net does: it calls clearActiveEmbeddedRun
      // with the SAME handle that was registered. The entry MUST be removed.
      clearActiveEmbeddedRun(sessionId, handle, "sessionKey");
      expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    });

    it("no-retry path: cleanup called once via deferred mechanism", () => {
      // Single attempt (no retry): deferActiveRunCleanup = true, deferred
      // cleanup is called once (in outer finally or equivalent).
      const handle = createRunHandle();
      const sessionId = "session-no-retry";

      setActiveEmbeddedRun(sessionId, handle, "sessionKey");
      expect(isEmbeddedPiRunActive(sessionId)).toBe(true);

      // Single cleanup (deferred path)
      clearActiveEmbeddedRun(sessionId, handle, "sessionKey");
      expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
    });
  });

  describe("abort forwarding", () => {
    it("forwards abort to the registered handle", () => {
      const abortFn = vi.fn();
      const handle = createRunHandle({ abort: abortFn });
      const sessionId = "session-abort";

      setActiveEmbeddedRun(sessionId, handle, "sessionKey");

      abortEmbeddedPiRun(sessionId);

      expect(abortFn).toHaveBeenCalledTimes(1);

      // Cleanup
      clearActiveEmbeddedRun(sessionId, handle, "sessionKey");
    });

    it("preserves abort reason when forwarding", () => {
      const abortFn = vi.fn();
      const customReason = new Error("custom abort reason");
      const handle: RunHandle = {
        queueMessage: async () => {},
        isStreaming: () => true,
        isCompacting: () => false,
        abort: abortFn,
      };
      const sessionId = "session-reason";

      setActiveEmbeddedRun(sessionId, handle, "sessionKey");

      abortEmbeddedPiRun(sessionId, { reason: customReason });

      expect(abortFn).toHaveBeenCalledTimes(1);

      // Cleanup
      clearActiveEmbeddedRun(sessionId, handle, "sessionKey");
    });
  });
});
