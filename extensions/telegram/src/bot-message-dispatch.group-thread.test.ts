import { resolveGroupThreadMentionFacts } from "openclaw/plugin-sdk/channel-inbound";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import {
  dispatchReplyWithBufferedBlockDispatcher as dispatchRealReplyWithBufferedBlockDispatcher,
  finalizeInboundContext,
} from "openclaw/plugin-sdk/reply-runtime";
import { expect, it } from "vitest";
import {
  appendAssistantMirrorMessageByIdentity,
  createContext,
  describeTelegramDispatch,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectRecordFields,
  loadSessionStore,
  telegramDepsForTest,
  type TelegramBotDeps,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("Telegram group-thread delivery identity", () => {
  it.each(
    [
      { lane: "durable", agents: ["alice"] },
      { lane: "durable", agents: ["alice", "bob"] },
      { lane: "direct fallback", agents: ["alice"] },
      { lane: "direct fallback", agents: ["alice", "bob"] },
    ].flatMap(({ lane, agents }) =>
      ["raw", "prepared"].map((source) => ({ lane, agents, source })),
    ),
  )(
    "preserves participant ownership for $lane with $agents ($source)",
    async ({ lane, agents, source }) => {
      const cfg: NonNullable<Parameters<typeof dispatchWithContext>[0]["cfg"]> = {
        agents: {
          ownership: "explicit",
          entries: {
            root: { workspace: "/tmp/.openclaw/workspace-root" },
            alice: {
              workspace: "/tmp/.openclaw/workspace-alice",
              identity: { name: "Alice [reviewer]" },
            },
            bob: { workspace: "/tmp/.openclaw/workspace-bob", identity: { name: "Bob" } },
          },
        },
        session: { dmScope: "per-channel-peer" },
        broadcast: { "telegram:123": agents },
      };
      const rootSessionKey = "agent:root:telegram:direct:123";
      const text = "Review the attachment.";
      const base = createContext();
      const participantRuns: string[] = [];
      loadSessionStore.mockReturnValue(
        Object.fromEntries(
          agents.map((agentId) => [
            `agent:${agentId}:telegram:direct:123`,
            { sessionId: `session-${agentId}`, updatedAt: 1 },
          ]),
        ),
      );
      deliverReplies.mockImplementation(
        async (params: Parameters<NonNullable<TelegramBotDeps["deliverReplies"]>>[0]) => {
          await params.transcriptMirror?.({
            text: params.replies.map((reply) => reply.text ?? "").join("\n"),
          });
          return { delivered: true };
        },
      );
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        dispatchRealReplyWithBufferedBlockDispatcher,
      );
      deliverInboundReplyWithMessageSendContext.mockResolvedValue(
        lane === "durable"
          ? {
              status: "handled_visible",
              delivery: { messageIds: ["1001"], visibleReplySent: true },
            }
          : { status: "unsupported", reason: "missing_outbound_handler" },
      );

      await dispatchWithContext({
        cfg,
        context: createContext({
          route: {
            ...base.route,
            agentId: "root",
            sessionKey: rootSessionKey,
            mainSessionKey: "agent:root:main",
            dmScope: "per-channel-peer",
          },
          msg: { ...base.msg, message_thread_id: undefined },
          threadSpec: { scope: "dm" },
          replyThreadId: undefined,
          ctxPayload: finalizeInboundContext({
            ...base.ctxPayload,
            AgentId: "root",
            SessionKey: rootSessionKey,
            DmScope: "per-channel-peer" as const,
            ChatType: "direct" as const,
            Provider: "telegram",
            Surface: "telegram",
            OriginatingChannel: "telegram",
            OriginatingTo: "telegram:123",
            NativeChannelId: "123",
            AccountId: "default",
            From: "telegram:123",
            To: "telegram:123",
            SenderId: "123",
            MessageSid: "456",
            Body: text,
            BodyForAgent: text,
            BodyForCommands: text,
            CommandBody: text,
            RawBody: text,
            GroupThread: resolveGroupThreadMentionFacts({
              cfg,
              channel: "telegram",
              peerId: "123",
              text,
              sessionKey: rootSessionKey,
            }),
          }),
        }),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
        opts: {
          token: "test-token",
          dispatchReplyFromConfig: async ({ ctx, dispatcher, replyOptions }) => {
            const agentId = ctx.AgentId;
            if (!agentId) {
              throw new Error("Expected the participant's agent identity");
            }
            participantRuns.push(agentId);
            replyOptions?.onAgentRunStart?.(`run-${agentId}`);
            let queuedFinal = false;
            for (const sequence of [1, 2]) {
              const payload = {
                text: `${source === "prepared" ? "[[reply_to:999]] [[audio_as_voice]] " : ""}Attachment ${sequence} from ${agentId}`,
                mediaUrl: `/tmp/.openclaw/workspace-${agentId}/attachment.txt`,
              };
              const [plan] = createStructuredOutboundPayloadPlan([payload]);
              const accepted =
                source === "prepared" && plan
                  ? (dispatcher.sendPreparedReply?.("final", plan) ??
                    dispatcher.sendFinalReply(plan.payload))
                  : dispatcher.sendFinalReply(payload);
              queuedFinal ||= accepted;
            }
            return { queuedFinal, counts: dispatcher.getQueuedCounts() };
          },
        },
      });

      expect(participantRuns.toSorted()).toEqual(agents.toSorted());
      const deliveredPayloads =
        lane === "durable"
          ? deliverInboundReplyWithMessageSendContext.mock.calls.map(([params]) => params.payload)
          : deliverReplies.mock.calls.flatMap(([params]) => params.replies);
      for (const agentId of agents) {
        const label =
          agents.length === 1
            ? ""
            : agentId === "alice"
              ? "**Alice \\[reviewer\\]**\n"
              : "**Bob**\n";
        const literalTags = source === "prepared" ? "[[reply_to:999]] [[audio_as_voice]] " : "";
        for (const sequence of [1, 2]) {
          expect(deliveredPayloads).toContainEqual(
            expect.objectContaining({
              text: `${label}${literalTags}Attachment ${sequence} from ${agentId}`,
              mediaUrl: `/tmp/.openclaw/workspace-${agentId}/attachment.txt`,
            }),
          );
        }
      }
      for (const payload of deliveredPayloads) {
        expect(payload.replyToId).not.toBe("999");
        expect(payload.audioAsVoice).not.toBe(true);
      }
      if (lane === "durable") {
        expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(agents.length * 2);
        expect(deliverReplies).not.toHaveBeenCalled();
        for (const agentId of agents) {
          expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledWith(
            expect.objectContaining({
              agentId,
              ctxPayload: expect.objectContaining({
                AgentId: agentId,
                SessionKey: `agent:${agentId}:telegram:direct:123`,
              }),
              payload: expect.objectContaining({
                mediaUrl: `/tmp/.openclaw/workspace-${agentId}/attachment.txt`,
              }),
            }),
          );
        }
        return;
      }
      expect(deliverReplies).toHaveBeenCalledTimes(agents.length * 2);
      expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(agents.length * 2);
      for (const agentId of agents) {
        const mirrors = appendAssistantMirrorMessageByIdentity.mock.calls
          .map(([value]) => expectRecordFields(value, {}))
          .filter((value) => value.agentId === agentId);
        expect(mirrors).toHaveLength(2);
        for (const mirror of mirrors) {
          expect(mirror).toMatchObject({
            sessionKey: `agent:${agentId}:telegram:direct:123`,
            sessionId: `session-${agentId}`,
          });
        }
        expect(new Set(mirrors.map((value) => value.idempotencyKey)).size).toBe(2);
        expect(deliverReplies).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKeyForInternalHooks: `agent:${agentId}:telegram:direct:123`,
            mediaLocalRoots: expect.arrayContaining([`/tmp/.openclaw/workspace-${agentId}`]),
            replies: [
              expect.objectContaining({
                mediaUrl: `/tmp/.openclaw/workspace-${agentId}/attachment.txt`,
              }),
            ],
          }),
        );
      }
    },
  );
});
