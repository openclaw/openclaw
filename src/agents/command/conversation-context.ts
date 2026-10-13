import {
  buildGroupIntro,
  buildSourceConversationContext,
  defaultGroupActivation,
  resolveGroupRequireMention,
} from "../../auto-reply/reply/groups.js";
import { buildInboundMetaSystemPrompt } from "../../auto-reply/reply/inbound-meta.js";
import { prepareReplyConversation } from "../../auto-reply/reply/prompt-session-context.js";
import { resolveSessionStableReplyMode } from "../../auto-reply/reply/session-stable-reply-mode.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildDeliveryFormatPrompt } from "../../infra/outbound/delivery-format-prompt.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { isSyntheticSourceReplyTurn } from "../reply-completion.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

/** Reuse conversation guidance without borrowing the originating sender's authority. */
export async function prepareCommandConversationContext(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  runContext: AgentRunContext;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  sessionAgentId: string;
}) {
  const { cfg, opts, runContext, sessionEntry, sessionKey, sessionAgentId } = params;
  const deliveryFormat =
    (opts.deliver === true || opts.sourceReplyDeliveryMode === "message_tool_only") &&
    buildDeliveryFormatPrompt({
      cfg,
      channel: opts.replyChannel ?? runContext.messageChannel,
      accountId: opts.replyAccountId ?? runContext.accountId,
      agentId: sessionAgentId,
      allowBootstrap: true,
    });
  let conversationPrompt: string | undefined;
  if (
    sessionEntry &&
    !isSubagentSessionKey(sessionKey) &&
    !isCronSessionKey(sessionKey) &&
    isSyntheticSourceReplyTurn(opts)
  ) {
    const conversation = prepareReplyConversation({
      sessionEntry,
      ctx: {
        InternalTurnSource: "event",
        Provider: runContext.messageChannel,
        Surface: runContext.messageChannel,
        ChatType: sessionEntry.delivery?.kind === "internal" ? sessionEntry.chatType : undefined,
        OriginatingChannel: runContext.messageChannel,
        OriginatingTo: runContext.currentChannelId,
        AccountId: runContext.accountId,
        MessageThreadId: runContext.currentThreadTs,
      },
    });
    const ctx = { ...conversation.fields, CommandAuthorized: false };
    const shared = ctx.ChatType === "group" || ctx.ChatType === "channel";
    const sourceContext = buildSourceConversationContext({
      sessionCtx: ctx,
      sourceReplyDeliveryMode: await resolveSessionStableReplyMode({
        cfg,
        ctx,
        sessionEntry,
        sessionAgentId,
        sessionKey,
      }),
      silentReplyPolicy: resolveSilentReplySettings({
        cfg,
        sessionKey,
        surface: ctx.Surface ?? ctx.Provider,
        conversationType: shared ? "group" : "direct",
      }).policy,
      silentToken: SILENT_REPLY_TOKEN,
    });
    if (sourceContext) {
      // Metadata describes the conversation; delivery preflight owns formatting.
      const metadata = buildInboundMetaSystemPrompt(ctx, cfg, { includeFormattingHints: false });
      conversationPrompt = [
        deliveryFormat ? `${metadata}\n${deliveryFormat}` : metadata,
        sourceContext,
        shared &&
          buildGroupIntro({
            activation: conversation.activation,
            defaultActivation: defaultGroupActivation(
              await resolveGroupRequireMention({ cfg, group: conversation.group }),
            ),
          }),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  }
  return conversationPrompt || deliveryFormat
    ? {
        ...opts,
        extraSystemPrompt: [
          conversationPrompt,
          opts.extraSystemPrompt,
          !conversationPrompt && deliveryFormat,
        ]
          .filter(Boolean)
          .join("\n\n"),
        ...(conversationPrompt ? { silentReplyPromptMode: "none" as const } : {}),
      }
    : opts;
}
