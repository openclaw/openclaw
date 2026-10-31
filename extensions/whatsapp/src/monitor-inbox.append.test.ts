// WhatsApp monitor inbox append behavior.
import { describe, expect, it, vi } from "vitest";
import {
  getSock,
  installWebMonitorInboxUnitTestHooks,
  resetWebInboundDedupeForTests,
  startInboxMonitor,
  waitForMessageCalls,
  waitForInboundWorkDrained,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

function emitUpsert(
  sock: { ev: { emit: (event: string, payload: unknown) => void } },
  params: {
    id: string;
    body?: string;
    remoteJid?: string;
    type?: "append" | "notify";
    timestamp: unknown;
    participant?: string;
  },
) {
  sock.ev.emit("messages.upsert", {
    type: params.type ?? "append",
    messages: [
      {
        key: {
          id: params.id,
          fromMe: false,
          remoteJid: params.remoteJid ?? "999@s.whatsapp.net",
          participant: params.participant,
        },
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
    [
      "first-link history while connecting",
      "stale-1",
      () => Math.floor(Date.now() / 1000) - 300,
      0,
    ],
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
    getSock().sendPresenceUpdate.mockImplementationOnce(async () => {
      getSock().authState.creds.accountSyncCounter = 1;
    });
    const { listener, sock } = await startInboxMonitor(onMessage);

    emitUpsert(sock, {
      id,
      timestamp: timestamp(),
      type: id === "notify-1" ? "notify" : "append",
      remoteJid: id === "notify-1" ? "999@s.whatsapp.net" : "120363@g.us",
    });
    await waitForInboundWorkDrained();

    expect(onMessage).toHaveBeenCalledTimes(expectedCalls);
    await listener.close();
  });

  it("answers recent offline appends once across listener restarts", async () => {
    getSock().authState.creds.accountSyncCounter = 1;
    const onMessage = vi.fn<InboxOnMessage>(async (msg) => {
      await msg.platform.reply("caught up");
    });
    const timestamp = Math.floor(Date.now() / 1000) - 5 * 60;
    for (let restart = 0; restart < 3; restart++) {
      resetWebInboundDedupeForTests();
      const { listener, sock } = await startInboxMonitor(onMessage);
      try {
        emitUpsert(sock, { id: "offline-restart", timestamp });
        await waitForInboundWorkDrained();
        expect(onMessage).toHaveBeenCalledTimes(1);
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
      } finally {
        await listener.close();
      }
    }
  });

  it("keeps synced-session backlog bounded and subject to group allowlists", async () => {
    getSock().authState.creds.accountSyncCounter = 1;
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      cfg: {
        channels: {
          whatsapp: { allowFrom: ["*"], groupPolicy: "allowlist", groupAllowFrom: ["+111"] },
        },
      },
    });
    try {
      emitUpsert(sock, { id: "ancient", timestamp: Math.floor(Date.now() / 1000) - 25 * 60 });
      emitUpsert(sock, {
        id: "blocked-group",
        remoteJid: "120363@g.us",
        participant: "999@s.whatsapp.net",
        timestamp: Math.floor(Date.now() / 1000) - 5 * 60,
      });
      await waitForInboundWorkDrained();
      expect(onMessage).not.toHaveBeenCalled();
      emitUpsert(sock, {
        id: "allowed-group",
        remoteJid: "120363@g.us",
        participant: "111@s.whatsapp.net",
        timestamp: Math.floor(Date.now() / 1000) - 5 * 60,
      });
      await waitForInboundWorkDrained();
      expect(onMessage).toHaveBeenCalledTimes(1);
      emitUpsert(sock, { id: "allowed-dm", timestamp: Math.floor(Date.now() / 1000) - 5 * 60 });
      await waitForInboundWorkDrained();
      expect(onMessage).toHaveBeenCalledTimes(2);
    } finally {
      await listener.close();
    }
  });

  it("honors a shorter configured offline age cap", async () => {
    const onMessage = vi.fn(async () => {});
    getSock().authState.creds.accountSyncCounter = 1;
    const { listener, sock } = await startInboxMonitor(onMessage, {
      appendReplyMaxAgeMs: 5 * 60_000,
    });

    emitUpsert(sock, {
      id: "catch-up-1",
      body: "missed while reconnecting",
      timestamp: Math.floor(Date.now() / 1000) - 3 * 60,
    });
    await waitForMessageCalls(onMessage, 1);

    emitUpsert(sock, {
      id: "catch-up-old",
      body: "before the recovery window",
      timestamp: Math.floor(Date.now() / 1000) - 6 * 60,
    });
    await waitForInboundWorkDrained();

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("applies the age cap to delayed appends after startup", async () => {
    const connectedAtMs = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(connectedAtMs);
    getSock().authState.creds.accountSyncCounter = 1;
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage);
    try {
      dateNow.mockReturnValue(connectedAtMs + 30 * 60_000);
      emitUpsert(sock, { id: "expired", timestamp: connectedAtMs / 1000 + 5 * 60 });
      await waitForInboundWorkDrained();
      expect(onMessage).not.toHaveBeenCalled();
      emitUpsert(sock, { id: "fresh", timestamp: Date.now() / 1000 });
      await waitForInboundWorkDrained();
      expect(onMessage).toHaveBeenCalledTimes(1);
    } finally {
      await listener.close();
      dateNow.mockRestore();
    }
  });

  it("delivery coordinator processes distinct catch-up messages at the boundary", async () => {
    // Baileys timestamps use whole seconds. Freeze this inclusive boundary so
    // async monitor startup cannot age the fixture beyond maxAgeMs.
    const nowMs = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const onMessage = vi.fn(async () => {});
      const boundarySeconds = nowMs / 1000 - 20 * 60;
      getSock().authState.creds.accountSyncCounter = 1;
      const { listener, sock } = await startInboxMonitor(onMessage);
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
