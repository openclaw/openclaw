import fs from "node:fs/promises";
import path from "node:path";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "../../channel.js";
import {
  getWhatsAppConnectionController,
  WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
} from "../../connection-controller-runtime-context.js";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { ActiveWebListener } from "../../inbound/types.js";
import { getWhatsAppChannelRuntime, setWhatsAppRuntime } from "../../runtime.js";
import { processMessage } from "./process-message.js";

type ReplyResolver = Parameters<typeof processMessage>[0]["replyResolver"];

describe("WhatsApp inbound and outbound response-prefix boundary", () => {
  beforeAll(() => {
    setWhatsAppRuntime(createPluginRuntimeMock());
  });

  it.each([
    {
      name: "account prefix with quote",
      selfChat: false,
      channelPrefix: "[CHANNEL]",
      accountPrefix: "[ACCOUNT]",
      inboundForbidden: "[CHANNEL]",
      outboundPrefix: "[ACCOUNT]",
      quoted: true,
    },
    {
      name: "unset prefix with self-chat identity",
      selfChat: true,
      channelPrefix: undefined,
      accountPrefix: undefined,
      inboundForbidden: "[Harbor]",
      outboundPrefix: "[Harbor]",
      quoted: false,
    },
  ])("$name", async (scenario) => {
    await withTempHome(
      async (root) => {
        const backgroundTasks = new Set<Promise<unknown>>();
        const self = "+12025550100";
        const peer = scenario.selfChat ? self : "+12025550101";
        const accountId = "work";
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
        const controller: NonNullable<ReturnType<typeof getWhatsAppConnectionController>> = {
          getActiveListener: () => listener,
          getCurrentSock: () => null,
          getSelfIdentity: () => ({ e164: self, jid: `${self.slice(1)}@s.whatsapp.net` }),
        };
        const replyResolver = vi.fn<ReplyResolver>(async () => ({ text: replyText }));
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: path.join(root, "workspace"),
              envelopeTimestamp: "off",
              envelopeElapsed: "off",
            },
            entries: { main: { identity: { name: "Harbor" } } },
          },
          session: { dmScope: "per-channel-peer" },
          channels: {
            whatsapp: {
              responsePrefix: scenario.channelPrefix,
              accounts: {
                work: {
                  authDir: path.join(root, "auth"),
                  allowFrom: [peer],
                  responsePrefix: scenario.accountPrefix,
                  selfChatMode: scenario.selfChat,
                },
              },
            },
          },
        };
        await fs.writeFile(path.join(root, ".openclaw", "openclaw.json"), JSON.stringify(cfg));
        const msg = createTestWebInboundMessage({
          event: { id: "inbound-prefix-proof", timestamp: 1_700_000_000_000 },
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
        const route = resolveAgentRoute({
          cfg,
          channel: "whatsapp",
          accountId,
          peer: { kind: "direct", id: peer },
        });
        const priorRegistry = getActivePluginRegistry();
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "whatsapp", source: "test", plugin: whatsappPlugin }]),
        );
        const registration = registerChannelRuntimeContext({
          channelRuntime: getWhatsAppChannelRuntime(),
          channelId: "whatsapp",
          accountId,
          capability: WHATSAPP_CONNECTION_CONTROLLER_CAPABILITY,
          context: controller,
        });
        try {
          expect(registration).not.toBeNull();
          const sent = await processMessage({
            cfg,
            msg,
            route,
            groupHistoryKey: `whatsapp:${accountId}:direct:${peer}`,
            groupHistories: new Map(),
            groupMemberNames: new Map(),
            connectionId: "response-prefix-proof",
            verbose: false,
            maxMediaBytes: 1_000_000,
            replyResolver,
            replyLogger: getChildLogger({ module: "whatsapp-prefix-boundary" }),
            backgroundTasks,
            ackAlreadySent: true,
          });
          await Promise.all(backgroundTasks);

          expect(sent).toBe(true);
          expect(replyResolver).toHaveBeenCalledOnce();
          expect(sendMessage).toHaveBeenCalledOnce();
          expect(sendMessage.mock.calls[0]?.[0]).toBe(peer);
          expect(sendMessage.mock.calls[0]?.[1]).toBe(`${scenario.outboundPrefix} ${replyText}`);
          expect(sendMessage.mock.calls[0]?.[4]).toMatchObject({ accountId });
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
          registration?.dispose();
          if (priorRegistry) {
            setActivePluginRegistry(priorRegistry);
          } else {
            resetPluginRuntimeStateForTest();
          }
        }
      },
      {
        prefix: "whatsapp-prefix-boundary-",
        env: { OPENCLAW_CONFIG_PATH: (root) => path.join(root, ".openclaw", "openclaw.json") },
      },
    );
  });
});
