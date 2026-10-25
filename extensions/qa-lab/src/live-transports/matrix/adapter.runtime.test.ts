import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForMatrixQaObserverEvent } from "./adapter.runtime.js";
import type { MatrixQaRoomObserver } from "./substrate/sync.js";

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(async () => undefined),
}));

function makeObserver(
  waitForOptionalRoomEvent: MatrixQaRoomObserver["waitForOptionalRoomEvent"],
): MatrixQaRoomObserver {
  return {
    prime: vi.fn(async () => "s0"),
    waitForOptionalRoomEvent,
    waitForRoomEvent: vi.fn(),
  };
}

describe("Matrix QA adapter observer recovery", () => {
  afterEach(() => vi.clearAllMocks());
  it("retries a sync failure only during the explicit transport interruption window", async () => {
    let interrupted = true;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockRejectedValueOnce(new Error("homeserver unavailable"))
      .mockResolvedValueOnce({ matched: false, since: "s1" });
    vi.mocked(sleep).mockImplementationOnce(async () => {
      interrupted = false;
    });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => interrupted,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        roomId: "!room:matrix.test",
      }),
    ).resolves.toEqual({ matched: false, since: "s1" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("preserves terminal observer failures outside the interruption window", async () => {
    const failure = new Error("sync failed");
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockRejectedValue(failure);
    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => false,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        roomId: "!room:matrix.test",
      }),
    ).rejects.toBe(failure);
    expect(waitForOptionalRoomEvent).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a poll that started during interruption after readiness closes the window", async () => {
    let interrupted = true;
    const waitForOptionalRoomEvent = vi
      .fn<MatrixQaRoomObserver["waitForOptionalRoomEvent"]>()
      .mockImplementationOnce(async () => {
        interrupted = false;
        throw new Error("stale outage response");
      })
      .mockResolvedValueOnce({ matched: false, since: "s2" });

    await expect(
      waitForMatrixQaObserverEvent({
        isExpectedInterruption: () => interrupted,
        observer: makeObserver(waitForOptionalRoomEvent),
        predicate: () => true,
        roomId: "!room:matrix.test",
      }),
    ).resolves.toEqual({ matched: false, since: "s2" });
    expect(waitForOptionalRoomEvent).toHaveBeenCalledTimes(2);
  });
});
