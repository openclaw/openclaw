import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildNotifyMessageUpsert,
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";
import type { InboxOnMessage } from "./monitor-inbox.test-harness.js";

describe("readOnly account — transport write guards", () => {
  installWebMonitorInboxUnitTestHooks();

  it("does not announce presence on connect when readOnly: true", async () => {
    const onMessage = vi.fn();
    const { sock } = await startInboxMonitor(onMessage as InboxOnMessage, { readOnly: true });

    expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("does not send reply when readOnly: true", async () => {
    const onMessage = vi.fn();
    const { sock } = await startInboxMonitor(onMessage as InboxOnMessage, { readOnly: true });

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: "ro-reply-1",
        remoteJid: "999@s.whatsapp.net",
        text: "hello",
        timestamp: 1_700_000_000,
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    const msg = onMessage.mock.calls[0]?.[0] as {
      reply: (text: string) => Promise<void>;
    };
    await msg.reply("response");
    await settleInboundWork();

    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it("still delivers inbound messages when readOnly: true", async () => {
    const onMessage = vi.fn();
    const { sock } = await startInboxMonitor(onMessage as InboxOnMessage, { readOnly: true });

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: "ro-deliver-1",
        remoteJid: "999@s.whatsapp.net",
        text: "ping",
        timestamp: 1_700_000_002,
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    const msg = onMessage.mock.calls[0]?.[0] as { body: string };
    expect(msg.body).toBe("ping");
  });

  it("does not send composing presence when readOnly: true", async () => {
    const onMessage = vi.fn();
    const { sock } = await startInboxMonitor(onMessage as InboxOnMessage, { readOnly: true });

    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: "ro-composing-1",
        remoteJid: "999@s.whatsapp.net",
        text: "hello",
        timestamp: 1_700_000_003,
      }),
    );
    await waitForMessageCalls(onMessage, 1);

    const msg = onMessage.mock.calls[0]?.[0] as {
      sendComposing: () => Promise<void>;
    };
    await msg.sendComposing();
    await settleInboundWork();

    // Neither the connect-presence update nor composing presence should have been sent.
    expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
  });

  it("does not send a message on its own initiative when readOnly: true", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn() as InboxOnMessage, {
      readOnly: true,
    });

    await listener.sendMessage("999@s.whatsapp.net", "initiative send");

    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it("does not send composing presence on its own initiative when readOnly: true", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn() as InboxOnMessage, {
      readOnly: true,
    });

    await listener.sendComposingTo("999@s.whatsapp.net");

    expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
  });
});
