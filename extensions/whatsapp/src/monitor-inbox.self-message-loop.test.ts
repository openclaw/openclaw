import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import {
  type InboxOnMessage,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
} from "./monitor-inbox.test-harness.js";

describe("self-message loop prevention (#61033)", () => {
  installWebMonitorInboxUnitTestHooks();

  it("drops fromMe DMs to self when selfChatMode is not enabled", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    const onMessage = vi.fn(async () => {});

    // selfChatMode defaults to undefined (not enabled)
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    // Simulate a fromMe message to the bot's own JID (self-chat)
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "self-msg-1",
            fromMe: true,
            remoteJid: "123@s.whatsapp.net", // same as mock sock user
          },
          message: { conversation: "Hello self" },
          messageTimestamp: 1_700_000_000,
          pushName: "Me",
        },
      ],
    });
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it("allows fromMe DMs to self when selfChatMode is enabled", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"], selfChatMode: true } },
    });
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      selfChatMode: true,
    });

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "self-msg-2",
            fromMe: true,
            remoteJid: "123@s.whatsapp.net",
          },
          message: { conversation: "Hello self" },
          messageTimestamp: 1_700_000_000,
          pushName: "Me",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hello self", fromMe: true }),
    );

    await listener.close();
  });

  it("still processes fromMe=false DMs from other senders", async () => {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    const onMessage = vi.fn(async () => {});

    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: "other-msg-1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "Hello from other" },
          messageTimestamp: 1_700_000_000,
          pushName: "Other User",
        },
      ],
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Hello from other", from: "+999" }),
    );

    await listener.close();
  });
});
