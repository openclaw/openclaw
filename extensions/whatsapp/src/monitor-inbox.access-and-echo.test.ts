// WhatsApp monitor inbox access and echo behavior.
import { cleanMessage } from "baileys";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { whatsappInboundLog } from "./auto-reply/loggers.js";
import { isRecentOutboundMessage } from "./inbound/dedupe.js";
import {
  buildNotifyMessageUpsert,
  getRecordChannelActivityMock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  settleInboundWork,
  startInboxMonitor,
  upsertPairingRequestMock,
  waitForInboundWorkDrained,
  waitForMessageCalls,
  waitForPairingPromptSent,
} from "./monitor-inbox.test-harness.js";

const nowSeconds = (offsetMs = 0) => Math.floor((Date.now() + offsetMs) / 1000);

function createInboxConfig(whatsapp: NonNullable<OpenClawConfig["channels"]>["whatsapp"]) {
  return {
    channels: { whatsapp },
    messages: { messagePrefix: undefined, responsePrefix: undefined },
  };
}

function emitText(
  sock: Awaited<ReturnType<typeof startInboxMonitor>>["sock"],
  id: string,
  remoteJid: string,
  text: string,
  fromMe = false,
  participant?: string,
  pushName?: string,
) {
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id, remoteJid, fromMe, participant },
        message: { conversation: text },
        messageTimestamp: nowSeconds(),
        pushName,
      },
    ],
  });
}

function expectInbound(onMessage: ReturnType<typeof vi.fn>, shape: object) {
  expect(onMessage).toHaveBeenCalled();
  expect(onMessage.mock.calls[0]?.[0]).toMatchObject(shape);
}

async function openInboxMonitor(onMessage = vi.fn()) {
  const { listener, sock } = await startInboxMonitor(onMessage);
  return { onMessage, listener, sock };
}

