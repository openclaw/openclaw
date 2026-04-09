import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { type OpenClawConfig, type RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import { formatUnknownError } from "./errors.js";
import { buildFeedbackEvent, runFeedbackReflection } from "./feedback-reflection.js";
import { buildFileInfoCard, parseFileConsentInvoke, uploadToConsentUrl } from "./file-consent.js";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import type { MSTeamsAdapter } from "./messenger.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import { getDefaultPendingUploadFsStore, type PendingUploadFsStore } from "./pending-uploads-fs.js";
import { getPendingUpload, removePendingUpload } from "./pending-uploads.js";
import type { MSTeamsPollStore } from "./polls.js";
import { withRevokedProxyFallback } from "./revoked-context.js";
import { getMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";

export type MSTeamsAccessTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsRemoved: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  run?: (context: unknown) => Promise<void>;
};

export type MSTeamsMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  appId: string;
  adapter: MSTeamsAdapter;
  tokenProvider: MSTeamsAccessTokenProvider;
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
  /**
   * Optional override for the cross-process pending-upload store. Falls back
   * to the process-wide default (which writes under the msteams state dir).
   * Tests supply a temp-dir-backed store to avoid touching the real state
   * dir.
   */
  pendingUploadFsStore?: PendingUploadFsStore;
};

function serializeAdaptiveCardActionValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

async function isFeedbackInvokeAuthorized(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  const resolved = await resolveMSTeamsSenderAccess({
    cfg: deps.cfg,
    activity: context.activity,
  });
  const { msteamsCfg, isDirectMessage, conversationId, senderId } = resolved;
  if (!msteamsCfg) {
    return true;
  }

  if (isDirectMessage && resolved.access.decision !== "allow") {
    deps.log.debug?.("dropping feedback invoke (dm sender not allowlisted)", {
      sender: senderId,
      conversationId,
    });
    return false;
  }

  if (
    !isDirectMessage &&
    resolved.channelGate.allowlistConfigured &&
    !resolved.channelGate.allowed
  ) {
    deps.log.debug?.("dropping feedback invoke (not in team/channel allowlist)", {
      conversationId,
      teamKey: resolved.channelGate.teamKey ?? "none",
      channelKey: resolved.channelGate.channelKey ?? "none",
    });
    return false;
  }

  if (!isDirectMessage && !resolved.senderGroupAccess.allowed) {
    deps.log.debug?.("dropping feedback invoke (group sender not allowlisted)", {
      sender: senderId,
      conversationId,
    });
    return false;
  }

  return true;
}

/** Source of a resolved pending upload, so we remove from the correct store. */
type PendingUploadSource = "memory" | "fs";
type ResolvedPendingUpload = {
  source: PendingUploadSource;
  filename: string;
  contentType?: string;
  conversationId: string;
  buffer: Buffer;
};

/**
 * Look up a pending upload in both the in-memory store and the FS-backed
 * store. The FS store is the cross-process fallback used by the CLI
 * `message send --media` path (see #55386), since that sender runs in a
 * different process than the monitor webhook handler.
 *
 * FS store errors are intentionally swallowed (logged at debug): the FS
 * store is an opportunistic fallback, and a misconfigured state dir or a
 * transient read error should never prevent the in-memory fast path or
 * crash the invoke handler.
 */
async function resolvePendingUpload(
  uploadId: string | undefined,
  fsStore: PendingUploadFsStore,
  log: MSTeamsMonitorLogger,
): Promise<ResolvedPendingUpload | undefined> {
  if (!uploadId) {
    return undefined;
  }

  const memoryHit = getPendingUpload(uploadId);
  if (memoryHit) {
    return {
      source: "memory",
      filename: memoryHit.filename,
      contentType: memoryHit.contentType,
      conversationId: memoryHit.conversationId,
      buffer: memoryHit.buffer,
    };
  }

  try {
    const fsHit = await fsStore.get(uploadId);
    if (fsHit) {
      return {
        source: "fs",
        filename: fsHit.entry.filename,
        contentType: fsHit.entry.contentType,
        conversationId: fsHit.entry.conversationId,
        buffer: fsHit.buffer,
      };
    }
  } catch (err) {
    log.debug?.("fs-backed pending upload lookup failed", {
      uploadId,
      error: formatUnknownError(err),
    });
  }

  return undefined;
}

