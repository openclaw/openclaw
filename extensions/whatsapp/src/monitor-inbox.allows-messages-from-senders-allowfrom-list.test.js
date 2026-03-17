import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { monitorWebInbox } from "./inbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  expectPairingPromptSent,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  upsertPairingRequestMock
} from "./monitor-inbox.test-harness.js";
const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1e3);
const DEFAULT_MESSAGES_CFG = {
  messagePrefix: void 0,
  responsePrefix: void 0
};
function createAllowListConfig(allowFrom) {
  return {
    channels: {
      whatsapp: {
        allowFrom
      }
    },
    messages: DEFAULT_MESSAGES_CFG
  };
}
async function openInboxMonitor(onMessage = vi.fn()) {
  const listener = await monitorWebInbox({
    verbose: false,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
    onMessage
  });
  return { onMessage, listener, sock: getSock() };
}
async function expectOutboundDmSkipsPairing(params) {
  mockLoadConfig.mockReturnValue({
    channels: {
      whatsapp: {
        dmPolicy: "pairing",
        selfChatMode: params.selfChatMode
      }
    },
    messages: DEFAULT_MESSAGES_CFG
  });
  const onMessage = vi.fn();
  const listener = await monitorWebInbox({
    verbose: false,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
    onMessage
  });
  const sock = getSock();
  try {
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: {
            id: params.messageId,
            fromMe: true,
            remoteJid: "999@s.whatsapp.net"
          },
          message: { conversation: params.body },
          messageTimestamp: nowSeconds()
        }
      ]
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  } finally {
    mockLoadConfig.mockReturnValue({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: DEFAULT_MESSAGES_CFG
    });
    await listener.close();
  }
}
describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();
  it("allows messages from senders in allowFrom list", async () => {
    mockLoadConfig.mockReturnValue(createAllowListConfig(["+111", "+999"]));
    const { onMessage, listener, sock } = await openInboxMonitor();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "auth1", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "authorized message" },
          messageTimestamp: nowSeconds(6e4)
        }
      ]
    };
    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "authorized message",
        from: "+999",
        senderE164: "+999"
      })
    );
    await listener.close();
  });
  it("allows same-phone messages even if not in allowFrom", async () => {
    mockLoadConfig.mockReturnValue(createAllowListConfig(["+111"]));
    const { onMessage, listener, sock } = await openInboxMonitor();
    const upsert = {
      type: "notify",
      messages: [
        {
          key: { id: "self1", fromMe: false, remoteJid: "123@s.whatsapp.net" },
          message: { conversation: "self message" },
          messageTimestamp: nowSeconds(6e4)
        }
      ]
    };
    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: "self message", from: "+123" })
    );
    await listener.close();
  });
  it("locks down when no config is present (pairing for unknown senders)", async () => {
    mockLoadConfig.mockReturnValue({});
    upsertPairingRequestMock.mockResolvedValueOnce({ code: "PAIRCODE", created: true }).mockResolvedValueOnce({ code: "PAIRCODE", created: false });
    const { onMessage, listener, sock } = await openInboxMonitor();
    const upsertBlocked = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net"
          },
          message: { conversation: "ping" },
          messageTimestamp: nowSeconds()
        }
      ]
    };
    sock.ev.emit("messages.upsert", upsertBlocked);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
    expectPairingPromptSent(sock, "999@s.whatsapp.net", "+999");
    const upsertBlockedAgain = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-1b",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net"
          },
          message: { conversation: "ping again" },
          messageTimestamp: nowSeconds()
        }
      ]
    };
    sock.ev.emit("messages.upsert", upsertBlockedAgain);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    const upsertSelf = {
      type: "notify",
      messages: [
        {
          key: {
            id: "no-config-2",
            fromMe: false,
            remoteJid: "123@s.whatsapp.net"
          },
          message: { conversation: "self ping" },
          messageTimestamp: nowSeconds()
        }
      ]
    };
    sock.ev.emit("messages.upsert", upsertSelf);
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "self ping",
        from: "+123",
        to: "+123"
      })
    );
    await listener.close();
  });
  it("skips pairing replies for outbound DMs in same-phone mode", async () => {
    await expectOutboundDmSkipsPairing({
      selfChatMode: true,
      messageId: "fromme-1",
      body: "hello"
    });
  });
  it("skips pairing replies for outbound DMs when same-phone mode is disabled", async () => {
    await expectOutboundDmSkipsPairing({
      selfChatMode: false,
      messageId: "fromme-2",
      body: "hello again"
    });
  });
  it("handles append messages by marking them read but skipping auto-reply", async () => {
    const { onMessage, listener, sock } = await openInboxMonitor();
    const upsert = {
      type: "append",
      messages: [
        {
          key: {
            id: "history1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net"
          },
          message: { conversation: "old message" },
          messageTimestamp: nowSeconds(),
          pushName: "History Sender"
        }
      ]
    };
    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "999@s.whatsapp.net",
        id: "history1",
        participant: void 0,
        fromMe: false
      }
    ]);
    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
  });
  it("normalizes participant phone numbers to JIDs in sendReaction", async () => {
    const listener = await monitorWebInbox({
      verbose: false,
      onMessage: vi.fn(),
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir()
    });
    const sock = getSock();
    await listener.sendReaction("12345@g.us", "msg123", "\u{1F44D}", false, "+6421000000");
    expect(sock.sendMessage).toHaveBeenCalledWith("12345@g.us", {
      react: {
        text: "\u{1F44D}",
        key: {
          remoteJid: "12345@g.us",
          id: "msg123",
          fromMe: false,
          participant: "6421000000@s.whatsapp.net"
        }
      }
    });
    await listener.close();
  });
});
