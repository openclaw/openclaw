import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { ActiveWebListener } from "../../inbound/types.js";
import { setWhatsAppRuntime } from "../../runtime.js";
import {
  boundarySelf as self,
  boundaryPeer,
  boundaryAccount as accountId,
  createReplyBoundary,
  registerReplyBoundary,
  type ReplyResolver,
} from "./reply-boundary.test-helper.js";

describe("WhatsApp inbound and outbound response-prefix boundary", () => {
  beforeAll(() => {
    setWhatsAppRuntime(createPluginRuntimeMock());
  });

  it.each([
    {
      name: "account prefix with quote",
      messageId: "inbound-prefix-account",
      selfChat: false,
      channelPrefix: "[CHANNEL]",
      accountPrefix: "[ACCOUNT]",
      inboundForbidden: "[CHANNEL]",
      outboundPrefix: "[ACCOUNT]",
      quoted: true,
      identity: { name: "Harbor" },
    },
    {
      name: "unset prefix with self-chat identity",
      messageId: "inbound-prefix-self-identity",
      selfChat: true,
      channelPrefix: undefined,
      accountPrefix: undefined,
      inboundForbidden: "[Harbor]",
      outboundPrefix: "[Harbor]",
      quoted: false,
      identity: { name: "Harbor" },
    },
    {
      name: "unset prefix with self-chat and no identity",
      messageId: "inbound-prefix-self-plain",
      selfChat: true,
      channelPrefix: undefined,
      accountPrefix: undefined,
      inboundForbidden: "[Harbor]",
      outboundPrefix: undefined,
      quoted: false,
      identity: undefined,
    },
  ])("$name", async (scenario) => {
    await withTempHome(
      async (root) => {
        const peer = scenario.selfChat ? self : boundaryPeer;
        const body = "please answer this message";
        const replyText = "the requested reply";
        const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>(async () =>
          createAcceptedWhatsAppSendResult("text", "outbound-prefix-proof"),
        );
        const listener: ActiveWebListener = {
          sendMessage,
          sendComposingTo: async () => {},
          sendPoll: async () => {
            throw new Error("Unexpected poll delivery");
          },
          sendReaction: async () => {
            throw new Error("Unexpected reaction delivery");
          },
        };
        const replyResolver = vi.fn<ReplyResolver>(async () => ({ text: replyText }));
        const boundary = await createReplyBoundary(root, peer, {
          channel: { responsePrefix: scenario.channelPrefix },
          account: { responsePrefix: scenario.accountPrefix, selfChatMode: scenario.selfChat },
          agents: { entries: { main: { identity: scenario.identity } } },
        });
        const { route, backgroundTasks } = boundary;
        const msg = createTestWebInboundMessage({
          event: { id: scenario.messageId, timestamp: 1_700_000_000_000 },
          payload: { body, commandBody: body },
          platform: {
            chatJid: `${peer.slice(1)}@s.whatsapp.net`,
            recipientJid: self,
            senderE164: peer,
            senderJid: `${peer.slice(1)}@s.whatsapp.net`,
            senderName: "Peer",
            selfE164: self,
            selfJid: `${self.slice(1)}@s.whatsapp.net`,
            fromMe: scenario.selfChat,
            reply: async () => {
              throw new Error("Expected durable outbound delivery, not platform.reply");
            },
          },
          admission: {
            accountId,
            isSelfChat: scenario.selfChat,
            conversation: { kind: "direct", id: peer },
            sender: { id: peer, isSamePhone: scenario.selfChat },
          },
          quote: scenario.quoted
            ? {
                id: "quoted-prefix-proof",
                body: "the original quoted message",
                sender: { displayName: "Peer", e164: peer },
              }
            : undefined,
        });
        const registration = registerReplyBoundary(listener);
        try {
          expect(registration.registration).not.toBeNull();
          const sent = await boundary.process(msg, replyResolver);
          await Promise.all(backgroundTasks);

          expect(sent).toBe(true);
          expect(replyResolver).toHaveBeenCalledOnce();
          expect(sendMessage).toHaveBeenCalledOnce();
          const call = sendMessage.mock.calls[0]!;
          expect({ to: call[0], text: call[1], options: call[4] }).toMatchObject({
            to: peer,
            text: scenario.outboundPrefix ? `${scenario.outboundPrefix} ${replyText}` : replyText,
            options: { accountId },
          });
          const context = replyResolver.mock.calls[0]?.[0];
          expect(context).toMatchObject({
            RawBody: body,
            CommandBody: body,
            AccountId: accountId,
            SessionKey: route.sessionKey,
            OriginatingChannel: "whatsapp",
            OriginatingTo: peer,
          });
          if (scenario.quoted) {
            expect(context).toMatchObject({
              ReplyToId: "quoted-prefix-proof",
              ReplyToBody: "the original quoted message",
            });
            expect(context?.Body).toContain("[Replying to");
            expect(context?.Body).toContain("the original quoted message");
          }
          expect(context?.Body).toContain(body);
          expect(context?.Body).not.toContain(scenario.inboundForbidden);
          expect(context?.Body).not.toContain("[ACCOUNT]");
        } finally {
          await Promise.allSettled(backgroundTasks);
          registration.dispose();
        }
      },
      {
        prefix: "whatsapp-prefix-boundary-",
        env: { OPENCLAW_CONFIG_PATH: (root) => path.join(root, ".openclaw", "openclaw.json") },
      },
    );
  });
});