async function removeResolvedPendingUpload(
  uploadId: string | undefined,
  source: PendingUploadSource | undefined,
  fsStore: PendingUploadFsStore,
  log: MSTeamsMonitorLogger,
): Promise<void> {
  if (!uploadId) {
    return;
  }
  const safeFsRemove = async () => {
    try {
      await fsStore.remove(uploadId);
    } catch (err) {
      log.debug?.("fs-backed pending upload removal failed", {
        uploadId,
        error: formatUnknownError(err),
      });
    }
  };
  if (source === "fs") {
    await safeFsRemove();
    return;
  }
  if (source === "memory") {
    removePendingUpload(uploadId);
    return;
  }
  // Source unknown (e.g. decline with no prior lookup) — clear both stores so
  // no stale entry survives either side.
  removePendingUpload(uploadId);
  await safeFsRemove();
}

export type MSTeamsFileConsentInvokeDeps = {
  log: MSTeamsMonitorLogger;
  fsStore?: PendingUploadFsStore;
};

/**
 * Handle fileConsent/invoke activities for large file uploads.
 */
async function handleFileConsentInvoke(
  context: MSTeamsTurnContext,
  deps: MSTeamsFileConsentInvokeDeps,
): Promise<boolean> {
  const { log } = deps;
  const fsStore = deps.fsStore ?? getDefaultPendingUploadFsStore();
  const expiredUploadMessage =
    "The file upload request has expired. Please try sending the file again.";
  const activity = context.activity;
  if (activity.type !== "invoke" || activity.name !== "fileConsent/invoke") {
    return false;
  }

  const consentResponse = parseFileConsentInvoke(activity);
  if (!consentResponse) {
    log.debug?.("invalid file consent invoke", { value: activity.value });
    return false;
  }

  const uploadId =
    typeof consentResponse.context?.uploadId === "string"
      ? consentResponse.context.uploadId
      : undefined;
  const pendingFile = await resolvePendingUpload(uploadId, fsStore, log);
  if (pendingFile) {
    const pendingConversationId = normalizeMSTeamsConversationId(pendingFile.conversationId);
    const invokeConversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
    if (!invokeConversationId || pendingConversationId !== invokeConversationId) {
      log.info("file consent conversation mismatch", {
        uploadId,
        expectedConversationId: pendingConversationId,
        receivedConversationId: invokeConversationId || undefined,
      });
      if (consentResponse.action === "accept") {
        await context.sendActivity(expiredUploadMessage);
      }
      return true;
    }
  }

  if (consentResponse.action === "accept" && consentResponse.uploadInfo) {
    if (pendingFile) {
      log.debug?.("user accepted file consent, uploading", {
        uploadId,
        filename: pendingFile.filename,
        size: pendingFile.buffer.length,
        source: pendingFile.source,
      });

      try {
        // Upload file to the provided URL
        await uploadToConsentUrl({
          url: consentResponse.uploadInfo.uploadUrl,
          buffer: pendingFile.buffer,
          contentType: pendingFile.contentType,
        });

        // Send confirmation card
        const fileInfoCard = buildFileInfoCard({
          filename: consentResponse.uploadInfo.name,
          contentUrl: consentResponse.uploadInfo.contentUrl,
          uniqueId: consentResponse.uploadInfo.uniqueId,
          fileType: consentResponse.uploadInfo.fileType,
        });

        await context.sendActivity({
          type: "message",
          attachments: [fileInfoCard],
        });

        log.info("file upload complete", {
          uploadId,
          filename: consentResponse.uploadInfo.name,
          uniqueId: consentResponse.uploadInfo.uniqueId,
        });
      } catch (err) {
        log.error("file upload failed", { uploadId, error: formatUnknownError(err) });
        await context.sendActivity("File upload failed. Please try again.");
      } finally {
        await removeResolvedPendingUpload(uploadId, pendingFile.source, fsStore, log);
      }
    } else {
      log.debug?.("pending file not found for consent", { uploadId });
      await context.sendActivity(expiredUploadMessage);
    }
  } else {
    // User declined
    log.debug?.("user declined file consent", { uploadId });
    await removeResolvedPendingUpload(uploadId, pendingFile?.source, fsStore, log);
  }

  return true;
}

/**
 * Parse and handle feedback invoke activities (thumbs up/down).
 * Returns true if the activity was a feedback invoke, false otherwise.
 */