function expectOnlyOutboundChannelActivity(accountId = "default") {
  const recordChannelActivityMock = getRecordChannelActivityMock();
  expect(recordChannelActivityMock).toHaveBeenCalledWith({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
  expect(recordChannelActivityMock).not.toHaveBeenCalledWith({
    channel: "whatsapp",
    accountId,
    direction: "inbound",
  });
}

async function expectOutboundDmSkipsPairing(params: {
  selfChatMode: boolean;
  messageId: string;
  body: string;
}) {
  mockLoadConfig.mockReturnValue(
    createInboxConfig({
      dmPolicy: "pairing",
      selfChatMode: params.selfChatMode,
    }),
  );

  const onMessage = vi.fn();
  const { listener, sock } = await startInboxMonitor(onMessage);

  try {
    emitText(sock, params.messageId, "999@s.whatsapp.net", params.body, true);
    await settleInboundWork();

    expect(onMessage).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
    expect(sock.sendMessage).not.toHaveBeenCalled();
  } finally {
    mockLoadConfig.mockReturnValue(createInboxConfig({ allowFrom: ["*"] }));
    await listener.close();
  }
}

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  it.each([
    { policy: { dmPolicy: "disabled" }, group: false, reason: "dm_policy_disabled" },
    {
      policy: { dmPolicy: "allowlist", allowFrom: ["+111"] },
      group: false,
      reason: "dm_policy_not_allowlisted",
    },
    { policy: { groupPolicy: "disabled" }, group: true, reason: "group_policy_disabled" },
    {
      policy: { groupPolicy: "allowlist", groupAllowFrom: [] },
      group: true,
      reason: "group_policy_empty_allowlist",
    },
    {
      policy: { groupPolicy: "allowlist", groupAllowFrom: ["+111"] },
      group: true,
      reason: "group_policy_not_allowlisted",
    },
  ] as const)(
    "records bounded default-level $reason diagnostics without message data",
    async (testCase) => {
      mockLoadConfig.mockReturnValue({ channels: { whatsapp: testCase.policy } });
      const log = vi.spyOn(whatsappInboundLog, "info");
      const { onMessage, listener, sock } = await openInboxMonitor();
      const now = vi.spyOn(Date, "now");
      const startedAt = Date.now();
      const text = "private message body";
      try {
        for (const [index, elapsed] of [0, 1_000, 60_000].entries()) {
          now.mockReturnValue(startedAt + elapsed);
          sock.ev.emit(
            "messages.upsert",
            buildNotifyMessageUpsert({
              id: `denied-${index}`,
              remoteJid: testCase.group ? "12345@g.us" : "999@s.whatsapp.net",
              participant: testCase.group ? "999@s.whatsapp.net" : undefined,
              text,
              pushName: "Private sender",
              timestamp: nowSeconds(),
            }),
          );
          await waitForInboundWorkDrained();
          expect(log).toHaveBeenCalledTimes(index === 2 ? 2 : 1);
        }
        expect(log.mock.calls).toEqual([
          [`Inbound message blocked (reason=${testCase.reason})`],
          [`Inbound message blocked (reason=${testCase.reason})`],
        ]);
        expect(onMessage).not.toHaveBeenCalled();
        expect(sock.sendMessage).not.toHaveBeenCalled();
        expect(sock.readMessages).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
        log.mockRestore();
        await listener.close();
      }
    },
  );

  it.each([
    {
      name: "allowlisted sender",
      allowFrom: ["+111", "+999"],
      jid: "999@s.whatsapp.net",
      sender: "+999",
      body: "authorized message",
    },
    {
      name: "same-phone sender outside allowFrom",
      allowFrom: ["+111"],
      jid: "123@s.whatsapp.net",
      sender: "+123",
      body: "self message",
    },
  ])("allows $name", async ({ allowFrom, jid, sender, body }) => {
    mockLoadConfig.mockReturnValue(createInboxConfig({ allowFrom }));
    const { onMessage, listener, sock } = await openInboxMonitor();
    sock.ev.emit(
      "messages.upsert",
      buildNotifyMessageUpsert({
        id: "authorized",
        remoteJid: jid,
        text: body,
        timestamp: nowSeconds(60_000),
      }),
    );
    await waitForInboundWorkDrained();
    expectInbound(onMessage, {
      admission: { conversation: { id: sender } },
      payload: { body },
      ...(sender === "+999" ? { platform: { senderE164: sender } } : {}),
    });
    await listener.close();
  });

  it("blocks allowlisted same-phone fromMe DMs when self-chat mode is disabled", async () => {
    mockLoadConfig.mockReturnValue(
      createInboxConfig({
        dmPolicy: "pairing",
        allowFrom: ["+123"],
        selfChatMode: false,
      }),
    );
    const { onMessage, listener, sock } = await openInboxMonitor();

    try {
      emitText(sock, "self-disabled", "123@s.whatsapp.net", "disabled self-chat", true);
      await settleInboundWork();

      expect(onMessage).not.toHaveBeenCalled();
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(sock.sendMessage).not.toHaveBeenCalled();
      expect(sock.readMessages).not.toHaveBeenCalled();
    } finally {
      await listener.close();
    }
  });

  it("locks down when no config is present (pairing for unknown senders)", async () => {
    mockLoadConfig.mockReturnValue({});
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    const { onMessage, listener, sock } = await openInboxMonitor();

    const upsertBlocked = buildNotifyMessageUpsert({
      id: "no-config-1",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: nowSeconds(),
    });

    sock.ev.emit("messages.upsert", upsertBlocked);
    await waitForPairingPromptSent(sock, "999@s.whatsapp.net", "+999");
    expect(onMessage).not.toHaveBeenCalled();

    const upsertBlockedAgain = buildNotifyMessageUpsert({
      id: "no-config-1b",
      remoteJid: "999@s.whatsapp.net",
      text: "ping again",
      timestamp: nowSeconds(),
    });

    sock.ev.emit("messages.upsert", upsertBlockedAgain);
    await settleInboundWork();
    expect(onMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalledTimes(1);

    const upsertSelf = buildNotifyMessageUpsert({
      id: "no-config-2",
      remoteJid: "123@s.whatsapp.net",
      text: "self ping",
      timestamp: nowSeconds(),
    });

    sock.ev.emit("messages.upsert", upsertSelf);
    await waitForMessageCalls(onMessage, 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expectInbound(onMessage, {
      admission: {
        conversation: {
          id: "+123",
        },
      },
      payload: {
        body: "self ping",
      },
      platform: {
        recipientJid: "+123",
      },
    });

    await listener.close();
  });

  it("still sends pairing replies when live DMs have null timestamps", async () => {
    mockLoadConfig.mockReturnValue({});
    upsertPairingRequestMock.mockResolvedValueOnce({ code: "PAIRCODE", created: true });

    const { onMessage, listener, sock } = await openInboxMonitor();

    const upsertBlocked = buildNotifyMessageUpsert({
      id: "no-config-null-ts",
      remoteJid: "999@s.whatsapp.net",
      text: "ping",
      timestamp: null as never,
    });

    sock.ev.emit("messages.upsert", upsertBlocked);
    await waitForPairingPromptSent(sock, "999@s.whatsapp.net", "+999");

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });

  it.each([true, false])("skips outbound DM pairing with selfChatMode=%s", async (selfChatMode) => {
    await expectOutboundDmSkipsPairing({ selfChatMode, messageId: "fromme", body: "hello" });
  });

  it("allows owner fromMe group commands when they were not sent by the gateway", async () => {
    mockLoadConfig.mockReturnValue(
      createInboxConfig({
        groupPolicy: "open",
        allowFrom: ["+123"],
        selfChatMode: false,
      }),
    );

    const { onMessage, listener, sock } = await openInboxMonitor();

    sock.sendMessage.mockResolvedValueOnce({ key: { id: "out-1" } });
    await listener.sendMessage("120363@g.us", "/status");

    emitText(sock, "in-2", "120363@g.us", "/status", true, "123@s.whatsapp.net", "Owner");
    await waitForMessageCalls(onMessage, 1);

    expectInbound(onMessage, {
      admission: {
        conversation: {
          kind: "group",
          id: "120363@g.us",
        },
      },
      payload: {
        body: "/status",
      },
      platform: {
        fromMe: true,
        senderE164: "+123",
      },
    });

    await listener.close();
  });

  it.each([
    { name: "remote inbound", fromMe: false, selfChatMode: false },
    { name: "linked-device self-chat", fromMe: true, selfChatMode: true },
  ])("admits a distinct-ID $name collision after an accepted outbound send", async (testCase) => {
    mockLoadConfig.mockReturnValue(
      createInboxConfig({
        allowFrom: ["+123", "+999"],
        selfChatMode: testCase.selfChatMode,
      }),
    );
    const onMessage = vi.fn();
    const { listener, sock } = await startInboxMonitor(onMessage);
    const remoteJid = testCase.fromMe ? "123@s.whatsapp.net" : "999@s.whatsapp.net";

    sock.sendMessage.mockResolvedValueOnce({ key: { id: "out-1" } });
    await listener.sendMessage(remoteJid, "Done.");
    emitText(sock, "in-2", remoteJid, "Done.", testCase.fromMe);
    await waitForMessageCalls(onMessage, 1);

    expectInbound(onMessage, {
      event: { id: "in-2" },
      payload: { body: "Done." },
    });
    await listener.close();
  });

  it.each([
    {
      name: "group",
      remoteJid: "120363@g.us",
      participant: "123@s.whatsapp.net",
      whatsapp: { groupPolicy: "open" as const, allowFrom: ["+123"] },
    },
    {
      name: "self-chat DM",
      remoteJid: "123@s.whatsapp.net",
      participant: undefined,
      whatsapp: { selfChatMode: true, allowFrom: ["+123"] },
    },
  ])(
    "filters $name fromMe echoes only for gateway-sent message IDs",
    async ({ remoteJid, participant, whatsapp }) => {
      mockLoadConfig.mockReturnValue(createInboxConfig(whatsapp));
      const { onMessage, listener, sock } = await openInboxMonitor();
      sock.sendMessage.mockResolvedValueOnce({ key: { id: "bot-echo-1" } });
      await listener.sendMessage(remoteJid, "gateway echo");
      emitText(sock, "bot-echo-1", remoteJid, "gateway echo", true, participant, "Owner");
      await settleInboundWork();
      expect(onMessage).not.toHaveBeenCalled();
      expectOnlyOutboundChannelActivity();
      await listener.close();
    },
  );

  it.each([
    {
      name: "device-qualified phone JIDs",
      outboundJid: "123:7@s.whatsapp.net",
      echoedJid: "123@s.whatsapp.net",
    },
    {
      name: "legacy c.us phone JIDs",
      outboundJid: "123@c.us",
      echoedJid: "123@s.whatsapp.net",
    },
    {
      name: "hosted phone JIDs",
      outboundJid: "123:7@hosted",
      echoedJid: "123:7@hosted",
    },
    {
      name: "hosted LID JIDs",
      outboundJid: "777:2@hosted.lid",
      echoedJid: "777:2@hosted.lid",
    },
    {
      name: "phone aliases carried alongside direct LID echoes",
      outboundJid: "123@s.whatsapp.net",
      echoedJid: "777@lid",
      echoedAlternateJid: "123:8@s.whatsapp.net",
    },
    {
      name: "LID aliases carried alongside direct phone echoes",
      outboundJid: "777@lid",
      echoedJid: "123@s.whatsapp.net",
      echoedAlternateJid: "777:3@lid",
    },
  ])(
    "filters provider-normalized outbound self echoes for $name",
    async ({ outboundJid, echoedJid, echoedAlternateJid }) => {
      mockLoadConfig.mockReturnValue(
        createInboxConfig({
          selfChatMode: true,
          allowFrom: ["+123"],
        }),
      );

      const onMessage = vi.fn();
      const { listener, sock } = await startInboxMonitor(onMessage);
      sock.signalRepository.lidMapping.getPNForLID.mockImplementation(async (jid: string) =>
        jid.startsWith("777@") ? "123@s.whatsapp.net" : null,
      );
      const messageId = `bot-provider-echo-${outboundJid}`;
      sock.sendMessage.mockResolvedValueOnce({ key: { id: messageId } });
      await listener.sendMessage(outboundJid, "gateway self echo");

      const echoedMessage = {
        key: {
          id: messageId,
          fromMe: true,
          remoteJid: echoedJid,
          ...(echoedAlternateJid ? { remoteJidAlt: echoedAlternateJid } : {}),
        },
        message: { conversation: "gateway self echo" },
        messageTimestamp: nowSeconds(),
      };
      cleanMessage(echoedMessage, "123@s.whatsapp.net", "777@lid");

      sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [echoedMessage],
      });
      await settleInboundWork();

      expect(onMessage).not.toHaveBeenCalled();
      expectOnlyOutboundChannelActivity();
      await listener.close();
    },
  );

  it("keeps provider-normalized echo matches scoped to their account and message", async () => {
    mockLoadConfig.mockReturnValue(
      createInboxConfig({
        selfChatMode: true,
        allowFrom: ["+123"],
      }),
    );

    const { listener, sock } = await startInboxMonitor(vi.fn());
    sock.sendMessage.mockResolvedValueOnce({ key: { id: "scoped-hosted-echo" } });
    await listener.sendMessage("123:7@hosted", "gateway self echo");

    expect(
      isRecentOutboundMessage({
        accountId: "other-account",
        remoteJid: "123@s.whatsapp.net",
        messageId: "scoped-hosted-echo",
      }),
    ).toBe(false);
    expect(
      isRecentOutboundMessage({
        accountId: "default",
        remoteJid: "123@s.whatsapp.net",
        messageId: "other-message",
      }),
    ).toBe(false);

    await listener.close();
  });

  it("never treats another group as an alternate direct-chat echo", async () => {
    const { listener, sock } = await startInboxMonitor(vi.fn());
    sock.sendMessage.mockResolvedValueOnce({ key: { id: "group-alias-control" } });
    await listener.sendMessage("12345@g.us", "gateway group message");

    expect(
      isRecentOutboundMessage({
        accountId: "default",
        remoteJid: "67890@g.us",
        alternateRemoteJid: "12345@g.us",
        messageId: "group-alias-control",
      }),
    ).toBe(false);

    await listener.close();
  });

  it("handles append messages by marking them read but skipping auto-reply", async () => {
    const { onMessage, listener, sock } = await openInboxMonitor();
    const staleTs = Math.floor(Date.now() / 1000) - 300;

    const upsert = {
      type: "append",
      messages: [
        {
          key: {
            id: "history1",
            fromMe: false,
            remoteJid: "999@s.whatsapp.net",
          },
          message: { conversation: "old message" },
          messageTimestamp: staleTs,
          pushName: "History Sender",
        },
      ],
    };

    sock.ev.emit("messages.upsert", upsert);
    await vi.waitFor(
      () => {
        expect(sock.readMessages).toHaveBeenCalledWith([
          {
            remoteJid: "999@s.whatsapp.net",
            id: "history1",
            participant: undefined,
            fromMe: false,
          },
        ]);
      },
      { timeout: 5_000, interval: 5 },
    );

    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
  });
});
