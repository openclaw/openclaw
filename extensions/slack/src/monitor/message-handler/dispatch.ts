import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
  type StatusReactionAdapter,
} from "openclaw/plugin-sdk/channel-feedback";
import { deliverFinalizableDraftPreview } from "openclaw/plugin-sdk/channel-lifecycle";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingNativeTransport,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-streaming";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import { normalizeSlackOutboundText } from "../../format.js";
import {
  compileSlackInteractiveReplies,
  isSlackInteractiveRepliesEnabled,
} from "../../interactive-replies.js";
import { SLACK_TEXT_LIMIT } from "../../limits.js";
import { recordSlackThreadParticipation } from "../../sent-thread-cache.js";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamingConfig,
} from "../../stream-mode.js";
import type {
  SlackChunkStreamSession,
  SlackPlanMessageSession,
  SlackStreamChunk,
  SlackStreamSession,
} from "../../streaming.js";
import {
  appendSlackStream,
  appendSlackChunkStream,
  appendSlackPlanMessage,
  markSlackStreamFallbackDelivered,
  SlackStreamNotDeliveredError,
  startSlackChunkStream,
  startSlackPlanMessage,
  startSlackStream,
  stopSlackChunkStream,
  stopSlackPlanMessage,
  stopSlackStream,
} from "../../streaming.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import { resolveStorePath, updateLastRoute } from "../config.runtime.js";
import {
  createSlackReplyDeliveryPlan,
  deliverReplies,
  readSlackReplyBlocks,
  resolveSlackThreadTs,
} from "../replies.js";
import { createReplyDispatcherWithTyping, dispatchInboundMessage } from "../reply.runtime.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";
import type { PreparedSlackMessage } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Slack reactions.add/remove expect shortcode names, not raw unicode emoji.
const UNICODE_TO_SLACK: Record<string, string> = {
  "👀": "eyes",
  "🤔": "thinking_face",
  "🔥": "fire",
  "👨‍💻": "male-technologist",
  "👨💻": "male-technologist",
  "👩‍💻": "female-technologist",
  "⚡": "zap",
  "🌐": "globe_with_meridians",
  "✅": "white_check_mark",
  "👍": "thumbsup",
  "❌": "x",
  "😱": "scream",
  "🥱": "yawning_face",
  "😨": "fearful",
  "⏳": "hourglass_flowing_sand",
  "⚠️": "warning",
  "✍": "writing_hand",
  "🧠": "brain",
  "🛠️": "hammer_and_wrench",
  "💻": "computer",
};

function toSlackEmojiName(emoji: string): string {
  const trimmed = emoji.trim().replace(/^:+|:+$/g, "");
  return UNICODE_TO_SLACK[trimmed] ?? trimmed;
}

const TOOL_STATUS_LABELS: Record<string, string> = {
  exec: "Running command...",
  Read: "Reading files...",
  Edit: "Editing files...",
  Write: "Writing files...",
  web_search: "Searching the web...",
  web_fetch: "Fetching page...",
  memory_search: "Checking memory...",
  memory_get: "Reading memory...",
  browser: "Using browser...",
  message: "Sending message...",
  tts: "Converting to speech...",
  image: "Analyzing image...",
  sessions_spawn: "Spawning sub-agent...",
  sessions_send: "Messaging sub-agent...",
  sessions_list: "Checking sessions...",
  sessions_history: "Reading session history...",
  session_status: "Checking status...",
  cron: "Managing schedule...",
  canvas: "Updating canvas...",
  nodes: "Checking nodes...",
  gateway: "Managing gateway...",
  whatsapp_login: "WhatsApp login...",
  agents_list: "Listing agents...",
  process: "Managing process...",
};

export function toolStatusLabel(toolName: string): string {
  return TOOL_STATUS_LABELS[toolName] ?? `Using ${toolName}...`;
}

export function normalizeSlackProgressToolTitle(params: {
  title?: string;
  itemId?: string;
}): string {
  const haystack = `${params.title ?? ""} ${params.itemId ?? ""}`.toLowerCase();
  const isMemoryRelated =
    haystack.includes("openviking") ||
    haystack.includes(" viking") ||
    haystack.includes(" ov ") ||
    haystack.startsWith("ov ") ||
    haystack.includes("memory");
  if (
    isMemoryRelated &&
    (haystack.includes("openviking_store") ||
      haystack.includes("memory_store") ||
      haystack.includes("add-resource") ||
      haystack.includes("add-memory") ||
      /\b(?:openviking|ov)\s+write\b/.test(haystack) ||
      /\b(?:openviking|ov)\s+add-resource\b/.test(haystack) ||
      /\b(?:openviking|ov)\s+add-memory\b/.test(haystack) ||
      haystack.includes("ov_import"))
  ) {
    return "Updating memory";
  }
  if (
    isMemoryRelated &&
    (haystack.includes("openviking_forget") || haystack.includes("memory_forget"))
  ) {
    return "Updating memory";
  }
  if (
    isMemoryRelated &&
    (/\b(?:openviking|ov)\s+(?:browse|ls|tree|read|abstract|overview|grep|glob)\b/.test(haystack) ||
      haystack.includes("membrowse") ||
      haystack.includes("memread"))
  ) {
    return "Exploring memory";
  }
  if (haystack.includes("lin") || haystack.includes("linear")) {
    return "Using Linear";
  }
  if (haystack.includes("gog") || haystack.includes("google")) {
    return "Using Google Workspace";
  }
  if (isMemoryRelated) {
    return "Recalling memory";
  }
  if (haystack.includes("slack")) {
    return "Using Slack";
  }
  if (haystack.includes("browser")) {
    return "Using browser";
  }
  if (haystack.includes("read") && haystack.includes("file")) {
    return "Reading files";
  }
  if (haystack.includes("exec") || haystack.includes("command") || haystack.includes("shell")) {
    return "Running command";
  }
  const raw = params.title?.trim();
  if (!raw) {
    return "Using tool";
  }
  if (raw.length > 48 || raw.includes("`") || raw.includes("(") || raw.includes("/")) {
    return "Using tool";
  }
  return raw;
}

