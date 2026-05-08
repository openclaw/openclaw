import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueAnnounce, resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";

function createRetryingSend() {
  const prompts: string[] = [];
  let attempts = 0;
  let resolved = false;
  let resolveSecondAttempt = () => {};
  const waitForSecondAttempt = new Promise<void>((resolve) => {
    resolveSecondAttempt = resolve;
  });

  const send = vi.fn(async (item: { prompt: string }) => {
    attempts += 1;
    prompts.push(item.prompt);
    if (attempts >= 2 && !resolved) {
      resolved = true;
      resolveSecondAttempt();
    }
    if (attempts === 1) {
      throw new Error("gateway timeout after 60000ms");
    }
  });

  return { send, prompts, waitForSecondAttempt };
}

describe("subagent-announce-queue", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAnnounceQueuesForTests();
  });

  it("retries failed sends without dropping queued announce items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:retry",
      item: {
        prompt: "subagent completed",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts).toEqual(["subagent completed", "subagent completed"]);
  });

  it("preserves queue summary state across failed summary delivery retries", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "first result",
        summaryLine: "first result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:summary-retry",
      item: {
        prompt: "second result",
        summaryLine: "second result",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "followup", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("[Queue overflow]");
    expect(sender.prompts[1]).toContain("[Queue overflow]");
  });

  it("retries collect-mode batches without losing queued items", async () => {
    const sender = createRetryingSend();

    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item one",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });
    enqueueAnnounce({
      key: "announce:test:collect-retry",
      item: {
        prompt: "queued item two",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main:telegram:dm:u1",
      },
      settings: { mode: "collect", debounceMs: 0 },
      send: sender.send,
    });

    await sender.waitForSecondAttempt;
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(sender.prompts[0]).toContain("Queued #1");
    expect(sender.prompts[0]).toContain("queued item one");
    expect(sender.prompts[0]).toContain("Queued #2");
    expect(sender.prompts[0]).toContain("queued item two");
    expect(sender.prompts[1]).toContain("Queued #1");
    expect(sender.prompts[1]).toContain("queued item one");
    expect(sender.prompts[1]).toContain("Queued #2");
    expect(sender.prompts[1]).toContain("queued item two");
  });

  it("uses debounce floor for retries when debounce exceeds backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;

    try {
      const attempts: number[] = [];
      const send = vi.fn(async () => {
        attempts.push(Date.now());
        if (attempts.length === 1) {
          throw new Error("transient timeout");
        }
      });

      enqueueAnnounce({
        key: "announce:test:retry-debounce-floor",
        item: {
          prompt: "subagent completed",
          enqueuedAt: Date.now(),
          sessionKey: "agent:main:telegram:dm:u1",
        },
        settings: { mode: "followup", debounceMs: 5_000 },
        send,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      const [firstAttempt, secondAttempt] = attempts;
      if (firstAttempt === undefined || secondAttempt === undefined) {
        throw new Error("expected two retry attempts");
      }
      expect(secondAttempt - firstAttempt).toBeGreaterThanOrEqual(5_000);
    } finally {
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });
});
