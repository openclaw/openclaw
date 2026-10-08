/** Extracts message delivery evidence from embedded-agent tool calls and results. */
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDeliveredCurrentSourceReply } from "../infra/outbound/source-reply-mirror.js";
import { normalizeTargetForProvider } from "../infra/outbound/target-normalization.js";
import {
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
} from "../interactive/payload.js";
import { isMessagingToolTargetEvidenceAction } from "./embedded-agent-messaging.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "./embedded-agent-messaging.types.js";
import { readToolResultDetails } from "./tool-result-error.js";

export function extractMessagingToolSourceReplyPayload(
  result: unknown,
): MessagingToolSourceReplyPayload | undefined {
  const details = readToolResultDetails(result);
  if (!details || details.sourceReplySink !== "internal-ui") {
    return undefined;
  }
  const status = normalizeOptionalLowercaseString(details.deliveryStatus);
  if (status && status !== "sent") {
    return undefined;
  }
  return readSourceReplyPayload(details, readRecord(details.sourceReply) ?? details);
}

/**
 * Reads the final reply a `canDeliverSourceReply` tool authored in `details.sourceReply`.
 * Unlike internal-ui mirrors, nothing has been sent yet: the host delivers the payload
 * to the current source and records it in the transcript after delivery. A reply needs
 * text or media; `final: false` is not a deliverable reply, so the model continues as
 * usual. Callers must already have verified the tool's capability and invocation scope.
 */
export function extractToolAuthoredSourceReplyPayload(
  result: unknown,
): MessagingToolSourceReplyPayload | undefined {
  const details = readToolResultDetails(result);
  const sourceReply = details ? readRecord(details.sourceReply) : undefined;
  if (!details || !sourceReply || sourceReply.final === false) {
    return undefined;
  }
  const payload = readSourceReplyPayload(details, sourceReply);
  if (!payload) {
    return undefined;
  }
  // Same admission as source-reply delivery: blank text and blank media entries are
  // dropped there, and attachments ride along but do not qualify a reply on their own.
  const hasDeliverableContent =
    Boolean(payload.text?.trim()) || resolveSourceReplyMediaUrls(payload).length > 0;
  return hasDeliverableContent ? payload : undefined;
}

/**
 * The media a source reply delivers: `mediaUrls` when present, else `mediaUrl`,
 * without blank entries. Delivery and tool-authored admission share it.
 */
export function resolveSourceReplyMediaUrls(
  payload: Pick<MessagingToolSourceReplyPayload, "mediaUrl" | "mediaUrls">,
): string[] {
  const media = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  return media.filter((value) => value.trim().length > 0);
}

