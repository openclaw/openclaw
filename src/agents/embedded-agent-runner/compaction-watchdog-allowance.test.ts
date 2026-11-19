import { expect, it, vi } from "vitest";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { withCompactionWatchdogAllowance } from "./compaction-watchdog-allowance.js";

const stallFloorMs = 6 * 60_000;

it("keeps a quiet compaction alive until compaction.timeoutSeconds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  try {
    const operation = createReplyOperation({
      sessionKey: "agent:main:compaction-stall",
      sessionId: "compaction-stall",
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
    operation.watchdog.attachAttempt({ assertCurrent() {} });
    await withSessionControllerOwner(operation, () =>
      withCompactionWatchdogAllowance(600_000, operation.abortSignal, async () => {
        vi.setSystemTime(stallFloorMs);
        expect(operation.watchdog.snapshot().semanticDeadlineAtMs).toBe(600_000);
        await expect(operation.watchdog.tick()).resolves.toMatchObject({ action: "observe" });
        expect(operation.abortSignal.aborted).toBe(false);
      }),
    );
  } finally {
    testing.resetSessionControllerForTest();
    vi.useRealTimers();
  }
});

it("still aborts when the reply is cancelled during compaction", async () => {
  const operation = createReplyOperation({
    sessionKey: "agent:main:compaction-abort",
    sessionId: "compaction-abort",
    resetTriggered: false,
  });
  operation.setPhase("running");
  operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
  operation.watchdog.attachAttempt({ assertCurrent() {} });
  try {
    await withSessionControllerOwner(operation, () =>
      withCompactionWatchdogAllowance(600_000, operation.abortSignal, async () => {
        operation.abort();
        expect(operation.abortSignal.aborted).toBe(true);
      }),
    );
  } finally {
    testing.resetSessionControllerForTest();
  }
});
