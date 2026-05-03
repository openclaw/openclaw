import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import {
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

describe("replyToOfflineMessages opt-in append handling", () => {
  installWebMonitorInboxUnitTestHooks();

  it("processes recent append messages when replyToOfflineMessages is true", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      replyToOfflineMessages: true,
    });

    const recentTs = Math.floor(Date.now() / 1000) - 5;
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "offline-recent", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "missed message" },
          messageTimestamp: recentTs,
          pushName: "Tester",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);

    await listener.close();
  });

  it("skips append messages older than offlineMessageMaxAgeSeconds", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      replyToOfflineMessages: true,
      offlineMessageMaxAgeSeconds: 60,
    });

    // 10 minutes ago, well past the 60-second cap.
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "offline-stale", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "very old missed message" },
          messageTimestamp: oldTs,
          pushName: "OldTester",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("uses default 300s threshold when offlineMessageMaxAgeSeconds is omitted", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      replyToOfflineMessages: true,
    });

    // 10 minutes ago, beyond the default 300s threshold.
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "offline-default-stale", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "old default-threshold message" },
          messageTimestamp: oldTs,
          pushName: "DefaultStale",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("rejects untimestamped append messages even with replyToOfflineMessages", async () => {
    const onMessage = vi.fn(async () => {});
    const { listener, sock } = await startInboxMonitor(onMessage, {
      replyToOfflineMessages: true,
    });

    // NaN timestamp must not bypass the age cap by short-circuiting.
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { id: "offline-nan", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "untimestamped catch-up" },
          messageTimestamp: Number.NaN,
          pushName: "BadTs",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });
});