function readSourceReplyPayload(
  details: Record<string, unknown>,
  sourceReply: Record<string, unknown>,
): MessagingToolSourceReplyPayload | undefined {
  const payload: MessagingToolSourceReplyPayload = {};
  const copyText = (key: "text" | "mediaUrl" | "idempotencyKey", fallback: string = key) => {
    const value = readStringValue(sourceReply[key]) ?? readStringValue(details[fallback]);
    if (value) {
      payload[key] = value;
    }
  };
  copyText("text", "message");
  copyText("mediaUrl");
  const rawMediaUrls = Array.isArray(sourceReply.mediaUrls)
    ? sourceReply.mediaUrls
    : Array.isArray(details.mediaUrls)
      ? details.mediaUrls
      : [];
  const mediaUrls = rawMediaUrls.filter((value): value is string => typeof value === "string");
  if (mediaUrls.length > 0) {
    payload.mediaUrls = mediaUrls;
  }
  if (Array.isArray(sourceReply.attachments)) {
    const attachments = sourceReply.attachments.flatMap((value) => {
      const attachment = readRecord(value);
      if (!attachment) {
        return [];
      }
      const projected: ReplyMediaAttachment = {};
      for (const key of ["path", "url", "mediaUrl", "filePath", "mimeType", "name"] as const) {
        const fieldText = readStringValue(attachment[key]);
        if (fieldText) {
          projected[key] = fieldText;
        }
      }
      if (typeof attachment.trustedLocalMedia === "boolean") {
        projected.trustedLocalMedia = attachment.trustedLocalMedia;
      }
      for (const key of ["durationMs", "width", "height"] as const) {
        const number = asNonNegativeFiniteNumber(attachment[key]);
        if (number !== undefined) {
          projected[key] = number;
        }
      }
      return [projected];
    });
    if (attachments.length > 0) {
      payload.attachments = attachments;
    }
  }
  if (typeof sourceReply.trustedLocalMedia === "boolean") {
    payload.trustedLocalMedia = sourceReply.trustedLocalMedia;
  }
  if (sourceReply.audioAsVoice === true || details.audioAsVoice === true) {
    payload.audioAsVoice = true;
  }
  const presentation = normalizeMessagePresentation(sourceReply.presentation);
  if (presentation) {
    payload.presentation = presentation;
  }
  const interactive = normalizeLegacyInteractiveReply(sourceReply.interactive);
  if (interactive) {
    payload.interactive = interactive;
  }
  const channelData = readRecord(sourceReply.channelData);
  if (channelData) {
    payload.channelData = { ...channelData };
  }
  copyText("idempotencyKey");
  if (details.sourceReplyTranscriptOwner === true) {
    payload.transcriptOwner = true;
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function resolveMessagingToolThreadEvidence(params: {
  providerId: string;
  to: string;
  accountId?: string;
  threadId?: string;
  replyToId?: string;
  allowImplicitThread: boolean;
  threadSuppressed: boolean;
  options?: Parameters<typeof extractMessagingToolSend>[2];
}): Pick<MessagingToolSend, "threadId" | "threadImplicit" | "threadSuppressed"> {
  const threading = getChannelPlugin(params.providerId)?.threading;
  const autoThreadResolver = params.allowImplicitThread
    ? threading?.resolveAutoThreadId
    : undefined;
  const replyTransport = params.replyToId
    ? threading?.resolveReplyTransport?.({
        cfg: params.options?.config ?? {},
        accountId: params.accountId,
        threadId: params.threadId,
        replyToId: params.replyToId,
      })
    : undefined;
  const transportThreadId = normalizeOptionalStringifiedId(replyTransport?.threadId);
  const replyToThreadId =
    replyTransport?.threadId === null
      ? normalizeOptionalString(replyTransport.replyToId)
      : undefined;
  const explicitThreadId = transportThreadId ?? replyToThreadId ?? params.threadId;
  const currentChannelId = normalizeOptionalString(params.options?.currentChannelId);
  const currentMessagingTarget = normalizeOptionalString(params.options?.currentMessagingTarget);
  const currentThreadId = normalizeOptionalString(params.options?.currentThreadId);
  const replyToMode = params.options?.replyToMode ?? (currentThreadId ? "all" : undefined);
  const canResolveCurrentThread = Boolean(
    (currentChannelId || currentMessagingTarget) && currentThreadId,
  );
  const resolvedCurrentThreadId =
    !explicitThreadId && !params.threadSuppressed && autoThreadResolver && canResolveCurrentThread
      ? autoThreadResolver({
          cfg: params.options?.config ?? {},
          accountId: params.accountId,
          to: params.to,
          replyToId: params.replyToId,
          toolContext: {
            currentChannelId,
            currentMessagingTarget,
            currentThreadTs: currentThreadId,
            currentMessageId: params.options?.currentMessageId,
            replyToMode,
            hasRepliedRef: params.options?.hasRepliedRef,
          },
        })
      : undefined;
  const threadImplicit =
    !explicitThreadId &&
    !params.threadSuppressed &&
    Boolean(autoThreadResolver) &&
    (!canResolveCurrentThread || Boolean(resolvedCurrentThreadId));
  return {
    ...((explicitThreadId ?? resolvedCurrentThreadId)
      ? { threadId: explicitThreadId ?? resolvedCurrentThreadId }
      : {}),
    ...(threadImplicit ? { threadImplicit: true } : {}),
    ...(params.threadSuppressed ? { threadSuppressed: true } : {}),
  };
}

export function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
  options?: {
    config?: OpenClawConfig;
    currentChannelId?: string;
    currentMessagingTarget?: string;
    currentThreadId?: string;
    currentMessageId?: string | number;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: { value: boolean };
  },
): MessagingToolSend | undefined {
  // Provider docking: new provider tools must implement plugin.actions.extractToolSend.
  const action = normalizeOptionalString(args.action) ?? "";
  const accountId = normalizeOptionalString(args.accountId);
  if (toolName === "conversations_send" || toolName === "conversations_turn") {
    const conversationRef = normalizeOptionalString(args.conversationRef);
    return conversationRef
      ? {
          tool: toolName,
          provider: "conversation",
          to: conversationRef,
        }
      : undefined;
  }
  let providerId: string | null;
  let provider: string;
  let to: string | undefined;
  let resolvedAccountId: string | undefined;
  let threadId: string | undefined;
  let outboundReplyToId: string | undefined;
  let threadSuppressed: boolean;
  let allowImplicitThread: boolean;
  if (toolName === "message") {
    if (!isMessagingToolTargetEvidenceAction(toolName, args)) {
      return undefined;
    }
    const providerRaw = normalizeOptionalString(args.provider) ?? "";
    const channelRaw = normalizeOptionalString(args.channel) ?? "";
    const providerHint = providerRaw || channelRaw;
    providerId = providerHint ? normalizeChannelId(providerHint) : null;
    const currentChannelId = options?.currentChannelId;
    const currentMessagingTarget = options?.currentMessagingTarget;
    let toRaw =
      normalizeOptionalString(args.target) ??
      normalizeOptionalString(args.to) ??
      normalizeOptionalString(args.channelId);
    if (!toRaw) {
      const aliases = providerId
        ? getChannelPlugin(providerId)?.actions?.messageActionTargetAliases?.[
            action as ChannelMessageActionName
          ]?.deliveryTargetAliases
        : undefined;
      for (const alias of aliases ?? []) {
        toRaw = normalizeOptionalStringifiedId(args[alias]);
        if (toRaw) {
          break;
        }
      }
      toRaw ??= currentMessagingTarget ?? currentChannelId;
    }
    if (!toRaw) {
      return undefined;
    }
    provider = providerId ?? normalizeOptionalLowercaseString(providerHint) ?? "message";
    const pluginExtractionArgs = { ...args, to: toRaw };
    const pluginExtracted = providerId
      ? getChannelPlugin(providerId)?.actions?.extractToolSend?.({ args: pluginExtractionArgs })
      : null;
    to = normalizeTargetForProvider(provider, pluginExtracted?.to ?? toRaw);
    resolvedAccountId = normalizeOptionalString(pluginExtracted?.accountId) ?? accountId;
    threadId =
      normalizeOptionalString(pluginExtracted?.threadId) ?? normalizeOptionalString(args.threadId);
    const replyToId = normalizeOptionalString(args.replyTo);
    // Normal sends use prepared core delivery, where provider transport owns
    // reply/thread precedence. Other send-like actions use plugin dispatch.
    outboundReplyToId = action === "send" ? replyToId : undefined;
    threadSuppressed =
      pluginExtracted?.threadSuppressed === true ||
      args.topLevel === true ||
      args.threadId === null;
    allowImplicitThread =
      Boolean(to && providerId) && (!pluginExtracted || pluginExtracted.threadImplicit === true);
  } else {
    providerId = normalizeChannelId(toolName);
    if (!providerId) {
      return undefined;
    }
    provider = providerId;
    const extracted = getChannelPlugin(providerId)?.actions?.extractToolSend?.({ args });
    if (!extracted?.to) {
      return undefined;
    }
    to = normalizeTargetForProvider(providerId, extracted.to);
    threadId = normalizeOptionalString(extracted.threadId);
    threadSuppressed = extracted.threadSuppressed === true;
    resolvedAccountId = normalizeOptionalString(extracted.accountId) ?? accountId;
    const nativeReplyToMode = options?.replyToMode;
    const nativeSingleUseMode = nativeReplyToMode === "first" || nativeReplyToMode === "batched";
    allowImplicitThread =
      extracted.threadImplicit === true &&
      nativeReplyToMode !== undefined &&
      (!nativeSingleUseMode || options?.hasRepliedRef !== undefined);
  }
  return to
    ? {
        tool: toolName,
        provider,
        accountId: resolvedAccountId,
        to,
        ...(providerId
          ? resolveMessagingToolThreadEvidence({
              providerId,
              to,
              accountId: resolvedAccountId,
              threadId,
              replyToId: outboundReplyToId,
              allowImplicitThread,
              threadSuppressed,
              options,
            })
          : {
              ...(threadId ? { threadId } : {}),
              ...(threadSuppressed ? { threadSuppressed: true } : {}),
            }),
      }
    : undefined;
}

/** Reconciles pending send evidence with the provider's successful action result. */
export function extractMessagingToolSendResult(
  pending: MessagingToolSend,
  result: unknown,
): MessagingToolSend {
  const providerId = normalizeChannelId(pending.provider);
  const extracted = providerId
    ? getChannelPlugin(providerId)?.actions?.extractToolSendResult?.({
        result,
        send: {
          to: pending.to ?? "",
          accountId: pending.accountId,
          threadId: pending.threadId,
          threadImplicit: pending.threadImplicit,
          threadSuppressed: pending.threadSuppressed,
        },
      })
    : null;
  if (!extracted?.to) {
    return pending;
  }
  const extractedThreadId = normalizeOptionalString(extracted.threadId);
  const providerReportedThread =
    extractedThreadId != null ||
    extracted.threadImplicit === true ||
    extracted.threadSuppressed === true;
  // Thread route fields are one state. Mixing provider and pending values can
  // create contradictory implicit and suppressed evidence.
  const threadEvidence = providerReportedThread ? extracted : pending;
  return {
    ...pending,
    ...extracted,
    accountId: normalizeOptionalString(extracted.accountId) ?? pending.accountId,
    to: normalizeTargetForProvider(providerId ?? pending.provider, extracted.to),
    threadId: normalizeOptionalString(threadEvidence.threadId),
    threadImplicit: threadEvidence.threadImplicit === true ? true : undefined,
    threadSuppressed: threadEvidence.threadSuppressed === true ? true : undefined,
  };
}

export function isDeliveredMessagingToolSendToCurrentSource(params: {
  send: MessagingToolSend | undefined;
  config?: OpenClawConfig;
  currentProvider?: string;
  currentAccountId?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadId?: string;
  sessionKey?: string;
  deliveredPayload?: unknown;
}): boolean {
  const send = params.send;
  if (!send?.to) {
    return false;
  }
  return isDeliveredCurrentSourceReply({
    action: "send",
    channel: send.provider,
    accountId: send.accountId,
    currentAccountId: params.currentAccountId,
    actionParams: {
      target: send.to,
      ...(send.threadSuppressed
        ? { topLevel: true }
        : send.threadId
          ? { threadId: send.threadId }
          : {}),
    },
    cfg: params.config ?? {},
    sessionKey: params.sessionKey,
    toolContext: {
      currentChannelProvider: params.currentProvider,
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentThreadTs: params.currentThreadId,
    },
    deliveredPayload: params.deliveredPayload,
  });
}
