import "./monitor-inbox.test-harness.js";
import { describe, expect, it, vi } from "vitest";
import { monitorWebInbox } from "./inbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  expectPairingPromptSent,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig
} from "./monitor-inbox.test-harness.js";
const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1e3);
const DEFAULT_MESSAGES_CFG = {
  messagePrefix: void 0,
  responsePrefix: void 0
};
const TIMESTAMP_OFF_MESSAGES_CFG = {
  ...DEFAULT_MESSAGES_CFG,
  timestampPrefix: false
};
async function flushInboundQueue() {
  await new Promise((resolve) => setImmediate(resolve));
}
const createNotifyUpsert = (message) => ({
  type: "notify",
  messages: [message]
});
const createDmMessage = (params) => ({
  key: {
    id: params.id,
    fromMe: false,
    remoteJid: params.remoteJid
  },
  message: { conversation: params.conversation },
  messageTimestamp: nowSeconds()
});
const createGroupMessage = (params) => ({
  key: {
    id: params.id,
    fromMe: false,
    remoteJid: params.remoteJid ?? "11111@g.us",
    participant: params.participant
  },
  message: { conversation: params.conversation },
  messageTimestamp: nowSeconds()
});
async function startWebInboxMonitor(params) {
  if (params.config) {
    mockLoadConfig.mockReturnValue(params.config);
  }
  const onMessage = vi.fn();
  const base = {
    verbose: false,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
    onMessage
  };
  const listener = await monitorWebInbox(
    params.sendReadReceipts === void 0 ? base : {
      ...base,
      sendReadReceipts: params.sendReadReceipts
    }
  );
  return { onMessage, listener, sock: getSock() };
}
describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();
  it("blocks messages from unauthorized senders not in allowFrom", async () => {
    const config = {
      channels: {
        whatsapp: {
          // Only allow +111
          allowFrom: ["+111"]
        }
      },
      messages: DEFAULT_MESSAGES_CFG
    };
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createDmMessage({
          id: "unauth1",
          remoteJid: "999@s.whatsapp.net",
          conversation: "unauthorized message"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.readMessages).not.toHaveBeenCalled();
    expectPairingPromptSent(sock, "999@s.whatsapp.net", "+999");
    await listener.close();
  });
  it("skips read receipts in self-chat mode", async () => {
    const config = {
      channels: {
        whatsapp: {
          // Self-chat heuristic: allowFrom includes selfE164 (+123).
          allowFrom: ["+123"]
        }
      },
      messages: DEFAULT_MESSAGES_CFG
    };
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createDmMessage({
          id: "self1",
          remoteJid: "123@s.whatsapp.net",
          conversation: "self ping"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ from: "+123", to: "+123", body: "self ping" })
    );
    expect(sock.readMessages).not.toHaveBeenCalled();
    await listener.close();
  });
  it("skips read receipts when disabled", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      sendReadReceipts: false
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createDmMessage({
          id: "rr-off-1",
          remoteJid: "222@s.whatsapp.net",
          conversation: "read receipts off"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(sock.readMessages).not.toHaveBeenCalled();
    await listener.close();
  });
  it("lets group messages through even when sender not in allowFrom", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: {
        channels: { whatsapp: { allowFrom: ["+1234"], groupPolicy: "open" } },
        messages: DEFAULT_MESSAGES_CFG
      }
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createGroupMessage({
          id: "grp3",
          participant: "999@s.whatsapp.net",
          conversation: "unauthorized group message"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");
    expect(payload.senderE164).toBe("+999");
    await listener.close();
  });
  it("blocks all group messages when groupPolicy is 'disabled'", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: {
        channels: { whatsapp: { allowFrom: ["+1234"], groupPolicy: "disabled" } },
        messages: TIMESTAMP_OFF_MESSAGES_CFG
      }
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createGroupMessage({
          id: "grp-disabled",
          participant: "999@s.whatsapp.net",
          conversation: "group message should be blocked"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
  });
  it("blocks group messages from senders not in groupAllowFrom when groupPolicy is 'allowlist'", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: {
        channels: {
          whatsapp: {
            groupAllowFrom: ["+1234"],
            // Does not include +999
            groupPolicy: "allowlist"
          }
        },
        messages: TIMESTAMP_OFF_MESSAGES_CFG
      }
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createGroupMessage({
          id: "grp-allowlist-blocked",
          participant: "999@s.whatsapp.net",
          conversation: "unauthorized group sender"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
  });
  it("allows group messages from senders in groupAllowFrom when groupPolicy is 'allowlist'", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: {
        channels: {
          whatsapp: {
            groupAllowFrom: ["+15551234567"],
            // Includes the sender
            groupPolicy: "allowlist"
          }
        },
        messages: TIMESTAMP_OFF_MESSAGES_CFG
      }
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createGroupMessage({
          id: "grp-allowlist-allowed",
          participant: "15551234567@s.whatsapp.net",
          conversation: "authorized group sender"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");
    expect(payload.senderE164).toBe("+15551234567");
    await listener.close();
  });
  it("allows all group senders with wildcard in groupPolicy allowlist", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: {
        channels: {
          whatsapp: {
            groupAllowFrom: ["*"],
            // Wildcard allows everyone
            groupPolicy: "allowlist"
          }
        },
        messages: TIMESTAMP_OFF_MESSAGES_CFG
      }
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createGroupMessage({
          id: "grp-wildcard-test",
          remoteJid: "22222@g.us",
          participant: "9999999999@s.whatsapp.net",
          conversation: "wildcard group sender"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).toHaveBeenCalledTimes(1);
    const payload = onMessage.mock.calls[0][0];
    expect(payload.chatType).toBe("group");
    await listener.close();
  });
  it("blocks group messages when groupPolicy allowlist has no groupAllowFrom", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: {
        channels: {
          whatsapp: {
            groupPolicy: "allowlist"
          }
        },
        messages: TIMESTAMP_OFF_MESSAGES_CFG
      }
    });
    sock.ev.emit(
      "messages.upsert",
      createNotifyUpsert(
        createGroupMessage({
          id: "grp-allowlist-empty",
          participant: "999@s.whatsapp.net",
          conversation: "blocked by empty allowlist"
        })
      )
    );
    await flushInboundQueue();
    expect(onMessage).not.toHaveBeenCalled();
    await listener.close();
  });
});
