import { expect, it, vi } from "vitest";
import {
  CodexSteeringAcceptedUnconfirmedError,
  type createCodexSteeringQueue,
} from "./attempt-steering.js";
import { createClientHarness } from "./test-support.js";

type QueueParams = Parameters<typeof createCodexSteeringQueue>[0];

type ConfirmationCaseFixtures = {
  createQueue: (
    client: QueueParams["client"],
    options?: Partial<Pick<QueueParams, "requestTimeoutMs" | "signal">>,
  ) => ReturnType<typeof createCodexSteeringQueue>;
  createReplyHarness: () => ReturnType<typeof createClientHarness>;
};

/** Registers inside the steering suite so its fake-clock lifecycle stays authoritative. */
export function registerCodexSteeringConfirmationCases({
  createQueue,
  createReplyHarness,
}: ConfirmationCaseFixtures): void {
  it("bounds consumption confirmation after a successful steering acknowledgement", async () => {
    const harness = createClientHarness({
      onWrite: (line, send) => {
        const request = JSON.parse(line);
        send({ id: request.id, result: { turnId: "turn-1" } });
      },
    });
    const queue = createQueue(harness.client, { requestTimeoutMs: 1_000 });
    const accepted = vi.fn();
    const settled = vi.fn();
    const outcomes: unknown[] = [];
    let next: Promise<void> | undefined;
    const delivery = queue
      .queue("synthetic follow-up", {
        debounceMs: 0,
        onQueueAccepted: accepted,
        onQueueSettled: settled,
      })
      .then(
        () => outcomes.push("resolved"),
        (error: unknown) => outcomes.push(error),
      );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(accepted).toHaveBeenCalledWith(true);
      expect(outcomes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(outcomes[0]).toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
      expect(outcomes[0]).toMatchObject({
        cause: { message: "Codex steering transcript consumption confirmation timed out" },
      });
      expect(settled).not.toHaveBeenCalled();
      // The caller's deadline cannot withdraw the receiving run's accepted input.
      expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
      expect(queue.getAcceptedMessages()).toHaveLength(1);
      expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
      expect(settled).toHaveBeenCalledOnce();
      expect(outcomes).toHaveLength(1);

      next = queue.queue("synthetic later follow-up", { debounceMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.writes).toHaveLength(2);
      expect(queue.confirmConsumed("openclaw:turn-1:steer:2")).toBe(true);
      await next;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      queue.cancel();
      harness.client.close();
      await Promise.allSettled([delivery, next]);
    }
  });

  it.each(["consume", "cancel"] as const)(
    "retains acknowledged queue-only custody past the deadline until %s",
    async (outcome) => {
      const harness = createReplyHarness();
      const queue = createQueue(harness.client, { requestTimeoutMs: 1_000 });
      const accepted = vi.fn();
      const settled = vi.fn();
      const delivered = vi.fn();
      const delivery = queue
        .queue("synthetic queue-only message", {
          debounceMs: 0,
          waitForTranscriptCommit: false,
          onQueueAccepted: accepted,
          onQueueSettled: settled,
        })
        .then(delivered);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(accepted).toHaveBeenCalledExactlyOnceWith(true);
        expect(delivered).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(settled).not.toHaveBeenCalled();
        expect(queue.getAcceptedMessages()).toHaveLength(1);
        if (outcome === "consume") {
          expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
        } else {
          queue.cancel();
          expect(queue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(false);
        }
        expect(settled).toHaveBeenCalledOnce();
        queue.cancel();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(harness.writes).toHaveLength(1);
        expect(settled).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledOnce();
      } finally {
        queue.cancel();
        harness.client.close();
        await delivery.catch(() => {});
      }
    },
  );

  it.each([undefined, false])(
    "aborts unacknowledged steering with transcript wait=%s",
    async (waitForTranscriptCommit) => {
      const harness = createClientHarness();
      const controller = new AbortController();
      const queue = createQueue(harness.client, { signal: controller.signal });
      const queued = queue.queue("steer me", { debounceMs: 0, waitForTranscriptCommit });
      const rejected = expect(queued).rejects.toBeInstanceOf(CodexSteeringAcceptedUnconfirmedError);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.client.getPendingRequestMethods()).toEqual(["turn/steer"]);
        expect(harness.writes).toHaveLength(1);

        controller.abort();

        await rejected;
        expect(harness.client.getPendingRequestMethods()).toEqual([]);
      } finally {
        controller.abort();
        queue.cancel();
        harness.client.close();
        await Promise.allSettled([queued, rejected]);
      }
    },
  );
}
