// WhatsApp monitor inbox policy behavior.
import { describe, expect, it, vi } from "vitest";
import type { WebInboundMessage } from "./inbound/types.js";
import {
  buildNotifyMessageUpsert,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  startInboxMonitor,
  waitForInboundWorkDrained,
  waitForMessageCalls,
  waitForPairingPromptSent,
} from "./monitor-inbox.test-harness.js";

const DEFAULT_MESSAGES_CFG = { messagePrefix: undefined, responsePrefix: undefined } as const;
const TIMESTAMP_OFF_MESSAGES_CFG = { ...DEFAULT_MESSAGES_CFG, timestampPrefix: false } as const;

function emitMessage(
  sock: Awaited<ReturnType<typeof startInboxMonitor>>["sock"],
  params: { id: string; remoteJid?: string; participant?: string; conversation: string },
) {
  sock.ev.emit(
    "messages.upsert",
    buildNotifyMessageUpsert({
      ...params,
      remoteJid: params.remoteJid ?? "11111@g.us",
      text: params.conversation,
      timestamp: Math.floor(Date.now() / 1000),
    }),
  );
}

async function startWebInboxMonitor(params: {
  config?: Record<string, unknown>;
  loadConfig?: () => Record<string, unknown>;
  sendReadReceipts?: boolean;
}) {
  if (params.config) {
    mockLoadConfig.mockReturnValue(params.config);
  }
  const onMessage = vi.fn();
  const { listener, sock } = await startInboxMonitor(onMessage, {
    cfg: (params.config ?? mockLoadConfig()) as never,
    ...(params.loadConfig ? { loadConfig: params.loadConfig as never } : {}),
    ...(params.sendReadReceipts === undefined ? {} : { sendReadReceipts: params.sendReadReceipts }),
  });
  return { onMessage, listener, sock };
}

function firstInboundPayload(onMessage: ReturnType<typeof vi.fn>) {
  const payload = onMessage.mock.calls[0]?.[0];
  if (!payload || typeof payload !== "object") {
    throw new Error("expected first inbound payload");
  }
  return payload as WebInboundMessage;
}

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it("delivery coordinator blocks unauthorized senders outside allowFrom", async () => {
    const config = {
      channels: { whatsapp: { allowFrom: ["+111"] } },
      messages: DEFAULT_MESSAGES_CFG,
    };

    const { onMessage, listener, sock } = await startWebInboxMonitor({ config });

    // Message from unauthorized sender +999 (not in allowFrom)
    emitMessage(sock, {
      id: "unauth1",
      remoteJid: "999@s.whatsapp.net",
      conversation: "unauthorized message",
    });
    await waitForPairingPromptSent(sock, "999@s.whatsapp.net", "+999");

    // Should NOT call onMessage for unauthorized senders
    expect(onMessage).not.toHaveBeenCalled();
    // Should NOT send read receipts for blocked senders (privacy + avoids Baileys Bad MAC churn).
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("delivery coordinator applies hot-reloaded dmPolicy to the active listener", async () => {
    const startupConfig = {
      channels: { whatsapp: { dmPolicy: "open", allowFrom: ["*"] } },
      messages: DEFAULT_MESSAGES_CFG,
    };
    const reloadedConfig = {
      channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+111"] } },
      messages: DEFAULT_MESSAGES_CFG,
    };
    mockLoadConfig.mockReturnValue(startupConfig);

    const { onMessage, listener, sock } = await startWebInboxMonitor({
      config: startupConfig,
      loadConfig: () => mockLoadConfig() as Record<string, unknown>,
    });
    mockLoadConfig.mockReturnValue(reloadedConfig);

    emitMessage(sock, {
      id: "hot-reload-block",
      remoteJid: "999@s.whatsapp.net",
      conversation: "should be blocked after reload",
    });
    await waitForInboundWorkDrained();

    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("delivery coordinator skips read receipts in self-chat mode", async () => {
    const config = {
      channels: { whatsapp: { allowFrom: ["+123"] } },
      messages: DEFAULT_MESSAGES_CFG,
    };

    const { onMessage, listener, sock } = await startWebInboxMonitor({ config });

    emitMessage(sock, { id: "self1", remoteJid: "123@s.whatsapp.net", conversation: "self ping" });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(firstInboundPayload(onMessage)).toMatchObject({
      admission: { conversation: { id: "+123" }, ingress: { decision: "allow" } },
      payload: { body: "self ping" },
      platform: { recipientJid: "+123" },
    });
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it("delivery coordinator skips read receipts when disabled", async () => {
    const { onMessage, listener, sock } = await startWebInboxMonitor({ sendReadReceipts: false });
    emitMessage(sock, {
      id: "rr-off-1",
      remoteJid: "222@s.whatsapp.net",
      conversation: "read receipts off",
    });
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(sock.readMessages).not.toHaveBeenCalled();

    await listener.close();
  });

  it.each([
    {
      name: "open groups ignore DM allowFrom",
      groupPolicy: "open",
      allowFrom: ["+1234"],
      expectedCalls: 1,
      expectedSender: "+999",
    },
    {
      name: "disabled groups block all senders",
      groupPolicy: "disabled",
      allowFrom: ["+1234"],
      expectedCalls: 0,
    },
    {
      name: "group allowlist blocks unknown senders",
      groupAllowFrom: ["+1234"],
      expectedCalls: 0,
    },
    {
      name: "group allowlist admits listed senders",
      groupAllowFrom: ["+15551234567"],
      participant: "15551234567@s.whatsapp.net",
      expectedCalls: 1,
      expectedSender: "+15551234567",
    },
    {
      name: "group allowlist wildcard admits all",
      groupAllowFrom: ["*"],
      participant: "9999999999@s.whatsapp.net",
      remoteJid: "22222@g.us",
      expectedCalls: 1,
    },
    { name: "empty group allowlist blocks all", expectedCalls: 0 },
  ])(
    "$name",
    async ({
      name,
      groupPolicy = "allowlist",
      allowFrom,
      groupAllowFrom,
      participant = "999@s.whatsapp.net",
      remoteJid,
      expectedCalls,
      expectedSender,
    }) => {
      const { onMessage, listener, sock } = await startWebInboxMonitor({
        config: {
          channels: {
            whatsapp: {
              groupPolicy,
              ...(allowFrom ? { allowFrom } : {}),
              ...(groupAllowFrom ? { groupAllowFrom } : {}),
            },
          },
          messages: groupPolicy === "open" ? DEFAULT_MESSAGES_CFG : TIMESTAMP_OFF_MESSAGES_CFG,
        },
      });
      emitMessage(sock, { id: name, remoteJid, participant, conversation: name });
      await waitForInboundWorkDrained();
      expect(onMessage).toHaveBeenCalledTimes(expectedCalls);
      if (expectedCalls === 1) {
        const payload = firstInboundPayload(onMessage);
        expect(payload.admission?.conversation.kind).toBe("group");
        if (expectedSender) {
          expect(payload.platform.senderE164).toBe(expectedSender);
        }
      }
      await listener.close();
    },
  );
});
