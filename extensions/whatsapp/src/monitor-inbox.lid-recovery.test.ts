import { observeChannelIngressQueueWrite } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createWhatsAppDurableInboundQueue,
  createWhatsAppDurableInboundMessageId,
} from "./inbound/durable-receive.js";
import {
  nextMessageId,
  installStreamsInboundMessageHooks,
} from "./monitor-inbox.streams-inbound-messages.test-support.js";
import {
  buildNotifyMessageUpsert,
  DEFAULT_ACCOUNT_ID,
  resetWebInboundDedupeForTests,
  startInboxMonitor,
  upsertPairingRequestMock,
  waitForInboundWorkDrained,
} from "./monitor-inbox.test-harness.js";

async function withRetryClock(run: () => Promise<void>) {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe("unresolved WhatsApp identity recovery", () => {
  installStreamsInboundMessageHooks();
  it("retains an unresolved LID across monitor restart and dead-letters a permanent miss", () =>
    withRetryClock(async () => {
      const onMessage = vi.fn();
      const queue = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
      const upsert = buildNotifyMessageUpsert({
        id: nextMessageId("restart-lid-miss"),
        remoteJid: "12345@lid",
        text: "identity still unavailable",
        timestamp: 1_700_000_000,
      });
      const id = createWhatsAppDurableInboundMessageId({
        remoteJid: "12345@lid",
        id: upsert.messages[0]!.key.id!,
      });
      let started = await startInboxMonitor(onMessage, { durableInboundQueue: queue });
      try {
        started.sock.ev.emit("messages.upsert", upsert);
        await waitForInboundWorkDrained();
        expect(await queue.listPending({ limit: "all" })).toMatchObject([{ id, attempts: 1 }]);
        expect(onMessage).not.toHaveBeenCalled();
        expect(started.sock.readMessages).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
        await started.listener.close();
        resetWebInboundDedupeForTests();

        // Reopen the real SQLite queue, not a seeded replacement or mocked receipt.
        const reopened = createWhatsAppDurableInboundQueue(DEFAULT_ACCOUNT_ID);
        expect(await reopened.listPending({ limit: "all" })).toMatchObject([{ id, attempts: 1 }]);
        // Meet the production age floor without running a day's worth of poll timers.
        vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1_000);
        const resumed = observeChannelIngressQueueWrite(reopened, "release", id);
        started = await startInboxMonitor(onMessage, { durableInboundQueue: reopened });
        expect(await resumed).toBe(true);
        await waitForInboundWorkDrained();
        expect(await reopened.listPending({ limit: "all" })).toMatchObject([{ id, attempts: 2 }]);
        for (let attempt = 3; attempt <= 8; attempt++) {
          const committed = observeChannelIngressQueueWrite(
            reopened,
            attempt === 8 ? "fail" : "release",
            id,
          );
          await vi.advanceTimersByTimeAsync(2 ** (attempt - 2) * 1_000);
          expect(await committed).toBe(true);
          await waitForInboundWorkDrained();
        }
        expect(await reopened.listPending({ limit: "all" })).toEqual([]);
        expect(await reopened.listClaims()).toEqual([]);
        expect(await reopened.listFailed?.({ limit: "all" })).toMatchObject([
          {
            id,
            attempts: 7, // The terminal eighth failure does not increment stored releases.
            reason: "retry-limit-exceeded",
            message: expect.stringContaining("LID identity unavailable"),
          },
        ]);
        expect(onMessage).not.toHaveBeenCalled();
        expect(started.sock.readMessages).not.toHaveBeenCalled();
        expect(started.sock.sendMessage).not.toHaveBeenCalled();
        expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      } finally {
        await started.listener.close();
      }
    }));
});
