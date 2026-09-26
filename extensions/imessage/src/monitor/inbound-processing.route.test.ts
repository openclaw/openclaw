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
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  createReplyDispatcher,
  dispatchInboundMessage,
  resetInboundDedupe,
} from "openclaw/plugin-sdk/reply-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import * as imessageRuntime from "../runtime.js";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

describe("buildIMessageInboundContext direct reply route", () => {
  it.each([
    { chatId: undefined, bound: false, dispatchState: "context-only" },
    { chatId: 42, bound: false, dispatchState: "context-only" },
    { chatId: 42, bound: true, dispatchState: "context-only" },
    { chatId: 42, bound: true, dispatchState: "permitted" },
    { chatId: 42, bound: true, dispatchState: "revoked" },
    { chatId: 42, bound: true, dispatchState: "reassigned" },
    { chatId: 42, bound: true, dispatchState: "unavailable" },
  ] as const)(
    "retains admission and binding ownership (chat ID $chatId, bound $bound, dispatch $dispatchState)",
    async ({ chatId, bound, dispatchState }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const shouldDispatch = dispatchState !== "context-only";
        const cfg: OpenClawConfig = {
          session: { store: state.path("sessions.json") },
          commands: { ownerAllowFrom: ["imessage:+15555550123"] },
          ...(bound
            ? {
                agents: {
                  list: [{ id: "first" }, { id: "second" }],
                  defaults: { workspace: state.workspaceDir },
                },
              }
            : {}),
          plugins: { enabled: false },
        };
        if (shouldDispatch) {
          await state.writeConfig(cfg);
          resetInboundDedupe();
        }
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
        // Exercise core reply dispatch without introducing an external ACP harness.
        const targetSessionKey = shouldDispatch
          ? "agent:second:imessage:direct:+15555550123"
          : "agent:second:acp:bound";
        const binding: SessionBindingRecord = {
          bindingId: "imessage-inbound-route",
          targetSessionKey,
          targetKind: "session",
          conversation: {
            channel: "imessage",
            accountId: "default",
            conversationId: "+15555550123",
          },
          status: "active",
          boundAt: 1,
        };
        let currentBinding: SessionBindingRecord | null = binding;
        let pauseInspection = false;
        const inspectionEntered = Promise.withResolvers<void>();
        const releaseInspection = Promise.withResolvers<void>();
        let pendingDispatch: ReturnType<typeof dispatchInboundMessage> | undefined;
        const bindingAdapter: SessionBindingAdapter = {
          channel: "imessage",
          accountId: "default",
          listBySession: (sessionKey) =>
            currentBinding?.targetSessionKey === sessionKey ? [currentBinding] : [],
          resolveByConversation: () => currentBinding,
          inspectByConversationAsync: async () => {
            const observed = currentBinding;
            if (pauseInspection) {
              inspectionEntered.resolve();
              await releaseInspection.promise;
            }
            return observed;
          },
          touchAsync: async () => {},
        };
        try {
          if (bound) {
            registerSessionBindingAdapter(bindingAdapter);
          }
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
          if (bound) {
            expect(decision.route.agentId).toBe("second");
            expect(decision.route.sessionKey).toBe(targetSessionKey);
            expect(decision.bindingResolution).toBeNull();
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
          if (bound) {
            expect(ctxPayload.AgentId).toBe("second");
            expect(ctxPayload.SessionKey).toBe(targetSessionKey);
          }
          expect(ctxPayload.MessageSid).toMatch(/^\d+$/u);
          expect(ctxPayload.MessageSid).not.toBe(String(message.id));
          expect(
            bindings.at(-1)?.messageId,
            "final ingress must use the allocated message ID",
          ).toBe(ctxPayload.MessageSid);
          if (shouldDispatch) {
            // Leave the single-use host carrier intact for real dispatch admission.
            expect(readChannelContextAdmissionEvidence(ctxPayload)).toBeDefined();
          } else {
            expect(
              consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(ctxPayload)),
            ).toMatchObject({
              ingressState: "present",
              invoker: { state: "present", kind: "person" },
            });
          }
          const authorization = resolveCommandAuthorization({
            ctx: ctxPayload,
            cfg: {},
            commandAuthorized: true,
          });
          expect(authorization.senderIsOwner).toBe(false);
          expect(authorization.assertOwnerCurrent).toBeUndefined();
          if (shouldDispatch) {
            if (dispatchState === "revoked") {
              currentBinding = null;
            } else if (dispatchState === "reassigned") {
              currentBinding = {
                ...binding,
                bindingId: "imessage-inbound-reassigned",
                boundAt: 2,
                targetSessionKey: "agent:first:imessage:direct:+15555550123",
              };
            } else if (dispatchState === "unavailable") {
              pauseInspection = true;
            }
            const replyResolver = vi
              .fn<NonNullable<Parameters<typeof dispatchInboundMessage>[0]["replyResolver"]>>()
              .mockResolvedValue({ text: "bound reply" });
            const deliver = vi
              .fn<Parameters<typeof createReplyDispatcher>[0]["deliver"]>()
              .mockResolvedValue(undefined);
            const dispatcher = createReplyDispatcher({ deliver });
            pendingDispatch = dispatchInboundMessage({
              ctx: ctxPayload,
              cfg,
              dispatcher,
              replyResolver,
            });
            const outcome = pendingDispatch.then(
              () => ({ status: "fulfilled" as const }),
              (error: unknown) => ({ status: "rejected" as const, error }),
            );
            if (dispatchState === "unavailable") {
              expect(
                await Promise.race([
                  inspectionEntered.promise.then(() => "inspection"),
                  outcome.then(() => "settled"),
                ]),
                "dispatch must enter the awaited owner inspection before retirement",
              ).toBe("inspection");
              expect(replyResolver).not.toHaveBeenCalled();
              expect(deliver).not.toHaveBeenCalled();
              unregisterSessionBindingAdapter({
                channel: "imessage",
                accountId: "default",
                adapter: bindingAdapter,
              });
              releaseInspection.resolve();
            }
            if (dispatchState === "permitted") {
              expect(await outcome).toEqual({ status: "fulfilled" });
              expect(replyResolver).toHaveBeenCalledOnce();
              expect(replyResolver.mock.calls[0]?.[0]).toMatchObject({
                AgentId: "second",
                SessionKey: targetSessionKey,
                MessageSid: ctxPayload.MessageSid,
              });
              expect(deliver).toHaveBeenCalledOnce();
              expect(deliver).toHaveBeenCalledWith(
                expect.objectContaining({ text: "bound reply" }),
                expect.objectContaining({ kind: "final" }),
              );
            } else {
              expect(await outcome).toMatchObject({
                status: "rejected",
                error: { code: "SESSION_WORK_START_CHANGED" },
              });
              expect(replyResolver).not.toHaveBeenCalled();
              expect(deliver).not.toHaveBeenCalled();
            }
          }
        } finally {
          releaseInspection.resolve();
          await pendingDispatch?.catch(() => {});
          if (bound) {
            unregisterSessionBindingAdapter({
              channel: "imessage",
              accountId: "default",
              adapter: bindingAdapter,
            });
          }
          live = false;
          runtimeSpy.mockRestore();
          if (shouldDispatch) {
            resetInboundDedupe();
          }
        }
      });
    },
  );
});
