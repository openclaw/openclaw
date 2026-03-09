import { describe, expect, it, vi } from "vitest";
import { waitForAgentSessionEventQueue } from "./session-event-queue.js";

describe("waitForAgentSessionEventQueue", () => {
  it("waits for the queued session event work to finish", async () => {
    const resolved: string[] = [];
    let releaseQueue: (() => void) | undefined;
    const queue = new Promise<void>((resolve) => {
      releaseQueue = () => {
        resolved.push("queue");
        resolve();
      };
    });

    const waitPromise = waitForAgentSessionEventQueue({
      session: { _agentEventQueue: queue },
      onTimeout: () => {
        resolved.push("timeout");
      },
    }).then(() => {
      resolved.push("wait");
    });

    await Promise.resolve();
    expect(resolved).toEqual([]);

    releaseQueue?.();
    await waitPromise;

    expect(resolved).toEqual(["queue", "wait"]);
  });

  it("returns immediately when no event queue is exposed", async () => {
    await expect(
      waitForAgentSessionEventQueue({
        session: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("times out instead of hanging forever on a stuck queue", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const waitPromise = waitForAgentSessionEventQueue({
        session: { _agentEventQueue: new Promise(() => {}) },
        timeoutMs: 250,
        onTimeout: () => {
          events.push("timeout");
        },
      }).then(() => {
        events.push("wait");
      });

      await vi.advanceTimersByTimeAsync(250);
      await waitPromise;

      expect(events).toEqual(["timeout", "wait"]);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});
