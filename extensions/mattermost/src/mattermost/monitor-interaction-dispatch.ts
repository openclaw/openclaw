import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { resolveMattermostInteractionReplyRootId } from "./monitor-context.js";
import type { MattermostEventPlan } from "./monitor-event-plan.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import { sendMessageMattermost } from "./send.js";

export async function dispatchMattermostInteractionReply(
  monitor: MattermostMonitorContext,
  eventPlan: MattermostEventPlan,
  params: {
    ctxPayload: ReturnType<MattermostEventPlan["finalizeContext"]>;
    interactionMessageSid: string;
    sourcePostId: string;
    kind: "button-click" | "model picker";
  },
) {
  const { account, cfg, core, runtime } = monitor;
  const { channelId, kind, route, thread, to } = eventPlan;
  const { replyOptions, replyPipeline, tableMode, textLimit } = eventPlan.createReplyPlan();
  const isModelPicker = params.kind === "model picker";
  await core.channel.inbound.dispatch({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: thread.sessionKey },
    ctxPayload: params.ctxPayload,
    delivery: {
      observeMessageSent: true,
      deliver: async (payload) => {
        // Picker confirmations preserve their immediate, pre-trimmed text path.
        const reply = isModelPicker
          ? {
              ...payload,
              text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode).trim(),
            }
          : payload;
        const result = await deliverMattermostReplyPayload({
          core,
          cfg,
          payload: reply,
          channelId,
          accountId: account.accountId,
          agentId: route.agentId,
          replyToId: resolveMattermostInteractionReplyRootId({
            kind,
            threadRootId: thread.effectiveReplyToId,
            replyToId: reply.replyToId,
            interactionMessageSid: params.interactionMessageSid,
            sourcePostId: params.sourcePostId,
          }),
          textLimit,
          tableMode: isModelPicker ? "off" : tableMode,
          sendMessage: sendMessageMattermost,
        });
        if (!isModelPicker && result.visibleReplySent) {
          runtime.log?.(`delivered button-click reply to ${to}`);
        }
        return result;
      },
      onError: (err, info) => {
        runtime.error?.(`mattermost ${params.kind} ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyPipeline,
    ...(!isModelPicker
      ? { dispatcherOptions: { humanDelay: resolveHumanDelayConfig(cfg, route.agentId) } }
      : {}),
    replyOptions,
  });
}
