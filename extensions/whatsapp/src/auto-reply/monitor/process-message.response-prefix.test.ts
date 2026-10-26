import path from "node:path";
import { escapeRegExp, formatEnvelopeTimestamp } from "openclaw/plugin-sdk/channel-test-helpers";
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

const withBoundaryHome = (run: (root: string) => Promise<void>) =>
  withTempHome(run, {
    prefix: "whatsapp-prefix-boundary-",
    env: { OPENCLAW_CONFIG_PATH: (root) => path.join(root, ".openclaw", "openclaw.json") },
  });

describe("WhatsApp inbound and outbound response-prefix boundary", () => {
  beforeAll(() => {
    setWhatsAppRuntime(createPluginRuntimeMock());
  });

  it.each(["group sender", "quote", "unknown quote sender", "timestamps"])(
    "formats the inbound envelope at the reply boundary (%s)",
    async (scenario) => {
      await withBoundaryHome(async (root) => {
        const kind = scenario === "group sender" ? "group" : "direct";
        const peer = kind === "group" ? "123@g.us" : boundaryPeer;
        const boundary = await createReplyBoundary(root, peer, {
          kind,
          account: { allowFrom: [boundaryPeer], groupPolicy: "open", contextVisibility: "all" },
          agents: { defaults: { workspace: path.join(root, "workspace"), userTimezone: "UTC" } },
        });
        const replyResolver = vi.fn<ReplyResolver>(async () => undefined);
        const unexpectedDelivery = async () => {
          throw new Error("Unexpected delivery for a silent reply resolver");
        };
        const registration = registerReplyBoundary({
          sendMessage: unexpectedDelivery,
          sendComposingTo: async () => {},
          sendPoll: unexpectedDelivery,
          sendReaction: unexpectedDelivery,
        });
        const bodies =
          scenario === "timestamps"
            ? ["first", "second"]
            : [scenario === "quote" ? "hello" : "ping"];
        try {
          expect(registration.registration).not.toBeNull();
          for (const [index, body] of bodies.entries()) {
            const timestamp = 1735689600000 + index * 3_600_000;
            const msg = createTestWebInboundMessage({
              event: { id: `envelope-${scenario}-${index}`, timestamp },
              payload: { body },
              platform: {
                chatJid: peer,
                recipientJid: self,
                senderName: "Bob",
                senderE164: "+15550001111",
                senderJid: "111@s.whatsapp.net",
              },
              admission: { accountId, conversation: { kind, id: peer } },
              quote:
                scenario === "quote"
                  ? { id: "q1", body: "original", sender: { displayName: "+1999" } }
                  : scenario === "unknown quote sender"
                    ? { body: "original" }
                    : undefined,
            });
            expect(await boundary.process(msg, replyResolver)).toBe(false);
            await Promise.all(boundary.backgroundTasks);
            const envelope = replyResolver.mock.calls[index]?.[0].Body;
            if (scenario === "group sender") {
              expect(envelope).toContain("Bob (+15550001111):");
              expect(envelope).toContain("ping");
            } else if (scenario === "quote") {
              expect(envelope).toContain("[Replying to +1999 id:q1]\noriginal\n[/Replying]");
            } else if (scenario === "unknown quote sender") {
              expect(envelope).toContain("[Replying to unknown sender]\noriginal\n[/Replying]");
            } else {
              const expectedTimestamp = formatEnvelopeTimestamp(new Date(timestamp), "utc");
              expect(envelope).toMatch(
                new RegExp(
                  `\\[WhatsApp ${escapeRegExp(peer)} (\\+\\d+[smhd] )?${escapeRegExp(expectedTimestamp)}\\] ${escapeRegExp(peer)}: ${body}`,
                ),
              );
              expect(envelope).not.toContain(index === 0 ? "second" : "first");
            }
          }
          expect(replyResolver).toHaveBeenCalledTimes(bodies.length);
        } finally {
          await Promise.allSettled(boundary.backgroundTasks);
          registration.dispose();
        }
      });
    },
  );

  it.each([
    ["account prefix with quote", false, true, "[CHANNEL]", "[ACCOUNT]"],
    ["unset prefix with self-chat identity", true, true, undefined, "[Harbor]"],
    ["unset prefix with self-chat and no identity", true, false, undefined, undefined],
  ] as const)("%s", async (name, selfChat, hasIdentity, channelPrefix, outboundPrefix) => {
    await withBoundaryHome(async (root) => {
      const peer = selfChat ? self : boundaryPeer;
      const body = "please answer this message";
      const replyText = "the requested reply";
      const sendMessage = vi.fn<ActiveWebListener["sendMessage"]>(async () =>
        createAcceptedWhatsAppSendResult("text", "outbound-prefix-proof"),
      );
      const unexpectedDelivery = async () => {
        throw new Error("Unexpected non-text delivery");
      };
      const listener: ActiveWebListener = {
        sendMessage,
        sendComposingTo: async () => {},
        sendPoll: unexpectedDelivery,
        sendReaction: unexpectedDelivery,
      };
      const replyResolver = vi.fn<ReplyResolver>(async () => ({ text: replyText }));
      const boundary = await createReplyBoundary(root, peer, {
        channel: { responsePrefix: channelPrefix },
        account: { responsePrefix: selfChat ? undefined : outboundPrefix, selfChatMode: selfChat },
        agents: { entries: { main: { identity: hasIdentity ? { name: "Harbor" } : undefined } } },
      });
      const { route, backgroundTasks } = boundary;
      const msg = createTestWebInboundMessage({
        event: { id: name, timestamp: 1_700_000_000_000 },
        payload: { body, commandBody: body },
        platform: {
          chatJid: `${peer.slice(1)}@s.whatsapp.net`,
          recipientJid: self,
          senderE164: peer,
          senderJid: `${peer.slice(1)}@s.whatsapp.net`,
          senderName: "Peer",
          selfE164: self,
          selfJid: `${self.slice(1)}@s.whatsapp.net`,
          fromMe: selfChat,
          reply: async () => {
            throw new Error("Expected durable outbound delivery, not platform.reply");
          },
        },
        admission: {
          accountId,
          isSelfChat: selfChat,
          conversation: { kind: "direct", id: peer },
          sender: { id: peer, isSamePhone: selfChat },
        },
        quote: !selfChat
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
          text: outboundPrefix ? `${outboundPrefix} ${replyText}` : replyText,
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
        if (!selfChat) {
          expect(context).toMatchObject({
            ReplyToId: "quoted-prefix-proof",
            ReplyToBody: "the original quoted message",
          });
          expect(context?.Body).toContain("[Replying to");
          expect(context?.Body).toContain("the original quoted message");
        }
        expect(context?.Body).toContain(body);
        expect(context?.Body).not.toContain(channelPrefix ?? "[Harbor]");
        expect(context?.Body).not.toContain("[ACCOUNT]");
      } finally {
        await Promise.allSettled(backgroundTasks);
        registration.dispose();
      }
    });
  });
});
