import { resolveChannelStreamingPreviewToolProgress } from "openclaw/plugin-sdk/channel-outbound";
import { countOutboundMedia } from "openclaw/plugin-sdk/reply-payload";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedMattermostAccount } from "./accounts.js";
import type { MattermostEventPayload } from "./monitor-websocket.js";
import type { MattermostReplyDeliveryOutcome } from "./reply-delivery.js";
import type { ChatType, ReplyPayload } from "./runtime-api.js";

export function shouldUpdateMattermostDraftToolProgress(
  account: Pick<ResolvedMattermostAccount, "config" | "streamingMode">,
): boolean {
  return (
    account.streamingMode !== "off" &&
    resolveChannelStreamingPreviewToolProgress(
      account.config,
      account.streamingMode !== "progress",
      account.streamingMode,
    )
  );
}

export function buildMattermostModelPickerSelectMessageSid(params: {
  postId: string;
  provider: string;
  model: string;
}): string {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const model = normalizeLowercaseStringOrEmpty(params.model);
  return `interaction:${params.postId}:select:${provider}/${model}`;
}

export function buildMattermostButtonInteractionMessageSid(params: {
  postId: string;
  actionId: string;
}): string {
  return `interaction:${params.postId}:${params.actionId}`;
}

export function resolveMattermostReplyRootId(params: {
  kind: ChatType;
  threadRootId?: string;
  replyToId?: string;
}): string | undefined {
  const threadRootId = normalizeOptionalString(params.threadRootId);
  // Flat DMs (no thread context) get no reply root. A DM carries a threadRootId
  // only when its effective per-chat-type mode enables threading.
  if (params.kind === "direct" && !threadRootId) {
    return undefined;
  }
  if (threadRootId) {
    return threadRootId;
  }
  return normalizeOptionalString(params.replyToId);
}

export function resolveMattermostInteractionReplyRootId(params: {
  kind: ChatType;
  threadRootId?: string;
  replyToId?: string;
  interactionMessageSid: string;
  sourcePostId: string;
}): string | undefined {
  const interactionMessageSid = normalizeOptionalString(params.interactionMessageSid);
  const replyToId = normalizeOptionalString(params.replyToId);
  // Interaction MessageSid values identify synthetic inbound events, not provider posts.
  // Map only reply-to-current back to the source post or Mattermost rejects the root.
  const providerReplyToId =
    replyToId === interactionMessageSid ? normalizeOptionalString(params.sourcePostId) : replyToId;
  return resolveMattermostReplyRootId({
    kind: params.kind,
    threadRootId: params.threadRootId,
    replyToId: providerReplyToId,
  });
}

export function canFinalizeMattermostPreviewInPlace(params: {
  kind: ChatType;
  previewRootId?: string;
  threadRootId?: string;
  replyToId?: string;
}): boolean {
  return (
    resolveMattermostReplyRootId({
      kind: params.kind,
      threadRootId: params.threadRootId,
      replyToId: params.replyToId,
    }) === params.previewRootId?.trim()
  );
}

export function formatMattermostFinalDeliveryOutcomeLog(params: {
  outcome: MattermostReplyDeliveryOutcome;
  payload: ReplyPayload;
  to: string;
  accountId: string;
  agentId: string | undefined;
}): string | undefined {
  if (params.outcome === "text" || params.outcome === "media") {
    return `delivered reply to ${params.to}`;
  }
  if (params.outcome === "empty") {
    // Detect dropped substantive payloads even when the agent run succeeded (#80501).
    const finalText = typeof params.payload.text === "string" ? params.payload.text.trim() : "";
    const mediaUrlCount = countOutboundMedia(params.payload);
    if (finalText.length > 0 || mediaUrlCount > 0) {
      return (
        `mattermost no-visible-reply: no-visible-reply-after-final-delivery` +
        ` to=${params.to}` +
        ` accountId=${params.accountId}` +
        ` agentId=${params.agentId ?? "unknown"}` +
        ` outcome=${params.outcome}` +
        ` finalTextLength=${finalText.length}` +
        ` mediaUrlCount=${mediaUrlCount}`
      );
    }
  }
  return undefined;
}

export function resolveMattermostThreadSessionContext(params: {
  baseSessionKey: string;
  kind: ChatType;
  postId?: string | null;
  replyToMode: "off" | "first" | "all" | "batched";
  threadRootId?: string | null;
}): { effectiveReplyToId?: string; sessionKey: string; parentSessionKey?: string } {
  // Flat DMs never thread; rooms retain existing roots even when new replies are off.
  const effectiveReplyToId =
    params.kind === "direct" && params.replyToMode === "off"
      ? undefined
      : (normalizeOptionalString(params.threadRootId) ??
        (params.replyToMode !== "off" ? normalizeOptionalString(params.postId) : undefined));
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: params.baseSessionKey,
    threadId: effectiveReplyToId,
    normalizeThreadId: (threadId) => threadId,
    // DM threads start fresh; room threads inherit their base session.
    parentSessionKey:
      effectiveReplyToId && params.kind !== "direct" ? params.baseSessionKey : undefined,
  });
  return {
    effectiveReplyToId,
    sessionKey: threadKeys.sessionKey,
    parentSessionKey: threadKeys.parentSessionKey,
  };
}

export function resolveMattermostPendingHistoryKey(params: {
  kind: ChatType;
  sessionKey: string;
  threadRootId?: string;
}): string | null {
  // Flat DMs dispatch immediately. Opted-in threads have an independent session
  // and need a recoverable context window just like room threads.
  return params.kind === "direct" && !params.threadRootId ? null : params.sessionKey;
}

export function resolveMattermostReactionChannelId(
  payload: Pick<MattermostEventPayload, "broadcast" | "data">,
): string | undefined {
  return (
    normalizeOptionalString(payload.broadcast?.channel_id) ??
    normalizeOptionalString(payload.data?.channel_id)
  );
}