export function isSlackStreamingEnabled(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
}): boolean {
  if (params.mode !== "partial") {
    return false;
  }
  return params.nativeStreaming;
}

export function shouldEnableSlackPreviewStreaming(params: {
  mode: "off" | "partial" | "block" | "progress";
  isDirectMessage: boolean;
  threadTs?: string;
}): boolean {
  if (params.mode === "off") {
    return false;
  }
  if (!params.isDirectMessage) {
    return true;
  }
  return Boolean(params.threadTs);
}

export function shouldInitializeSlackDraftStream(params: {
  previewStreamingEnabled: boolean;
  useStreaming: boolean;
  progressPlanStreamingEnabled?: boolean;
}): boolean {
  return (
    params.previewStreamingEnabled && !params.useStreaming && !params.progressPlanStreamingEnabled
  );
}

export function resolveSlackStreamingThreadHint(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  isThreadReply?: boolean;
}): string | undefined {
  return resolveSlackThreadTs({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: false,
    isThreadReply: params.isThreadReply,
  });
}

type SlackTurnDeliveryAttempt = {
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  threadTs?: string;
  textOverride?: string;
};

function buildSlackTurnDeliveryKey(params: SlackTurnDeliveryAttempt): string | null {
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.textOverride,
  });
  const slackBlocks = readSlackReplyBlocks(params.payload);
  if (!reply.hasContent && !slackBlocks?.length) {
    return null;
  }
  return JSON.stringify({
    kind: params.kind,
    threadTs: params.threadTs ?? "",
    replyToId: params.payload.replyToId ?? null,
    text: reply.trimmedText,
    mediaUrls: reply.mediaUrls,
    blocks: slackBlocks ?? null,
  });
}

export function createSlackTurnDeliveryTracker() {
  const deliveredKeys = new Set<string>();
  return {
    hasDelivered(params: SlackTurnDeliveryAttempt) {
      const key = buildSlackTurnDeliveryKey(params);
      return key ? deliveredKeys.has(key) : false;
    },
    markDelivered(params: SlackTurnDeliveryAttempt) {
      const key = buildSlackTurnDeliveryKey(params);
      if (key) {
        deliveredKeys.add(key);
      }
    },
  };
}

function shouldUseStreaming(params: {
  streamingEnabled: boolean;
  threadTs: string | undefined;
}): boolean {
  if (!params.streamingEnabled) {
    return false;
  }
  if (!params.threadTs) {
    logVerbose("slack-stream: streaming disabled — no reply thread target available");
    return false;
  }
  return true;
}

export async function resolveSlackStreamRecipientTeamId(params: {
  client: Pick<PreparedSlackMessage["ctx"]["app"]["client"], "users">;
  token: string;
  userId?: PreparedSlackMessage["message"]["user"];
  fallbackTeamId?: string;
}): Promise<string | undefined> {
  if (params.userId && params.client.users?.info) {
    try {
      const info = await params.client.users.info({
        token: params.token,
        user: params.userId,
      });
      const teamId = info.user?.team_id ?? info.user?.profile?.team;
      if (teamId) {
        return teamId;
      }
    } catch (err) {
      logVerbose(`slack-stream: users.info team lookup failed (${formatErrorMessage(err)})`);
    }
  }
  return params.fallbackTeamId;
}

function shouldUseSlackProgressPlanStream(params: {
  mode: "off" | "partial" | "block" | "progress";
  isDirectMessage: boolean;
  threadTs?: string;
}): boolean {
  if (params.mode !== "progress") {
    return false;
  }
  if (typeof params.threadTs === "string" && params.threadTs.length > 0) {
    return true;
  }
  return params.isDirectMessage;
}

function createSlackTaskUpdateChunk(params: {
  taskId: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
}): SlackStreamChunk {
  return {
    type: "task_update",
    id: params.taskId,
    title: params.title,
    status: params.status,
  };
}

export type SlackProgressCompletedToolTask = {
  taskId: string;
  title: string;
  status: "complete" | "error";
};

export function createSlackProgressHandoffChunks(params: {
  nextTaskId: string;
  nextTitle: string;
  nextStatus?: "in_progress" | "error";
  completedToolTasks?: SlackProgressCompletedToolTask[];
}): SlackStreamChunk[] {
  return [
    createSlackTaskUpdateChunk({
      taskId: params.nextTaskId,
      title: params.nextTitle,
      status: params.nextStatus ?? "in_progress",
    }),
    ...(params.completedToolTasks ?? []).map((task) =>
      createSlackTaskUpdateChunk({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
      }),
    ),
  ];
}

