import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SESSION_CONTROLLER_DRAIN_TIMEOUT_MS } from "../../../sessions/session-controller.lifecycle.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
} from "../../../sessions/session-controller.stop.js";
import { settleSubagentKillSources } from "./subagent-control-kill-settlement.js";
import { startControlProducer } from "./subagent-control-native.test-support.js";

it("joins only interrupted operations after cancellation revokes authority", async () => {
  vi.useFakeTimers();
  const release = createDeferred();
  const start = (name: string, onCancel?: () => Promise<void>) =>
    startControlProducer(`agent:main:kill-settlement-${name}`, name, "/synthetic", onCancel);
  const cancelled = start("cancelled", () => release.promise);
  const untouched = start("untouched");
  let joined: ReturnType<typeof settleSubagentKillSources> | undefined;
  try {
    const revoked = new Error("Caller control revoked by accepted cancellation");
    const capture = captureSessionControllerStop({
      operations: [cancelled.operation, untouched.operation],
    });
    const stopped = cancelCapturedSessionControllerSource(capture, {
      assertCurrent: () => {
        if (cancelled.operation.abortSignal.aborted) {
          throw revoked;
        }
      },
      onError: () => "continue",
    });
    expect(stopped).toMatchObject({ activeCancelled: 1, failures: [{ error: revoked }] });
    expect(cancelled.operation.abortSignal.aborted).toBe(true);
    expect(untouched.operation).toMatchObject({ abortSignal: { aborted: false }, result: null });

    joined = settleSubagentKillSources({ cleanup: capture });
    const settled = vi.fn();
    void joined.then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).not.toHaveBeenCalled();

    release.resolve();
    await cancelled.settled;
    await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);
    expect(await joined).toEqual({});
    expect(untouched.operation).toMatchObject({ abortSignal: { aborted: false }, result: null });
  } finally {
    release.resolve();
    await Promise.allSettled([cancelled.settled, joined]);
    vi.useRealTimers();
  }
});