async function handleFeedbackInvoke(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  const activity = context.activity;
  const value = activity.value as
    | {
        actionName?: string;
        actionValue?: { reaction?: string; feedback?: string };
        replyToId?: string;
      }
    | undefined;

  if (!value) {
    return false;
  }

  // Teams feedback invoke format: actionName="feedback", actionValue.reaction="like"|"dislike"
  if (value.actionName !== "feedback") {
    return false;
  }

  const reaction = value.actionValue?.reaction;
  if (reaction !== "like" && reaction !== "dislike") {
    deps.log.debug?.("ignoring feedback with unknown reaction", { reaction });
    return false;
  }

  const msteamsCfg = deps.cfg.channels?.msteams;
  if (msteamsCfg?.feedbackEnabled === false) {
    deps.log.debug?.("feedback handling disabled");
    return true; // Still consume the invoke
  }

  if (!(await isFeedbackInvokeAuthorized(context, deps))) {
    return true;
  }

  // Extract user comment from the nested JSON string
  let userComment: string | undefined;
  if (value.actionValue?.feedback) {
    try {
      const parsed = JSON.parse(value.actionValue.feedback) as { feedbackText?: string };
      userComment = parsed.feedbackText || undefined;
    } catch {
      // Best effort — feedback text is optional
    }
  }

  // Strip ;messageid=... suffix to match the normalized ID used by the message handler.
  const rawConversationId = activity.conversation?.id ?? "unknown";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
  const messageId = value.replyToId ?? activity.replyToId ?? "unknown";
  const isNegative = reaction === "dislike";

  // Route feedback using the same chat-type logic as normal messages
  // so session keys, agent IDs, and transcript paths match.
  const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  const isDirectMessage = convType === "personal" || (!convType && !activity.conversation?.isGroup);
  const isChannel = convType === "channel";

  const core = getMSTeamsRuntime();
  const route = core.channel.routing.resolveAgentRoute({
    cfg: deps.cfg,
    channel: "msteams",
    peer: {
      kind: isDirectMessage ? "direct" : isChannel ? "channel" : "group",
      id: isDirectMessage ? senderId : conversationId,
    },
  });

  // Match the thread-aware session key used by the message handler so feedback
  // events land in the correct per-thread transcript. For channel threads, the
  // thread root ID comes from the ;messageid= suffix on the conversation ID or
  // from activity.replyToId.
  const feedbackThreadId = isChannel
    ? (extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId ?? undefined)
    : undefined;
  if (feedbackThreadId) {
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey: route.sessionKey,
      threadId: feedbackThreadId,
      parentSessionKey: route.sessionKey,
    });
    route.sessionKey = threadKeys.sessionKey;
  }

  // Log feedback event to session JSONL
  const feedbackEvent = buildFeedbackEvent({
    messageId,
    value: isNegative ? "negative" : "positive",
    comment: userComment,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
    conversationId,
  });

  deps.log.info("received feedback", {
    value: feedbackEvent.value,
    messageId,
    conversationId,
    hasComment: Boolean(userComment),
  });

  // Write feedback event to session transcript
  try {
    const storePath = core.channel.session.resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const fs = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const safeKey = route.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    const transcriptFile = pathMod.join(storePath, `${safeKey}.jsonl`);
    await fs.appendFile(transcriptFile, JSON.stringify(feedbackEvent) + "\n", "utf-8").catch(() => {
      // Best effort — transcript dir may not exist yet
    });
  } catch {
    // Best effort
  }

  // Build conversation reference for proactive messages (ack + reflection follow-up)
  const conversationRef = {
    activityId: activity.id,
    user: {
      id: activity.from?.id,
      name: activity.from?.name,
      aadObjectId: activity.from?.aadObjectId,
    },
    agent: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    bot: activity.recipient
      ? { id: activity.recipient.id, name: activity.recipient.name }
      : undefined,
    conversation: {
      id: conversationId,
      conversationType: activity.conversation?.conversationType,
      tenantId: activity.conversation?.tenantId,
    },
    channelId: activity.channelId ?? "msteams",
    serviceUrl: activity.serviceUrl,
    locale: activity.locale,
  };

  // For negative feedback, trigger background reflection (fire-and-forget).
  // No ack message — the reflection follow-up serves as the acknowledgement.
  // Sending anything during the invoke handler causes "unable to reach app" errors.
  if (isNegative && msteamsCfg?.feedbackReflection !== false) {
    // Note: thumbedDownResponse is not populated here because we don't cache
    // sent message text. The agent still has full session context for reflection
    // since the reflection runs in the same session. The user comment (if any)
    // provides additional signal.
    runFeedbackReflection({
      cfg: deps.cfg,
      adapter: deps.adapter,
      appId: deps.appId,
      conversationRef,
      sessionKey: route.sessionKey,
      agentId: route.agentId,
      conversationId,
      feedbackMessageId: messageId,
      userComment,
      log: deps.log,
    }).catch((err) => {
      deps.log.error("feedback reflection failed", { error: formatUnknownError(err) });
    });
  }

  return true;
}

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);

  // Wrap the original run method to intercept invokes
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context: unknown) => {
      const ctx = context as MSTeamsTurnContext;
      // Handle file consent invokes before passing to normal flow
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "fileConsent/invoke") {
        // Send invoke response IMMEDIATELY to prevent Teams timeout
        await ctx.sendActivity({ type: "invokeResponse", value: { status: 200 } });

        try {
          await withRevokedProxyFallback({
            run: async () =>
              await handleFileConsentInvoke(ctx, {
                log: deps.log,
                fsStore: deps.pendingUploadFsStore,
              }),
            onRevoked: async () => true,
            onRevokedLog: () => {
              deps.log.debug?.(
                "turn context revoked during file consent invoke; skipping delayed response",
              );
            },
          });
        } catch (err) {
          deps.log.debug?.("file consent handler error", { error: formatUnknownError(err) });
        }
        return;
      }

      // Handle feedback invokes (thumbs up/down on AI-generated messages).
      // Just return after handling — the process() handler sends HTTP 200 automatically.
      // Do NOT call sendActivity with invokeResponse; our custom adapter would POST
      // a new activity to Bot Framework instead of responding to the HTTP request.
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "message/submitAction") {
        const handled = await handleFeedbackInvoke(ctx, deps);
        if (handled) {
          return;
        }
      }

      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "adaptiveCard/action") {
        const text = serializeAdaptiveCardActionValue(ctx.activity?.value);
        if (text) {
          await handleTeamsMessage({
            ...ctx,
            activity: {
              ...ctx.activity,
              type: "message",
              text,
            },
          });
          return;
        }
        deps.log.debug?.("skipping adaptive card action invoke without value payload");
      }

      return originalRun.call(handler, context);
    };
  }

  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context as MSTeamsTurnContext);
    } catch (err) {
      deps.runtime.error?.(`msteams handler failed: ${formatUnknownError(err)}`);
    }
    await next();
  });

  handler.onMembersAdded(async (context, next) => {
    const ctx = context as MSTeamsTurnContext;
    const membersAdded = ctx.activity?.membersAdded ?? [];
    const botId = ctx.activity?.recipient?.id;
    const msteamsCfg = deps.cfg.channels?.msteams;

    for (const member of membersAdded) {
      if (member.id === botId) {
        // Bot was added to a conversation — send welcome card if configured.
        const conversationType =
          normalizeOptionalLowercaseString(ctx.activity?.conversation?.conversationType) ??
          "personal";
        const isPersonal = conversationType === "personal";

        if (isPersonal && msteamsCfg?.welcomeCard !== false) {
          const botName = ctx.activity?.recipient?.name ?? undefined;
          const card = buildWelcomeCard({
            botName,
            promptStarters: msteamsCfg?.promptStarters,
          });
          try {
            await ctx.sendActivity({
              type: "message",
              attachments: [
                {
                  contentType: "application/vnd.microsoft.card.adaptive",
                  content: card,
                },
              ],
            });
            deps.log.info("sent welcome card");
          } catch (err) {
            deps.log.debug?.("failed to send welcome card", { error: formatUnknownError(err) });
          }
        } else if (!isPersonal && msteamsCfg?.groupWelcomeCard === true) {
          const botName = ctx.activity?.recipient?.name ?? undefined;
          try {
            await ctx.sendActivity(buildGroupWelcomeText(botName));
            deps.log.info("sent group welcome message");
          } catch (err) {
            deps.log.debug?.("failed to send group welcome", { error: formatUnknownError(err) });
          }
        } else {
          deps.log.debug?.("skipping welcome (disabled by config or conversation type)");
        }
      } else {
        deps.log.debug?.("member added", { member: member.id });
      }
    }
    await next();
  });

  return handler;
}