function hasSlackAudioInput(message: PreparedSlackMessage["message"]): boolean {
  const files = [
    ...(message.files ?? []),
    ...(message.attachments ?? []).flatMap((attachment) => attachment.files ?? []),
  ];
  return files.some((file) => {
    const mime = file.mimetype?.trim().toLowerCase();
    const subtype = file.subtype?.trim().toLowerCase();
    return subtype === "slack_audio" || Boolean(mime?.startsWith("audio/"));
  });
}

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  // Resolve agent identity for Slack chat:write.customize overrides.
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
  const slackIdentity = outboundIdentity
    ? {
        username: outboundIdentity.name,
        iconUrl: outboundIdentity.avatarUrl,
        iconEmoji: outboundIdentity.emoji,
      }
    : undefined;

  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom: ctx.allowFrom,
      normalizeEntry: normalizeSlackAllowOwnerEntry,
    });
    const senderRecipient = normalizeOptionalLowercaseString(message.user);
    const skipMainUpdate =
      pinnedMainDmOwner &&
      senderRecipient &&
      normalizeOptionalLowercaseString(pinnedMainDmOwner) !== senderRecipient;
    if (skipMainUpdate) {
      logVerbose(
        `slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`,
      );
    } else {
      await updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
          threadId: prepared.ctxPayload.MessageThreadId,
        },
        ctx: prepared.ctxPayload,
      });
    }
  }

  const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
    message,
    replyToMode: prepared.replyToMode,
  });

  const reactionMessageTs = prepared.ackReactionMessageTs;
  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;
  const statusReactionsEnabled =
    Boolean(prepared.ackReactionPromise) &&
    Boolean(reactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled !== false;
  const slackStatusAdapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      await reactSlackMessage(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err) => {
        if (formatErrorMessage(err).includes("already_reacted")) {
          return;
        }
        throw err;
      });
    },
    removeReaction: async (emoji) => {
      await removeSlackReaction(message.channel, reactionMessageTs ?? "", toSlackEmojiName(emoji), {
        token: ctx.botToken,
        client: ctx.app.client,
      }).catch((err) => {
        if (formatErrorMessage(err).includes("no_reaction")) {
          return;
        }
        throw err;
      });
    },
  };
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  const statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: slackStatusAdapter,
    initialEmoji: prepared.ackReactionValue || "eyes",
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "slack",
        target: `${message.channel}/${message.ts}`,
        error: err,
      });
    },
  });

  if (statusReactionsEnabled) {
    void statusReactions.setQueued();
  }

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
    isThreadReply,
  });

  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingReaction = ctx.typingReaction;
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "slack",
    accountId: route.accountId,
    transformReplyPayload: (payload) =>
      isSlackInteractiveRepliesEnabled({ cfg, accountId: route.accountId })
        ? compileSlackInteractiveReplies(payload)
        : payload,
    typing: {
      start: async () => {
        if (!didSetStatus && !progressPlanStreamingEnabled) {
          didSetStatus = true;
          await ctx.setSlackThreadStatus({
            channelId: message.channel,
            threadTs: statusThreadTs,
            status: "is typing...",
          });
        }
        if (typingReaction && message.ts) {
          await reactSlackMessage(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: ctx.app.client,
          }).catch(() => {});
        }
      },
      stop: async () => {
        if (!didSetStatus) {
          return;
        }
        didSetStatus = false;
        await ctx.setSlackThreadStatus({
          channelId: message.channel,
          threadTs: statusThreadTs,
          status: "",
        });
        if (typingReaction && message.ts) {
          await removeSlackReaction(message.channel, message.ts, typingReaction, {
            token: ctx.botToken,
            client: ctx.app.client,
          }).catch(() => {});
        }
      },
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => runtime.error?.(danger(message)),
          channel: "slack",
          action: "start",
          target: typingTarget,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: (message) => runtime.error?.(danger(message)),
          channel: "slack",
          action: "stop",
          target: typingTarget,
          error: err,
        });
      },
    },
  });

  const slackStreaming = resolveSlackStreamingConfig({
    streaming: account.config.streaming,
    nativeStreaming: resolveChannelStreamingNativeTransport(account.config),
  });
  const streamThreadHint = resolveSlackStreamingThreadHint({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    isThreadReply,
  });
  const previewStreamingEnabled = shouldEnableSlackPreviewStreaming({
    mode: slackStreaming.mode,
    isDirectMessage: prepared.isDirectMessage,
    threadTs: streamThreadHint,
  });
  const streamingEnabled = isSlackStreamingEnabled({
    mode: slackStreaming.mode,
    nativeStreaming: slackStreaming.nativeStreaming,
  });
  const progressPlanStreamingEnabled = shouldUseSlackProgressPlanStream({
    mode: slackStreaming.mode,
    isDirectMessage: prepared.isDirectMessage,
    threadTs: streamThreadHint,
  });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint,
  });
  const shouldUseDraftStream = shouldInitializeSlackDraftStream({
    previewStreamingEnabled,
    useStreaming,
    progressPlanStreamingEnabled,
  });
  let streamSession: SlackStreamSession | null = null;
  let progressStreamSession: SlackChunkStreamSession | null = null;
  let progressPlanMessageSession: SlackPlanMessageSession | null = null;
  let streamFailed = false;
  let usedReplyThreadTs: string | undefined;
  let observedReplyDelivery = false;
  const deliveryTracker = createSlackTurnDeliveryTracker();
  let progressUpdateChain: Promise<void> = Promise.resolve();
  let progressPlanStarted = false;
  let progressReadingCompleted = false;
  let progressListeningStarted = false;
  let progressListeningCompleted = false;
  let progressToolsActivated = false;
  let progressContextStarted = false;
  let progressContextCompleted = false;
  let progressDecisionStarted = false;
  let progressDecisionCompleted = false;
  let progressSendingStarted = false;
  let progressSendingCompleted = false;
  const activeProgressToolTasks: string[] = [];
  const progressToolTaskIdsByItemId = new Map<string, string>();
  const progressToolTaskTitles = new Map<string, string>();
  const completedProgressToolTaskStatuses = new Map<string, "complete" | "error">();
  const deliverPendingStreamFallback = async (
    session: SlackStreamSession,
    err: SlackStreamNotDeliveredError,
  ): Promise<boolean> => {
    // The Slack SDK still owns this text in-memory; no streaming API call has
    // acknowledged it. Send it once through normal chat.postMessage.
    const fallbackText = err.pendingText.trim();
    if (!fallbackText) {
      return false;
    }
    try {
      // Rename-bind to dodge eslint-plugin-unicorn/require-post-message-target-origin
      // which cannot distinguish Slack chat.postMessage from window.postMessage.
      const postChatMessage = ctx.app.client.chat.postMessage.bind(ctx.app.client.chat);
      await postChatMessage({
        channel: session.channel,
        thread_ts: session.threadTs,
        text: fallbackText,
      });
      markSlackStreamFallbackDelivered(session);
      observedReplyDelivery = true;
      usedReplyThreadTs ??= session.threadTs;
      logVerbose(
        `slack-stream: streamed delivery failed (${err.slackCode}); delivered ${fallbackText.length} chars via chat.postMessage fallback`,
      );
      return true;
    } catch (postErr) {
      runtime.error?.(
        danger(
          `slack-stream: fallback chat.postMessage failed after ${err.slackCode}: ${formatErrorMessage(postErr)}`,
        ),
      );
      return false;
    }
  };

  const queueProgressUpdate = (callback: () => Promise<void>) => {
    progressUpdateChain = progressUpdateChain.then(callback).catch((err) => {
      runtime.error?.(danger(`slack progress stream failed: ${String(err)}`));
    });
    return progressUpdateChain;
  };

  const ensureProgressPlanStream = async () => {
    if (!progressPlanStreamingEnabled || progressPlanStarted) {
      return;
    }
    const initialChunks = [
      createSlackTaskUpdateChunk({
        taskId: "reading_message",
        title: "Reading message",
        status: "in_progress",
      }),
    ];
    if (prepared.isDirectMessage && !streamThreadHint) {
      progressPlanMessageSession = await startSlackPlanMessage({
        client: ctx.app.client,
        channel: message.channel,
        chunks: initialChunks,
      });
      progressPlanStarted = true;
      return;
    }
    progressStreamSession = await startSlackChunkStream({
      client: ctx.app.client,
      channel: message.channel,
      ...(streamThreadHint ? { threadTs: streamThreadHint } : {}),
      teamId: await resolveSlackStreamRecipientTeamId({
        client: ctx.app.client,
        token: ctx.botToken,
        userId: message.user,
        fallbackTeamId: ctx.teamId,
      }),
      userId: message.user,
      taskDisplayMode: "plan",
      chunks: initialChunks,
    });
    progressPlanStarted = true;
    didSetStatus = false;
    await ctx.setSlackThreadStatus({
      channelId: message.channel,
      threadTs: streamThreadHint,
      status: "",
    });
  };

  const appendProgressTaskUpdates = async (chunks: SlackStreamChunk[]) => {
    if (!progressPlanStreamingEnabled) {
      return;
    }
    await ensureProgressPlanStream();
    if (!progressStreamSession || chunks.length === 0) {
      if (progressPlanMessageSession && chunks.length > 0) {
        await appendSlackPlanMessage({
          session: progressPlanMessageSession,
          chunks,
        });
      }
      return;
    }
    await appendSlackChunkStream({
      session: progressStreamSession,
      chunks,
    });
  };

  const transitionProgressTask = async (params: {
    start?: { taskId: string; title: string; status: "in_progress" | "error" };
    complete?: { taskId: string; title: string; status: "complete" | "error" };
  }) => {
    const chunks: SlackStreamChunk[] = [];
    if (params.start) {
      chunks.push(
        createSlackTaskUpdateChunk({
          taskId: params.start.taskId,
          title: params.start.title,
          status: params.start.status,
        }),
      );
    }
    if (params.complete) {
      chunks.push(
        createSlackTaskUpdateChunk({
          taskId: params.complete.taskId,
          title: params.complete.title,
          status: params.complete.status,
        }),
      );
    }
    await appendProgressTaskUpdates(chunks);
  };

  const setProgressListeningStatus = async (
    status: "pending" | "in_progress" | "complete" | "error",
  ) => {
    if (status === "in_progress") {
      progressListeningStarted = true;
    }
    if (status === "complete" || status === "error") {
      progressListeningCompleted = true;
    }
    await appendProgressTaskUpdates([
      createSlackTaskUpdateChunk({
        taskId: "listening_to_audio",
        title: "Listening to audio",
        status,
      }),
    ]);
  };

  const setProgressToolsStatus = async (
    _status: "pending" | "in_progress" | "complete" | "error",
  ) => {};

  const setProgressContextStatus = async (
    status: "pending" | "in_progress" | "complete" | "error",
  ) => {
    if (status === "in_progress") {
      progressContextStarted = true;
    }
    if (status === "complete" || status === "error") {
      progressContextCompleted = true;
    }
    await appendProgressTaskUpdates([
      createSlackTaskUpdateChunk({
        taskId: "gathering_memory",
        title: "Gathering memory",
        status,
      }),
    ]);
  };

  const setProgressDecisionStatus = async (
    status: "pending" | "in_progress" | "complete" | "error",
  ) => {
    if (status === "in_progress") {
      progressDecisionStarted = true;
    }
    if (status === "complete" || status === "error") {
      progressDecisionCompleted = true;
    }
    await appendProgressTaskUpdates([
      createSlackTaskUpdateChunk({
        taskId: "deciding_next_steps",
        title: "Deciding on next steps",
        status,
      }),
    ]);
  };

  const setProgressSendingStatus = async (
    status: "pending" | "in_progress" | "complete" | "error",
  ) => {
    if (status === "in_progress") {
      progressSendingStarted = true;
    }
    if (status === "complete") {
      progressSendingCompleted = true;
    }
    await appendProgressTaskUpdates([
      createSlackTaskUpdateChunk({
        taskId: "sending_reply",
        title: "Sending reply",
        status,
      }),
    ]);
  };

  const startProgressListening = async () => {
    if (progressListeningStarted) {
      return;
    }
    progressListeningStarted = true;
    progressReadingCompleted = true;
    await transitionProgressTask({
      start: {
        taskId: "listening_to_audio",
        title: "Listening to audio",
        status: "in_progress",
      },
      complete: {
        taskId: "reading_message",
        title: "Reading message",
        status: "complete",
      },
    });
  };

  const completePreviousPhaseAfterNewStart = async (params: {
    nextTaskId: string;
    nextTitle: string;
    nextStatus?: "in_progress" | "error";
  }) => {
    const nextStatus = params.nextStatus ?? "in_progress";
    const completedToolTaskIds = activeProgressToolTasks.filter(
      (taskId) => taskId !== params.nextTaskId && completedProgressToolTaskStatuses.has(taskId),
    );
    if (completedToolTaskIds.length > 0) {
      activeProgressToolTasks.splice(
        0,
        activeProgressToolTasks.length,
        ...activeProgressToolTasks.filter((taskId) => !completedToolTaskIds.includes(taskId)),
      );
      await appendProgressTaskUpdates(
        createSlackProgressHandoffChunks({
          nextTaskId: params.nextTaskId,
          nextTitle: params.nextTitle,
          nextStatus,
          completedToolTasks: completedToolTaskIds.map((taskId) => ({
            taskId,
            title: progressToolTaskTitles.get(taskId) ?? "Use tool",
            status: completedProgressToolTaskStatuses.get(taskId) ?? "complete",
          })),
        }),
      );
      for (const taskId of completedToolTaskIds) {
        completedProgressToolTaskStatuses.delete(taskId);
        progressToolTaskTitles.delete(taskId);
      }
      return;
    }
    if (progressDecisionStarted && !progressDecisionCompleted) {
      progressDecisionCompleted = true;
      await transitionProgressTask({
        start: { taskId: params.nextTaskId, title: params.nextTitle, status: nextStatus },
        complete: {
          taskId: "deciding_next_steps",
          title: "Deciding on next steps",
          status: "complete",
        },
      });
      return;
    }
    if (progressContextStarted && !progressContextCompleted) {
      progressContextCompleted = true;
      await transitionProgressTask({
        start: { taskId: params.nextTaskId, title: params.nextTitle, status: nextStatus },
        complete: {
          taskId: "gathering_memory",
          title: "Gathering memory",
          status: "complete",
        },
      });
      return;
    }
    if (progressListeningStarted && !progressListeningCompleted) {
      progressListeningCompleted = true;
      await transitionProgressTask({
        start: { taskId: params.nextTaskId, title: params.nextTitle, status: nextStatus },
        complete: {
          taskId: "listening_to_audio",
          title: "Listening to audio",
          status: "complete",
        },
      });
      return;
    }
    if (!progressReadingCompleted) {
      progressReadingCompleted = true;
      await transitionProgressTask({
        start: { taskId: params.nextTaskId, title: params.nextTitle, status: nextStatus },
        complete: {
          taskId: "reading_message",
          title: "Reading message",
          status: "complete",
        },
      });
      return;
    }
    await transitionProgressTask({
      start: { taskId: params.nextTaskId, title: params.nextTitle, status: nextStatus },
    });
  };

  const startProgressContext = async () => {
    if (progressContextStarted) {
      return;
    }
    await completePreviousPhaseAfterNewStart({
      nextTaskId: "gathering_memory",
      nextTitle: "Gathering memory",
    });
    progressContextStarted = true;
  };

  const startProgressDecision = async () => {
    if (progressDecisionStarted) {
      return;
    }
    await completePreviousPhaseAfterNewStart({
      nextTaskId: "deciding_next_steps",
      nextTitle: "Deciding on next steps",
    });
    progressDecisionStarted = true;
  };

  const deliverNormally = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
    forcedThreadTs?: string;
  }): Promise<void> => {
    const replyThreadTs = params.forcedThreadTs ?? replyPlan.nextThreadTs();
    if (
      deliveryTracker.hasDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: replyThreadTs,
      })
    ) {
      logVerbose("slack: suppressed duplicate normal delivery within the same turn");
      return;
    }
    await deliverReplies({
      cfg: ctx.cfg,
      replies: [params.payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      replyThreadTs,
      replyToMode: prepared.replyToMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    observedReplyDelivery = true;
    // Record the thread ts only after confirmed delivery success.
    if (replyThreadTs) {
      usedReplyThreadTs ??= replyThreadTs;
    }
    replyPlan.markSent();
    deliveryTracker.markDelivered({
      kind: params.kind,
      payload: params.payload,
      threadTs: replyThreadTs,
    });
  };

  const deliverWithStreaming = async (params: {
    payload: ReplyPayload;
    kind: ReplyDispatchKind;
  }): Promise<void> => {
    const reply = resolveSendableOutboundReplyParts(params.payload);
    if (
      streamFailed ||
      reply.hasMedia ||
      readSlackReplyBlocks(params.payload)?.length ||
      !reply.hasText
    ) {
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: streamSession?.threadTs,
      });
      return;
    }

    const text = reply.trimmedText;
    let plannedThreadTs: string | undefined;
    try {
      if (!streamSession) {
        const streamThreadTs = replyPlan.nextThreadTs();
        plannedThreadTs = streamThreadTs;
        if (!streamThreadTs) {
          logVerbose(
            "slack-stream: no reply thread target for stream start, falling back to normal delivery",
          );
          streamFailed = true;
          await deliverNormally({ payload: params.payload, kind: params.kind });
          return;
        }
        if (
          deliveryTracker.hasDelivered({
            kind: params.kind,
            payload: params.payload,
            threadTs: streamThreadTs,
            textOverride: text,
          })
        ) {
          logVerbose("slack-stream: suppressed duplicate stream start payload");
          return;
        }

        streamSession = await startSlackStream({
          client: ctx.app.client,
          channel: message.channel,
          threadTs: streamThreadTs,
          text,
          teamId: await resolveSlackStreamRecipientTeamId({
            client: ctx.app.client,
            token: ctx.botToken,
            userId: message.user,
            fallbackTeamId: ctx.teamId,
          }),
          userId: message.user,
        });
        // startSlackStream may only buffer locally. Count delivery only after
        // the SDK reports a real Slack response.
        if (streamSession.delivered) {
          observedReplyDelivery = true;
        }
        usedReplyThreadTs ??= streamThreadTs;
        replyPlan.markSent();
        deliveryTracker.markDelivered({
          kind: params.kind,
          payload: params.payload,
          threadTs: streamThreadTs,
          textOverride: text,
        });
        return;
      }
      if (
        deliveryTracker.hasDelivered({
          kind: params.kind,
          payload: params.payload,
          threadTs: streamSession.threadTs,
          textOverride: text,
        })
      ) {
        logVerbose("slack-stream: suppressed duplicate append payload");
        return;
      }

      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
      // appendSlackStream also buffers locally below the SDK threshold; avoid
      // optimistic "done" status until Slack acknowledges a flush.
      if (streamSession.delivered) {
        observedReplyDelivery = true;
      }
      deliveryTracker.markDelivered({
        kind: params.kind,
        payload: params.payload,
        threadTs: streamSession.threadTs,
        textOverride: text,
      });
    } catch (err) {
      if (err instanceof SlackStreamNotDeliveredError) {
        streamFailed = true;
        if (streamSession) {
          const delivered = await deliverPendingStreamFallback(streamSession, err);
          if (delivered) {
            replyPlan.markSent();
            deliveryTracker.markDelivered({
              kind: params.kind,
              payload: params.payload,
              threadTs: streamSession.threadTs,
              textOverride: text,
            });
            return;
          }
          throw err;
        }
        await deliverNormally({
          payload: params.payload,
          kind: params.kind,
          forcedThreadTs: plannedThreadTs,
        });
        return;
      }
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${formatErrorMessage(err)}, falling back`),
      );
      streamFailed = true;
      await deliverNormally({
        payload: params.payload,
        kind: params.kind,
        forcedThreadTs: streamSession?.threadTs ?? plannedThreadTs,
      });
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...replyPipeline,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload, info) => {
      if (progressPlanStreamingEnabled) {
        await queueProgressUpdate(async () => {
          if (!progressSendingStarted || !progressSendingCompleted) {
            await completePreviousPhaseAfterNewStart({
              nextTaskId: "sending_reply",
              nextTitle: "Sending reply",
            });
            progressSendingStarted = true;
          }
        });
      }
      if (useStreaming) {
        await deliverWithStreaming({ payload, kind: info.kind });
        if (progressPlanStreamingEnabled && !progressSendingCompleted) {
          await queueProgressUpdate(async () => {
            await setProgressSendingStatus("complete");
          });
        }
        return;
      }

      const reply = resolveSendableOutboundReplyParts(payload);
      const slackBlocks = readSlackReplyBlocks(payload);
      const trimmedFinalText = reply.trimmedText;

      if (
        !progressPlanStreamingEnabled &&
        previewStreamingEnabled &&
        streamMode === "status_final" &&
        hasStreamedMessage
      ) {
        try {
          const statusChannelId = draftStream?.channelId();
          const statusMessageId = draftStream?.messageId();
          if (statusChannelId && statusMessageId) {
            await ctx.app.client.chat.update({
              token: ctx.botToken,
              channel: statusChannelId,
              ts: statusMessageId,
              text: "Status: complete. Final answer posted below.",
            });
          }
        } catch (err) {
          logVerbose(`slack: status_final completion update failed (${formatErrorMessage(err)})`);
        }
        hasStreamedMessage = false;
      }

      const result = await deliverFinalizableDraftPreview({
        kind: info.kind,
        payload,
        draft: draftStream
          ? {
              flush: draftStream.flush,
              clear: draftStream.clear,
              discardPending: draftStream.discardPending,
              seal: draftStream.seal,
              id: () => {
                const channelId = draftStream.channelId();
                const messageId = draftStream.messageId();
                return channelId && messageId ? { channelId, messageId } : undefined;
              },
            }
          : undefined,
        buildFinalEdit: () => {
          if (
            !previewStreamingEnabled ||
            streamMode === "status_final" ||
            reply.hasMedia ||
            payload.isError ||
            (trimmedFinalText.length === 0 && !slackBlocks?.length)
          ) {
            return undefined;
          }
          return {
            text: normalizeSlackOutboundText(trimmedFinalText),
            blocks: slackBlocks,
            threadTs: usedReplyThreadTs ?? statusThreadTs,
          };
        },
        editFinal: async (preview, edit) => {
          if (deliveryTracker.hasDelivered({ kind: info.kind, payload, threadTs: edit.threadTs })) {
            return;
          }
          await finalizeSlackPreviewEdit({
            client: ctx.app.client,
            token: ctx.botToken,
            accountId: account.accountId,
            channelId: preview.channelId,
            messageId: preview.messageId,
            text: edit.text,
            ...(edit.blocks?.length ? { blocks: edit.blocks } : {}),
            threadTs: edit.threadTs,
          });
        },
        deliverNormally: async () => {
          await deliverNormally({ payload, kind: info.kind });
        },
        onPreviewFinalized: (_preview) => {
          const finalThreadTs = usedReplyThreadTs ?? statusThreadTs;
          observedReplyDelivery = true;
          replyPlan.markSent();
          deliveryTracker.markDelivered({ kind: info.kind, payload, threadTs: finalThreadTs });
        },
        logPreviewEditFailure: (err) => {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${formatErrorMessage(err)})`,
          );
        },
      });

      if (result === "preview-finalized") {
        if (progressPlanStreamingEnabled && !progressSendingCompleted) {
          await queueProgressUpdate(async () => {
            await setProgressSendingStatus("complete");
          });
        }
        return;
      }

      if (progressPlanStreamingEnabled && !progressSendingCompleted) {
        await queueProgressUpdate(async () => {
          await setProgressSendingStatus("complete");
        });
      }
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${formatErrorMessage(err)}`));
      replyPipeline.typingCallbacks?.onIdle?.();
    },
  });

  const draftStream = shouldUseDraftStream
    ? createSlackDraftStream({
        target: prepared.replyTarget,
        cfg,
        token: ctx.botToken,
        accountId: account.accountId,
        maxChars: Math.min(ctx.textLimit, SLACK_TEXT_LIMIT),
        resolveThreadTs: () => {
          const ts = replyPlan.peekThreadTs();
          if (ts) {
            usedReplyThreadTs ??= ts;
          }
          return ts;
        },
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  let hasStreamedMessage = false;
  const streamMode = slackStreaming.draftMode;
  const previewToolProgressEnabled =
    !progressPlanStreamingEnabled &&
    Boolean(draftStream) &&
    resolveChannelStreamingPreviewToolProgress(account.config);
  let previewToolProgressSuppressed = false;
  let previewToolProgressLines: string[] = [];
  let appendRenderedText = "";
  let appendSourceText = "";
  let statusUpdateCount = 0;

  const pushPreviewToolProgress = (line?: string) => {
    if (!draftStream || !previewToolProgressEnabled || previewToolProgressSuppressed) {
      return;
    }
    const normalized = line?.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }
    const previous = previewToolProgressLines.at(-1);
    if (previous === normalized) {
      return;
    }
    previewToolProgressLines = [...previewToolProgressLines, normalized].slice(-8);
    draftStream.update(
      ["Working…", ...previewToolProgressLines.map((entry) => `• ${entry}`)].join("\n"),
    );
    hasStreamedMessage = true;
  };

  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }

    previewToolProgressSuppressed = true;
    previewToolProgressLines = [];

    if (streamMode === "append") {
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return;
      }
      draftStream?.update(next.rendered);
      hasStreamedMessage = true;
      return;
    }

    if (streamMode === "status_final") {
      statusUpdateCount += 1;
      if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) {
        return;
      }
      draftStream?.update(buildStatusFinalPreviewText(statusUpdateCount));
      hasStreamedMessage = true;
      return;
    }

    draftStream?.update(trimmed);
    hasStreamedMessage = true;
  };
  const onDraftBoundary = !shouldUseDraftStream
    ? undefined
    : async () => {
        if (hasStreamedMessage) {
          draftStream?.forceNewMessage();
          hasStreamedMessage = false;
          appendRenderedText = "";
          appendSourceText = "";
          statusUpdateCount = 0;
        }
        previewToolProgressSuppressed = false;
        previewToolProgressLines = [];
      };

  if (progressPlanStreamingEnabled) {
    await queueProgressUpdate(async () => {
      await ensureProgressPlanStream();
      if (hasSlackAudioInput(message) && !progressListeningStarted) {
        await startProgressListening();
      }
      await startProgressContext();
    });
  }

  let dispatchError: unknown;
  let queuedFinal = false;
  let counts: { final?: number; block?: number } = {};
  try {
    const result = await dispatchInboundMessage({
      ctx: prepared.ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        skillFilter: prepared.channelConfig?.skills,
        hasRepliedRef,
        disableBlockStreaming: useStreaming
          ? true
          : typeof resolveChannelStreamingBlockEnabled(account.config) === "boolean"
            ? !resolveChannelStreamingBlockEnabled(account.config)
            : undefined,
        onModelSelected: (modelCtx) => {
          onModelSelected(modelCtx);
          if (!progressPlanStreamingEnabled) {
            return;
          }
          void queueProgressUpdate(async () => {
            await startProgressDecision();
          });
        },
        suppressDefaultToolProgressMessages: previewToolProgressEnabled ? true : undefined,
        onPartialReply: useStreaming
          ? undefined
          : !previewStreamingEnabled || progressPlanStreamingEnabled
            ? undefined
            : async (payload) => {
                updateDraftFromPartial(payload.text);
              },
        onAssistantMessageStart: async () => {
          await onDraftBoundary?.();
          if (progressPlanStreamingEnabled) {
            await queueProgressUpdate(async () => {
              await startProgressDecision();
            });
          }
        },
        onReasoningEnd: async () => {
          await onDraftBoundary?.();
          if (
            progressPlanStreamingEnabled &&
            progressDecisionStarted &&
            !progressDecisionCompleted
          ) {
            await queueProgressUpdate(async () => {
              await setProgressDecisionStatus("complete");
            });
          }
        },
        onReasoningStream: statusReactionsEnabled
          ? async () => {
              await statusReactions.setThinking();
              if (progressPlanStreamingEnabled) {
                await queueProgressUpdate(async () => {
                  await startProgressDecision();
                });
              }
            }
          : progressPlanStreamingEnabled
            ? async () => {
                await queueProgressUpdate(async () => {
                  await startProgressDecision();
                });
              }
            : undefined,
        onToolStart: async (payload) => {
          if (statusReactionsEnabled) {
            await statusReactions.setTool(payload.name);
          }
          if (progressPlanStreamingEnabled) {
            return;
          }
          if (!payload.name || !statusThreadTs) {
            return;
          }
          didSetStatus = true;
          await ctx.setSlackThreadStatus({
            channelId: message.channel,
            threadTs: statusThreadTs,
            status: toolStatusLabel(payload.name),
          });
          pushPreviewToolProgress(payload.name ? `tool: ${payload.name}` : "tool running");
        },
        onItemEvent: async (payload) => {
          if (progressPlanStreamingEnabled) {
            await queueProgressUpdate(async () => {
              if (payload.kind !== "tool" || !payload.itemId || !payload.title) {
                return;
              }
              if (!progressToolsActivated) {
                progressToolsActivated = true;
                await setProgressToolsStatus("in_progress");
              }

              let taskId = progressToolTaskIdsByItemId.get(payload.itemId);
              if (!taskId) {
                taskId =
                  payload.itemId
                    .replace(/[^a-z0-9]+/gi, "_")
                    .replace(/^_+|_+$/g, "")
                    .toLowerCase() || "tool";
                progressToolTaskIdsByItemId.set(payload.itemId, taskId);
                progressToolTaskTitles.set(
                  taskId,
                  normalizeSlackProgressToolTitle({
                    title: payload.title,
                    itemId: payload.itemId,
                  }),
                );
              }

              const taskTitle =
                progressToolTaskTitles.get(taskId) ??
                normalizeSlackProgressToolTitle({
                  title: payload.title,
                  itemId: payload.itemId,
                });

              if (
                payload.phase === "start" ||
                payload.phase === "update" ||
                payload.status === "running"
              ) {
                if (!activeProgressToolTasks.includes(taskId)) {
                  activeProgressToolTasks.push(taskId);
                  await completePreviousPhaseAfterNewStart({
                    nextTaskId: taskId,
                    nextTitle: taskTitle,
                  });
                } else if (completedProgressToolTaskStatuses.has(taskId)) {
                  completedProgressToolTaskStatuses.delete(taskId);
                  await appendProgressTaskUpdates([
                    createSlackTaskUpdateChunk({
                      taskId,
                      title: taskTitle,
                      status: "in_progress",
                    }),
                  ]);
                }
                return;
              }

              if (
                payload.phase === "end" ||
                payload.status === "completed" ||
                payload.status === "failed"
              ) {
                const isError = payload.status === "failed";
                progressToolTaskIdsByItemId.delete(payload.itemId);
                completedProgressToolTaskStatuses.set(taskId, isError ? "error" : "complete");
              }
            });
            return;
          }
          pushPreviewToolProgress(
            payload.progressText ?? payload.summary ?? payload.title ?? payload.name,
          );
        },
        onPlanUpdate: async (payload) => {
          if (payload.phase !== "update") {
            return;
          }
          pushPreviewToolProgress(payload.explanation ?? payload.steps?.[0] ?? "planning");
        },
        onApprovalEvent: async (payload) => {
          if (payload.phase !== "requested") {
            return;
          }
          pushPreviewToolProgress(
            payload.command ? `approval: ${payload.command}` : "approval requested",
          );
        },
        onCommandOutput: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          pushPreviewToolProgress(
            payload.name
              ? `${payload.name}${payload.exitCode === 0 ? " ✓" : payload.exitCode != null ? ` (exit ${payload.exitCode})` : ""}`
              : payload.title,
          );
        },
        onPatchSummary: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          pushPreviewToolProgress(payload.summary ?? payload.title ?? "patch applied");
        },
      },
    });
    queuedFinal = result.queuedFinal;
    counts = result.counts;
  } catch (err) {
    dispatchError = err;
  } finally {
    await draftStream?.discardPending();
    markDispatchIdle();
  }

  // -----------------------------------------------------------------------
  // Finalize the stream if one was started
  // -----------------------------------------------------------------------
  let streamFallbackDelivered = false;
  const finalStream = streamSession as SlackStreamSession | null;
  if (finalStream && !finalStream.stopped) {
    try {
      await stopSlackStream({ session: finalStream });
    } catch (err) {
      if (err instanceof SlackStreamNotDeliveredError) {
        streamFallbackDelivered = await deliverPendingStreamFallback(finalStream, err);
      } else {
        runtime.error?.(danger(`slack-stream: failed to stop stream: ${formatErrorMessage(err)}`));
      }
    }
  }

  await progressUpdateChain;
  const finalProgressStream = progressStreamSession as SlackChunkStreamSession | null;
  const finalProgressPlanMessage = progressPlanMessageSession as SlackPlanMessageSession | null;
  if (
    (finalProgressStream && !finalProgressStream.stopped) ||
    (finalProgressPlanMessage && !finalProgressPlanMessage.stopped)
  ) {
    try {
      if (dispatchError) {
        await appendProgressTaskUpdates([
          createSlackTaskUpdateChunk({
            taskId: progressSendingStarted
              ? "sending_reply"
              : progressDecisionStarted
                ? "deciding_next_steps"
                : progressContextStarted
                  ? "gathering_memory"
                  : "reading_message",
            title: progressSendingStarted
              ? "Sending reply"
              : progressDecisionStarted
                ? "Deciding on next steps"
                : progressContextStarted
                  ? "Gathering memory"
                  : "Reading message",
            status: "error",
          }),
        ]);
        if (progressListeningStarted && !progressListeningCompleted) {
          await setProgressListeningStatus("error");
        }
        if (progressContextStarted && !progressContextCompleted) {
          await setProgressContextStatus("error");
        }
        if (progressDecisionStarted && !progressDecisionCompleted) {
          await setProgressDecisionStatus("error");
        }
        if (progressSendingStarted && !progressSendingCompleted) {
          await setProgressSendingStatus("error");
        }
        if (progressToolsActivated && activeProgressToolTasks.length > 0) {
          for (const taskId of activeProgressToolTasks.splice(0)) {
            await appendProgressTaskUpdates([
              createSlackTaskUpdateChunk({
                taskId,
                title: progressToolTaskTitles.get(taskId) ?? "Use tool",
                status: "error",
              }),
            ]);
            progressToolTaskTitles.delete(taskId);
            completedProgressToolTaskStatuses.delete(taskId);
          }
          await setProgressToolsStatus("error");
        }
      } else {
        if (!progressToolsActivated) {
          await setProgressToolsStatus("complete");
        }
        if (!progressSendingStarted) {
          await completePreviousPhaseAfterNewStart({
            nextTaskId: "sending_reply",
            nextTitle: "Sending reply",
          });
          progressSendingStarted = true;
        }
        if (!progressSendingCompleted) {
          await setProgressSendingStatus("complete");
        }
      }
      if (finalProgressStream && !finalProgressStream.stopped) {
        await stopSlackChunkStream({ session: finalProgressStream });
      }
      if (finalProgressPlanMessage && !finalProgressPlanMessage.stopped) {
        await stopSlackPlanMessage({ session: finalProgressPlanMessage });
      }
    } catch (err) {
      runtime.error?.(danger(`slack progress stream failed to stop: ${String(err)}`));
    }
  }

  const anyReplyDelivered =
    observedReplyDelivery ||
    queuedFinal ||
    streamFallbackDelivered ||
    (counts.block ?? 0) > 0 ||
    (counts.final ?? 0) > 0;

  if (statusReactionsEnabled) {
    if (dispatchError) {
      await statusReactions.setError();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.errorHoldMs);
          if (anyReplyDelivered) {
            await statusReactions.clear();
            return;
          }
          await statusReactions.restoreInitial();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    } else if (anyReplyDelivered) {
      await statusReactions.setDone();
      if (ctx.removeAckAfterReply) {
        void (async () => {
          await sleep(statusReactionTiming.doneHoldMs);
          await statusReactions.clear();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    } else {
      // Silent success should preserve queued state and clear any stall timers
      // instead of transitioning to terminal/stall reactions after return.
      await statusReactions.restoreInitial();
    }
  }

  if (dispatchError) {
    throw dispatchError;
  }

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs);
  }

  if (!anyReplyDelivered) {
    await draftStream?.clear();
    if (prepared.isRoomish) {
      clearHistoryEntriesIfEnabled({
        historyMap: ctx.channelHistories,
        historyKey: prepared.historyKey,
        limit: ctx.historyLimit,
      });
    }
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }

  if (!statusReactionsEnabled) {
    removeAckReactionAfterReply({
      removeAfterReply: ctx.removeAckAfterReply && anyReplyDelivered,
      ackReactionPromise: prepared.ackReactionPromise,
      ackReactionValue: prepared.ackReactionValue,
      remove: () =>
        removeSlackReaction(
          message.channel,
          prepared.ackReactionMessageTs ?? "",
          prepared.ackReactionValue,
          {
            token: ctx.botToken,
            client: ctx.app.client,
          },
        ),
      onError: (err) => {
        logAckFailure({
          log: logVerbose,
          channel: "slack",
          target: `${message.channel}/${message.ts}`,
          error: err,
        });
      },
    });
  }

  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit,
    });
  }
}
