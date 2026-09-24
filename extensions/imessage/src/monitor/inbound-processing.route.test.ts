import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  consumeChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  createHostChannelInboundEventContextBuilder,
  createHostChannelIngressRuntime,
  readChannelContextAdmissionEvidence,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import * as imessageRuntime from "../runtime.js";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

describe("buildIMessageInboundContext direct reply route", () => {
  it.each([undefined, 42])(
    "retains host admission after reply ID mapping (chat ID %s)",
    async (chatId) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg: OpenClawConfig = {
          session: { store: state.path("sessions.json") },
          commands: { ownerAllowFrom: ["imessage:+15555550123"] },
        };
        type GatewayContext = NonNullable<
          ReturnType<
            NonNullable<
              Parameters<typeof createHostChannelIngressRuntime>[0]["resolveGatewayContext"]
            >
          >
        >;
        // SAFETY: Host ingress only reads config and admission audit from this synthetic Gateway.
        const gateway = {
          getRuntimeConfig: () => cfg,
          channelAdmissionAudit: createChannelAdmissionAudit({ enabled: true }),
        } as GatewayContext;
        let live = true;
        const owner = {
          channelId: "imessage",
          isLive: () => live,
          resolveGatewayContext: () => gateway,
        };
        const runtime = createPluginRuntimeMock();
        const hostIngress = createHostChannelIngressRuntime(owner);
        const bindings: Array<ChannelIngressContextBinding | undefined> = [];
        runtime.channel.inbound.ingress = {
          ...hostIngress,
          createResolver: (base) => {
            const resolver = hostIngress.createResolver(base);
            return {
              ...resolver,
              message: (input) => {
                bindings.push(input.contextBinding);
                return resolver.message(input);
              },
            };
          },
        };
        const runtimeSpy = vi.spyOn(imessageRuntime, "getIMessageRuntime").mockReturnValue(runtime);
        try {
          const message = {
            id: 12349,
            guid: "p:0/GUID-current-guid-only",
            sender: "+15555550123",
            text: "current",
            is_from_me: false,
            is_group: false,
            chat_guid: "iMessage;-;+15555550123",
            chat_id: chatId,
          };
          const decision = await resolveIMessageInboundDecision({
            cfg,
            accountId: "default",
            opts: undefined,
            allowFrom: ["*"],
            groupAllowFrom: [],
            groupPolicy: "open",
            dmPolicy: "open",
            storeAllowFrom: [],
            historyLimit: 0,
            groupHistories: new Map(),
            echoCache: undefined,
            selfChatCache: undefined,
            isKnownFromMeMessageId: () => false,
            logVerbose: undefined,
            message,
            messageText: message.text,
            bodyText: message.text,
          });
          expect(decision.kind).toBe("dispatch");
          if (decision.kind !== "dispatch") {
            return;
          }

          const buildContext = createHostChannelInboundEventContextBuilder(
            buildChannelInboundEventContext,
            owner,
          );
          const { ctxPayload, imessageTo } = await buildIMessageInboundContext({
            cfg,
            accountService: undefined,
            decision,
            message,
            historyLimit: 0,
            groupHistories: new Map(),
            buildContext: async (input) => buildContext(input),
          });

          expect(ctxPayload.To).toBe(
            chatId == null ? "chat_guid:iMessage;-;+15555550123" : "chat_id:42",
          );
          expect(imessageTo).toBe("imessage:+15555550123");
          expect(ctxPayload.MessageSid).toMatch(/^\d+$/u);
          expect(ctxPayload.MessageSid).not.toBe(String(message.id));
          expect(
            bindings.at(-1)?.messageId,
            "final ingress must use the allocated message ID",
          ).toBe(ctxPayload.MessageSid);
          expect(
            consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(ctxPayload)),
          ).toMatchObject({
            ingressState: "present",
            invoker: { state: "present", kind: "person" },
          });
          const authorization = resolveCommandAuthorization({
            ctx: ctxPayload,
            cfg: {},
            commandAuthorized: true,
          });
          expect(authorization.senderIsOwner).toBe(false);
          expect(authorization.assertOwnerCurrent).toBeUndefined();
        } finally {
          live = false;
          runtimeSpy.mockRestore();
        }
      });
    },
  );
});
