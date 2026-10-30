// WhatsApp monitor inbox append behavior.
import { describe, expect, it, vi } from "vitest";
import {
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

function emitUpsert(
  sock: { ev: { emit: (event: string, payload: unknown) => void } },
  params: {
    id: string;
    body?: string;
    remoteJid?: string;
    type?: "append" | "notify";
    timestamp: unknown;
  },
) {
  sock.ev.emit("messages.upsert", {
    type: params.type ?? "append",
    messages: [
      {
        key: { id: params.id, fromMe: false, remoteJid: params.remoteJid ?? "999@s.whatsapp.net" },
        message: { conversation: params.body ?? params.id },
        messageTimestamp: params.timestamp,
        pushName: "Tester",
      },
    ],
  });
}

describe("append upsert handling (#20952)", () => {
  installWebMonitorInboxUnitTestHooks();

  it.each([
    ["recent append", "recent-1", () => Math.floor(Date.now() / 1000) - 5, 1],
    ["stale append", "stale-1", () => Math.floor(Date.now() / 1000) - 300, 0],
    ["non-finite timestamp", "nan-1", () => Number.NaN, 0],
    [
      "non-decimal timestamp",
      "hex-1",
      () => `0x${(Math.floor(Date.now() / 1000) - 5).toString(16)}`,
      0,
    ],
    [
      "Long-like timestamp",
      "long-1",
      () => {
        const recent = Math.floor(Date.now() / 1000) - 5;
        return { low: recent, high: 0, unsigned: true, valueOf: () => recent };
      },
      1,
    ],
    ["old notify", "notify-1", () => Math.floor(Date.now() / 1000) - 86_400, 1],
  ] as const)("delivery coordinator handles %s", async (_name, id, timestamp, expectedCalls) => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);

    emitUpsert(sock, {
      id,
      timestamp: timestamp(),
      type: id === "notify-1" ? "notify" : "append",
      remoteJid: id === "notify-1" ? "999@s.whatsapp.net" : "120363@g.us",
    });
    if (expectedCalls === 1) {
      await waitForMessageCalls(onMessage, 1);
    } else {
      await settleInboundWork();
    }

    expect(onMessage).toHaveBeenCalledTimes(expectedCalls);
    await listener.close();
  });

  it("delivery coordinator limits reconnect catch-up appends by dedupe age", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      appendReplyWindow: {
        afterMs: Date.now() - 30 * 60_000,
        untilMs: Date.now() + 30 * 60_000,
        maxAgeMs: 20 * 60_000,
      },
    });

    emitUpsert(sock, {
      id: "catch-up-1",
      body: "missed while reconnecting",
      timestamp: Math.floor(Date.now() / 1000) - 15 * 60,
    });
    await waitForMessageCalls(onMessage, 1);

    emitUpsert(sock, {
      id: "catch-up-old",
      body: "before the recovery window",
      timestamp: Math.floor(Date.now() / 1000) - 25 * 60,
    });
    await settleInboundWork();

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator preserves fresh appends after catch-up expires", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      appendReplyWindow: {
        afterMs: Date.now() - 30 * 60_000,
        untilMs: Date.now() - 1,
        maxAgeMs: 20 * 60_000,
      },
    });

    emitUpsert(sock, {
      id: "catch-up-late",
      body: "arrived after recovery",
      timestamp: Math.floor(Date.now() / 1000) - 5 * 60,
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    emitUpsert(sock, {
      id: "fresh-after-catch-up",
      body: "fresh after recovery",
      timestamp: Math.floor(Date.now() / 1000),
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("delivery coordinator processes distinct catch-up messages at the boundary", async () => {
    // Baileys timestamps use whole seconds. Freeze this inclusive boundary so
    // async monitor startup cannot age the fixture beyond maxAgeMs.
    const nowMs = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const onMessage = vi.fn(async () => {});
      const boundarySeconds = nowMs / 1000 - 20 * 60;
      const { listener, sock } = await startInboxMonitor(onMessage, {
        appendReplyWindow: {
          afterMs: boundarySeconds * 1000,
          untilMs: nowMs + 30 * 60_000,
          maxAgeMs: 20 * 60_000,
        },
      });
      try {
        emitUpsert(sock, {
          id: "catch-up-same-second",
          body: "same second, different message",
          timestamp: boundarySeconds,
        });
        await waitForMessageCalls(onMessage, 1);

        expect(onMessage).toHaveBeenCalledTimes(1);
      } finally {
        await listener.close();
      }
    } finally {
      dateNow.mockRestore();
    }
  });
});
