import { resolveAgentConfig, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelInboundDebouncer,
  resolveInboundDebounceMs,
  formatInboundMediaUnavailableText,
  resolveEnvelopeFormatOptions,
  runChannelInboundEvent,
  shouldDebounceTextInbound,
  type ChannelInboundTurnPlan,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelMessageReplyPipeline,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import {
  resolveChannelGroups,
  resolveChannelGroupsConfigPath,
} from "openclaw/plugin-sdk/channel-policy";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  ensureConfiguredBindingRouteReady,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { isInboundPathAllowed, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTextChunkLimit, type GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import {
  createRuntimeConfigReader,
  getRuntimeConfig,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  createNonExitingRuntime,
  danger,
  logVerbose,
  shouldLogVerbose,
  sleepWithAbort,
  warn,
} from "openclaw/plugin-sdk/runtime-env";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  getSessionEntry,
  readSessionUpdatedAt,
  resolveSendPolicy,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { resolveIMessageAccount } from "../accounts.js";
import { iMessageApprovalControlBindings } from "../approval-control-binding-window.js";
import type { IMessageApprovalGatewayRuntime } from "../approval-gateway-types.js";
import { maybeResolveIMessageApprovalPollVote } from "../approval-polls.js";
import { pollPendingIMessageApprovalReactions } from "../approval-reaction-poller.js";
import { maybeResolveIMessageApprovalReaction } from "../approval-reactions.js";
import { buildIMessageApprovalConversationKeyForInbound } from "../approval-target-keys.js";
import { resolveIMessageDirectChatService } from "../chat-context.js";
import { resolveIMessageStartupRowidWatermark } from "../chat-db.js";
import { markIMessageChatRead, sendIMessageTyping } from "../chat.js";
import { resolveIMessageChatDbLookupPath } from "../cli-path.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "../client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "../constants.js";
import {
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "../media-contract.js";
import { imessageRpcSupportsMethod, probeIMessage, probeIMessagePrivateApi } from "../probe.js";
import {
  hasIMessageQuestionReactionTarget,
  maybeResolveIMessageQuestionReaction,
} from "../question-reactions.js";
import { resolveIMessageRemoteHost } from "../remote-host.js";
import { sendMessageIMessage } from "../send.js";
import { normalizeIMessageHandle } from "../targets.js";
import { attachIMessageMonitorAbortHandler } from "./abort-handler.js";
import { runIMessageCatchup } from "./catchup-bridge.js";
import { advanceIMessageCatchupCursor, resolveCatchupConfig } from "./catchup.js";
import { combineIMessagePayloads } from "./coalesce.js";
import { repairIMessageConversationAnchor } from "./conversation-repair.js";
import { createIMessageEchoCachingSend, deliverIMessageReply } from "./deliver.js";
import { resolveIMessageDmHistoryContext, resolveIMessageDmHistoryLimit } from "./dm-history.js";
import { createIMessageThrottledDropDiagnosticCache } from "./drop-diagnostic-cache.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  warnGroupAllowlistDropPerChatOnce,
  warnGroupAllowlistMisconfigOnce,
} from "./group-allowlist-warnings.js";
import {
  IMESSAGE_RECOVERY_MAX_AGE_MS,
  IMESSAGE_RECOVERY_MAX_ROWS,
  IMESSAGE_STALE_INBOUND_THRESHOLD_MS,
  isStaleIMessageBacklog,
} from "./inbound-dedupe.js";
import {
  buildIMessageInboundContext,
  mergeIMessageGroupAllowFromWithLegacyChatTargets,
  rememberIMessageSkippedFromMeForSelfChatDedupe,
  resolveIMessageReactionContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { createIMessageDurableIngress, type IMessageIngressLifecycle } from "./ingress.js";
import { createLoopRateLimiter } from "./loop-rate-limiter.js";
import { stageIMessageAttachments } from "./media-staging.js";
import { createPollCommentFolder } from "./poll-comment.js";
import { renderIMessagePollBody } from "./poll-render.js";
import { enqueueIMessageReactionSystemEvent } from "./reaction-system-event.js";
import {
  advanceIMessageRecoveryCursor,
  loadIMessageRecoveryCursor,
  resolveIMessageRecoveryCursorDbIdentity,
} from "./recovery-cursor.js";
import { createSelfChatCache } from "./self-chat-cache.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./types.js";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error-log.js";

const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;
// Host-private context installed through the generic channel runtime registry.
const CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY = "approval.gateway";
const APPROVAL_REACTION_POLL_INTERVAL_MS = 2_000;
const APPROVAL_REACTION_DISCOVERY_INTERVAL_MS = 60_000;
const IMESSAGE_TYPING_KEEPALIVE_INTERVAL_MS = 8_000;
const IMESSAGE_TYPING_KEEPALIVE_MAX_DURATION_MS = 10 * 60_000;
type IMessageTypingController = Parameters<NonNullable<GetReplyOptions["onTypingController"]>>[0];

function isIMessagePluginPayloadAttachment(attachment: {
  original_path?: string | null;
  transfer_name?: string | null;
  uti?: string | null;
}): boolean {
  const attachmentPath = attachment.original_path?.trim().toLowerCase() ?? "";
  const transferName = attachment.transfer_name?.trim().toLowerCase() ?? "";
  const uti = attachment.uti?.trim().toLowerCase() ?? "";
  return (
    attachmentPath.endsWith(".pluginpayloadattachment") ||
    transferName.endsWith(".pluginpayloadattachment") ||
    uti === "com.apple.messages.pluginpayloadattachment"
  );
}

const warnIfImsgUpgradeNeeded = (() => {
  let fired = false;
  return {
    fireOnce: (
      rpcMethods: readonly string[],
      runtime: { log?: (msg: string) => void; error?: (msg: string) => void },
    ) => {
      if (fired) {
        return;
      }
      fired = true;
      const detail =
        rpcMethods.length === 0
          ? "imsg build pre-dates the rpc_methods capability list"
          : `imsg rpc_methods=[${rpcMethods.join(", ")}] does not include typing/read`;
      runtime.log?.(
        warn(
          `imessage: typing indicators / read receipts gated off (${detail}). ` +
            `Upgrade imsg (current bridge needs typing+read in rpc_methods).`,
        ),
      );
    },
  };
})();

function isRetriableWatchSubscribeStartupError(error: unknown): boolean {
  return /imsg rpc timeout \(watch\.subscribe\)|imsg rpc (closed|exited|not running)/i.test(
    String(error),
  );
}

const IMESSAGE_DIAGNOSTIC_DROP_REASONS = new Set([
  "agent echo in self-chat",
  "echo",
  "from me",
  "no mention",
  "reflected assistant content",
  "self-chat echo",
]);
const IMESSAGE_THROTTLED_DIAGNOSTIC_DROP_REASONS = new Set(["from me", "no mention"]);

export async function monitorIMessageProvider(opts: MonitorIMessageOpts): Promise<void> {
  const { scheduler } = opts;
  const runtime = opts.runtime ?? createNonExitingRuntime();
  const cfg = opts.config ?? getRuntimeConfig();
  const readConfig = createRuntimeConfigReader(cfg);
  const accountInfo = resolveIMessageAccount({
    cfg,
    accountId: opts.accountId,
  });
  const groupsConfigPath = resolveChannelGroupsConfigPath({
    cfg,
    channel: "imessage",
    accountId: accountInfo.accountId,
    groups: resolveChannelGroups(cfg, "imessage", accountInfo.accountId),
  });
  const approvalGatewayRuntime =
    opts.channelRuntime?.runtimeContexts.get<IMessageApprovalGatewayRuntime>({
      channelId: "imessage",
      accountId: accountInfo.accountId,
      capability: CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY,
    });
  const imessageCfg = accountInfo.config;
  const historyLimit = resolvePromptHistoryLimit(
    imessageCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const sentMessageCache = createSentMessageCache();
  const selfChatCache = createSelfChatCache();
  const loopRateLimiter = createLoopRateLimiter();
  const textLimit = resolveTextChunkLimit(cfg, "imessage", accountInfo.accountId);
  const allowFrom = normalizeStringEntries(imessageCfg.allowFrom);
  const configuredGroupAllowFrom = imessageCfg.groupAllowFrom;
  const groupAllowFrom = normalizeStringEntries(
    configuredGroupAllowFrom ??
      (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0 ? imessageCfg.allowFrom : []),
  );
  const allowLegacyConversationAllowFromForGroup = configuredGroupAllowFrom == null;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.imessage !== undefined,
    groupPolicy: imessageCfg.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "imessage",
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });
  // Mirror the runtime gate's effective sender allowlist so the startup
  // warning fires only for configs where every group message actually drops.
  const effectiveGroupAllowFrom = mergeIMessageGroupAllowFromWithLegacyChatTargets({
    groupAllowFrom,
    allowFrom,
    allowLegacyConversationTargets: allowLegacyConversationAllowFromForGroup,
  });
  warnGroupAllowlistMisconfigOnce({
    groupPolicy,
    hasGroupAllowFrom: effectiveGroupAllowFrom.length > 0,
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });
  const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
  const catchupCfg = resolveCatchupConfig(imessageCfg.catchup);
  const includeAttachments = imessageCfg.includeAttachments ?? false;
  const mediaMaxBytes = (imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;
  const cliPath = imessageCfg.cliPath ?? "imsg";
  const dbPath = imessageCfg.dbPath;
  const probeTimeoutMs = imessageCfg.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;
  const attachmentRoots = resolveIMessageAttachmentRoots({
    cfg,
    accountId: accountInfo.accountId,
  });
  const remoteAttachmentRoots = resolveIMessageRemoteAttachmentRoots({
    cfg,
    accountId: accountInfo.accountId,
  });

  const remoteHost = await resolveIMessageRemoteHost({
    cliPath,
    remoteHost: imessageCfg.remoteHost,
  });
  const sendTyping = (target: string, isTyping: boolean, client?: IMessageRpcClient) =>
    sendIMessageTyping(target, isTyping, {
      cfg,
      accountId: accountInfo.accountId,
      cliPath,
      dbPath,
      remoteHost,
      ...(client ? { client } : {}),
    });
  const logTypingError = (action: "start" | "stop", target: string, error: unknown) =>
    logTypingFailure({ log: logVerbose, channel: "imessage", action, target, error });
  let staleBacklogSuppressed = 0;
  const loggedThrottledDropDiagnostics = createIMessageThrottledDropDiagnosticCache();

  // Capture local MAX(ROWID) before probing: it caps replay and separates recovery
  // from fresh-rowid Push backlog. Remote bridges lack this boundary and use the live age fence.
  const watchSourceDbPath = resolveIMessageChatDbLookupPath({ cliPath, dbPath, remoteHost });
  const recoveryBoundaryRowid = watchSourceDbPath
    ? await resolveIMessageStartupRowidWatermark(watchSourceDbPath)
    : null;
  // Scope the cursor to the resolved database so a dbPath/remoteHost change
  // starts from the new DB's watermark instead of a stale high-water (#99638).
  const recoveryCursorDbIdentity = resolveIMessageRecoveryCursorDbIdentity({
    cliPath,
    dbPath,
    remoteHost,
  });
  const recoveryCursorRowid = await loadIMessageRecoveryCursor(
    accountInfo.accountId,
    recoveryCursorDbIdentity,
    { migrateLegacyCatchup: !catchupCfg.enabled, watermarkRowid: recoveryBoundaryRowid },
  );
  const reconciledWatchSinceRowid = catchupCfg.enabled
    ? null
    : recoveryCursorRowid !== null
      ? recoveryBoundaryRowid !== null
        ? Math.max(recoveryCursorRowid, recoveryBoundaryRowid - IMESSAGE_RECOVERY_MAX_ROWS)
        : recoveryCursorRowid
      : recoveryBoundaryRowid;
  // imsg reserves cursor 0 for a subscribe-time MAX(ROWID) self-fence. Use the
  // exclusive cursor before SQLite's first generated ROWID instead.
  const watchSinceRowid = reconciledWatchSinceRowid === 0 ? -1 : reconciledWatchSinceRowid;

  let latestAdvancedRecoveryCursorRowid = recoveryCursorRowid ?? -1;
  const durableRecoveryCursorRowids = new Set<number>();
  const failedRecoveryCursorRowids = new Set<number>();

  function minSetValue(values: ReadonlySet<number>): number | null {
    let min: number | null = null;
    for (const value of values) {
      min = min === null ? value : Math.min(min, value);
    }
    return min;
  }

  async function advanceRecoveryCursorAfterDurableEnqueue(rowid: number): Promise<void> {
    if (catchupCfg.enabled) {
      return;
    }
    failedRecoveryCursorRowids.delete(rowid);
    durableRecoveryCursorRowids.add(rowid);
    const maxDurableRowid = Math.max(...durableRecoveryCursorRowids);
    const holdFloor = minSetValue(failedRecoveryCursorRowids);
    const nextCursorRowid =
      holdFloor !== null && maxDurableRowid >= holdFloor ? holdFloor - 1 : maxDurableRowid;

    if (nextCursorRowid >= 0 && nextCursorRowid > latestAdvancedRecoveryCursorRowid) {
      await advanceIMessageRecoveryCursor(
        accountInfo.accountId,
        recoveryCursorDbIdentity,
        nextCursorRowid,
      );
      latestAdvancedRecoveryCursorRowid = nextCursorRowid;
      for (const durableRowid of durableRecoveryCursorRowids) {
        if (durableRowid <= nextCursorRowid) {
          durableRecoveryCursorRowids.delete(durableRowid);
        }
      }
    }
  }

  function holdRecoveryCursorBeforeFailedEnqueue(rowid: number | null): void {
    if (catchupCfg.enabled || rowid === null || rowid <= latestAdvancedRecoveryCursorRowid) {
      return;
    }
    failedRecoveryCursorRowids.add(rowid);
  }

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<{
    message: IMessagePayload;
    ingressLifecycle?: IMessageIngressLifecycle;
  }>({
    cfg,
    channel: "imessage",
    resolveDebounceMs: () => resolveInboundDebounceMs({ cfg: readConfig(), channel: "imessage" }),
    buildKey: (entry) => {
      const msg = entry.message;
      const sender = msg.sender?.trim();
      if (!sender) {
        return null;
      }
      const conversationId =
        msg.chat_id != null
          ? `chat:${msg.chat_id}`
          : (msg.chat_guid ?? msg.chat_identifier ?? "unknown");

      return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const msg = entry.message;
      if (resolveIMessageReactionContext(msg, (msg.text ?? "").trim())) {
        return false;
      }
      // From-me messages are cached, not processed — never debounce.
      if (msg.is_from_me === true) {
        return false;
      }

      // General same-sender inbound debounce: text-only, no control commands,
      // no media. Off by default unless messages.inbound is configured.
      return shouldDebounceTextInbound({
        text: msg.text,
        cfg,
        hasMedia: Boolean(
          msg.attachments?.some((attachment) => !isIMessagePluginPayloadAttachment(attachment)),
        ),
      });
    },
    onFlush: (entries, createFlush) => {
      const { lifecycle, settle, abandon } = fanInChannelIngressLifecycles(
        entries.flatMap((entry) => (entry.ingressLifecycle ? [entry.ingressLifecycle] : [])),
      );
      return createFlush({
        lifecycle,
        dispatch: async (admissionLifecycle) => {
          if (entries.length === 0) {
            return;
          }
          try {
            if (admissionLifecycle.abortSignal.aborted) {
              await abandon();
              return;
            }
            const combined =
              entries.length === 1
                ? expectDefined(entries[0], "single iMessage dispatch entry").message
                : combineIMessagePayloads(entries.map((entry) => entry.message));
            if (entries.length > 1 && shouldLogVerbose()) {
              const text = combined.text ?? "";
              const preview = sliceUtf16Safe(text, 0, 50);
              const ellipsis = text.length > 50 ? "..." : "";
              logVerbose(
                `[imessage] merged ${entries.length} debounced messages: "${preview}${ellipsis}"`,
              );
            }
            await handleMessageNow(combined, admissionLifecycle);
            await settle();
          } catch (err) {
            await abandon();
            runtime.error?.(`imessage: inbound dispatch failed: ${String(err)}`);
          }
        },
      });
    },
    onError: (err) => {
      runtime.error?.(`imessage debounce flush failed: ${String(err)}`);
    },
  });

  let client: IMessageRpcClient | undefined;
  let detachAbortHandler = () => {};
  let liveCatchupCursorAdvanceEnabled = false;
  let startupCatchupInProgress = false;
  const pendingLiveCatchupCursorAdvances: Array<{ lastSeenMs: number; lastSeenRowid: number }> = [];
  const getActiveClient = () => {
    if (!client) {
      throw new Error("imessage monitor client not initialized");
    }
    return client;
  };

  async function repairMessageConversationAnchor(
    message: IMessagePayload,
  ): Promise<IMessagePayload | null> {
    return await repairIMessageConversationAnchor({
      client: getActiveClient(),
      message,
      runtime,
    });
  }

  function resolveLiveCatchupCursor(
    message: IMessagePayload,
  ): { lastSeenMs: number; lastSeenRowid: number } | null {
    const rowid = typeof message.id === "number" && Number.isFinite(message.id) ? message.id : null;
    const dateMs =
      typeof message.created_at === "string" ? Date.parse(message.created_at) : Number.NaN;
    if (rowid === null || !Number.isFinite(dateMs)) {
      return null;
    }
    return { lastSeenMs: dateMs, lastSeenRowid: rowid };
  }

  async function maybeAdvanceLiveCatchupCursor(message: IMessagePayload): Promise<void> {
    if (!catchupCfg.enabled) {
      return;
    }
    const cursor = resolveLiveCatchupCursor(message);
    if (!cursor) {
      return;
    }
    if (!liveCatchupCursorAdvanceEnabled) {
      if (startupCatchupInProgress) {
        pendingLiveCatchupCursorAdvances.push(cursor);
      }
      return;
    }
    try {
      await advanceIMessageCatchupCursor(accountInfo.accountId, cursor, catchupCfg);
    } catch (err) {
      runtime.error?.(`imessage catchup: failed to advance live cursor: ${String(err)}`);
    }
  }

  async function flushPendingLiveCatchupCursorAdvances(): Promise<void> {
    for (const cursor of pendingLiveCatchupCursorAdvances.splice(0)) {
      try {
        await advanceIMessageCatchupCursor(accountInfo.accountId, cursor, catchupCfg);
      } catch (err) {
        runtime.error?.(`imessage catchup: failed to advance pending live cursor: ${String(err)}`);
      }
    }
  }

  const pollCommentFolder = createPollCommentFolder();

  function resolveIMessageInboundBodyText(message: IMessagePayload) {
    // Native poll balloons carry only a 0xFFFD placeholder in `text`; render the
    // decoded poll (question/options/votes) so the agent sees the actual poll.
    const pollBody = message.poll
      ? renderIMessagePollBody(message.poll, message.sender, {
          preferOptionId: Boolean(remoteHost),
        })
      : null;
    const messageText = (pollBody ?? message.text ?? "").trim();
    const attachments = includeAttachments ? (message.attachments ?? []) : [];
    const effectiveAttachmentRoots = remoteHost ? remoteAttachmentRoots : attachmentRoots;
    // Apple rich-link previews are opaque plugin payloads; the useful URL stays
    // in message text. Treating them as media creates phantom attachments and
    // incorrectly bypasses text-only inbound debounce.
    const mediaCandidates = attachments.filter(
      (entry) => !isIMessagePluginPayloadAttachment(entry),
    );
    const mediaFacts = mediaCandidates.map((attachment): ChannelInboundMediaInput => {
      const contentType = attachment.mime_type?.trim() || undefined;
      return { contentType, kind: kindFromMime(contentType) ?? "unknown" };
    });
    const rawMediaAttachments = mediaCandidates.map((attachment, index) => {
      const fact = mediaFacts[index] ?? { kind: "unknown" as const };
      const attachmentPath = attachment.original_path?.trim();
      if (!attachmentPath || attachment.missing) {
        return fact;
      }
      if (!isInboundPathAllowed({ filePath: attachmentPath, roots: effectiveAttachmentRoots })) {
        logVerbose(
          `imessage: dropping inbound attachment outside allowed roots: ${attachmentPath}`,
        );
        return fact;
      }
      return { ...fact, path: attachmentPath };
    });
    return {
      messageText,
      bodyText: messageText,
      mediaFacts,
      mediaCandidates,
      rawMediaAttachments,
      effectiveAttachmentRoots,
    };
  }

  async function handleMessageNow(
    rawMessage: IMessagePayload,
    ingressLifecycle?: IMessageIngressLifecycle,
  ) {
    const message = await repairMessageConversationAnchor(rawMessage);
    if (!message) {
      return;
    }

    // Fold only the near-simultaneous caption; later replies remain ordinary discussion.
    const pollFoldAtMs = message.created_at ? Date.parse(message.created_at) : Number.NaN;
    if (message.poll) {
      pollCommentFolder.rememberPoll(message.guid, pollFoldAtMs, message.sender);
    } else if (
      message.reply_to_guid != null &&
      pollCommentFolder.isPollComment(message.reply_to_guid, pollFoldAtMs, message.sender)
    ) {
      logVerbose(
        "imessage: folding poll comment (inline reply sent with a poll) into the poll; not delivering standalone",
      );
      return;
    }

    const {
      messageText,
      bodyText,
      mediaFacts,
      mediaCandidates,
      rawMediaAttachments,
      effectiveAttachmentRoots,
    } = resolveIMessageInboundBodyText(message);

    const storeAllowFrom = await readChannelAllowFromStore(
      "imessage",
      process.env,
      accountInfo.accountId,
    ).catch(() => []);
    const isQuestionReaction = hasIMessageQuestionReactionTarget({
      accountId: accountInfo.accountId,
      message,
      bodyText,
    });
    const decision = await resolveIMessageInboundDecision({
      cfg,
      accountId: accountInfo.accountId,
      message,
      opts,
      messageText,
      bodyText,
      mediaFacts,
      allowFrom,
      groupAllowFrom,
      allowLegacyConversationAllowFromForGroup,
      groupPolicy,
      dmPolicy,
      storeAllowFrom,
      historyLimit,
      groupHistories,
      echoCache: sentMessageCache,
      selfChatCache,
      reactionNotifications: isQuestionReaction ? "all" : imessageCfg.reactionNotifications,
      logVerbose,
    });

    const chatId = message.chat_id ?? undefined;
    const senderForKey = (message.sender ?? "").trim();
    const conversationKey = chatId != null ? `group:${chatId}` : `dm:${senderForKey}`;
    const rateLimitKey = `${accountInfo.accountId}:${conversationKey}`;

    if (decision.kind === "drop") {
      // Count reflected agent content, not ordinary own-send or self-chat dedupe
      // rows: counting those benign drops mutes legitimate conversation bursts.
      const isLoopDrop =
        decision.reason === "echo" || decision.reason === "reflected assistant content";
      if (isLoopDrop) {
        loopRateLimiter.record(rateLimitKey);
      }
      if (IMESSAGE_DIAGNOSTIC_DROP_REASONS.has(decision.reason)) {
        const messageId =
          typeof message.id === "number" || typeof message.id === "string"
            ? String(message.id)
            : "unknown";
        const mentionHint =
          decision.reason === "no mention"
            ? ` Mention the agent (default patterns come from its identity name/emoji), or set ${groupsConfigPath}["${message.chat_id}"].requireMention=false. Preserve existing groups entries; when adding the first groups map, include "*": {} to keep other chats admitted.`
            : "";
        const diagnostic =
          `imessage: dropped inbound message account=${accountInfo.accountId} reason=${JSON.stringify(decision.reason)} ` +
          `chat_id=${message.chat_id ?? "unknown"} group=${message.is_group === true} ` +
          `message_id=${messageId} guid=${message.guid ? "present" : "missing"} ` +
          `created_at=${message.created_at ?? "unknown"}${mentionHint}`;
        const throttleKey = `${rateLimitKey}:${decision.reason}`;
        const shouldThrottleDiagnostic = IMESSAGE_THROTTLED_DIAGNOSTIC_DROP_REASONS.has(
          decision.reason,
        );
        if (!shouldThrottleDiagnostic || !loggedThrottledDropDiagnostics.check(throttleKey)) {
          runtime.log?.(warn(diagnostic));
        }
      }
      if (decision.reason === "group id not in allowlist") {
        warnGroupAllowlistDropPerChatOnce({
          accountId: accountInfo.accountId,
          chatId: message.chat_id ?? undefined,
          log: (msg) => runtime.log?.(warn(msg)),
        });
      }
      return;
    }

    // Catch amplification that escaped the primary guards, with a visible per-chat warning.
    if (decision.kind === "dispatch" && loopRateLimiter.isRateLimited(rateLimitKey)) {
      if (!loggedThrottledDropDiagnostics.check(`${rateLimitKey}:rate-limited`)) {
        const conversationKind = chatId != null ? "group" : "dm";
        const diagnosticConversationKey = `${conversationKind}:${redactIdentifier(conversationKey)}`;
        runtime.log?.(
          warn(
            `[imessage:${accountInfo.accountId}] Suppressing inbound from ${diagnosticConversationKey}: echo loop detected (rate limiter tripped)`,
          ),
        );
      }
      return;
    }

    if (decision.kind === "pairing") {
      const sender = (message.sender ?? "").trim();
      if (!sender) {
        return;
      }
      await createChannelPairingChallengeIssuer({
        channel: "imessage",
        accountId: accountInfo.accountId,
        upsertPairingRequest: async ({ id, meta }) =>
          await upsertChannelPairingRequest({
            channel: "imessage",
            id,
            accountId: accountInfo.accountId,
            meta,
          }),
      })({
        senderId: decision.senderId,
        senderIdLine: `Your iMessage sender id: ${decision.senderId}`,
        meta: {
          sender: decision.senderId,
          chatId: chatId ? String(chatId) : undefined,
        },
        onCreated: () => {
          logVerbose(`imessage pairing request sender=${decision.senderId}`);
        },
        sendPairingReply: async (text) => {
          await sendMessageIMessage(sender, text, {
            config: cfg,
            client: getActiveClient(),
            maxBytes: mediaMaxBytes,
            accountId: accountInfo.accountId,
            ...(chatId ? { chatId } : {}),
          });
        },
        onReplyError: (err) => {
          runtime.error?.(`imessage pairing reply failed for ${decision.senderId}: ${String(err)}`);
        },
      });
      return;
    }

    if (decision.kind === "reaction") {
      if (
        await maybeResolveIMessageQuestionReaction({
          cfg,
          accountId: accountInfo.accountId,
          message,
          bodyText,
          senderId: decision.senderNormalized,
          logDebug: logVerbose,
        })
      ) {
        return;
      }
      enqueueIMessageReactionSystemEvent({ decision, runtime, logVerbose });
      return;
    }

    if (decision.bindingResolution) {
      const readiness = await ensureConfiguredBindingRouteReady({
        cfg,
        bindingResolution: decision.bindingResolution,
      });
      if (!readiness.ok) {
        runtime.error?.(
          `imessage: dropped inbound message; configured ACP binding unavailable for ${decision.bindingResolution.record.conversation.conversationId}: ${readiness.error}`,
        );
        return;
      }
    }

    const storePath = resolveStorePath(cfg.session?.store, {
      agentId: decision.route.agentId,
    });
    // A stall invalidates capabilities; re-probing here restores typing/read after recovery.
    const privateApiStatus = await probeIMessagePrivateApi(cliPath, probeTimeoutMs);
    const supportsTyping = imessageRpcSupportsMethod(privateApiStatus, "typing");
    const supportsRead = imessageRpcSupportsMethod(privateApiStatus, "read");
    if (privateApiStatus.available) {
      if (!supportsTyping || !supportsRead) {
        warnIfImsgUpgradeNeeded.fireOnce(privateApiStatus.rpcMethods, runtime);
      }
    }
    const configuredTypingMode =
      resolveAgentConfig(cfg, decision.route.agentId)?.typingMode ??
      cfg.agents?.defaults?.typingMode;
    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: getSessionEntry({ storePath, sessionKey: decision.route.sessionKey }),
      sessionKey: decision.route.sessionKey,
      channel: "imessage",
      chatType: decision.isGroup ? "group" : "direct",
    });
    const shouldUseDirectToolTypingOptions =
      !decision.isGroup &&
      sendPolicy !== "deny" &&
      (configuredTypingMode === undefined || configuredTypingMode === "instant");
    const shouldStartDirectTyping = supportsTyping && shouldUseDirectToolTypingOptions;
    const earlyDirectTypingService =
      resolveIMessageDirectChatService(imessageCfg.service, decision.chatGuid) ?? "auto";
    const earlyDirectTypingTarget = shouldStartDirectTyping
      ? `${earlyDirectTypingService}:${decision.sender}`
      : undefined;
    let stopEarlyDirectTyping: (() => void) | undefined;
    if (earlyDirectTypingTarget) {
      // Start channel-native feedback before the expensive history/context/model
      // path. Use a short-lived client so a slow typing RPC cannot block the
      // monitor client's watch stream. Stop is sequenced after start so fast
      // command replies cannot leave a late true after typing:false.
      const earlyDirectTypingStarted = sendTyping(earlyDirectTypingTarget, true).then(
        () => true,
        (err: unknown) => {
          logTypingError("start", earlyDirectTypingTarget, err);
          return false;
        },
      );
      let earlyTypingStopQueued = false;
      stopEarlyDirectTyping = () => {
        if (earlyTypingStopQueued) {
          return;
        }
        earlyTypingStopQueued = true;
        void earlyDirectTypingStarted
          .then(async (started) => {
            if (!started) {
              return;
            }
            await sendTyping(earlyDirectTypingTarget, false);
          })
          .catch((err: unknown) => {
            logTypingError("stop", earlyDirectTypingTarget, err);
          });
      };
    }
    const staged = remoteHost
      ? {
          attachments: rawMediaAttachments,
          unavailableCount: rawMediaAttachments.filter((attachment) => !attachment.path).length,
        }
      : await stageIMessageAttachments(mediaCandidates, {
          maxBytes: mediaMaxBytes,
          allowedRoots: effectiveAttachmentRoots,
          deps: { logVerbose },
        });
    const mediaAttachments = staged.attachments;
    const unavailableCount = staged.unavailableCount;
    const contextDecision =
      unavailableCount > 0
        ? {
            ...decision,
            agentBodyText: formatInboundMediaUnavailableText({
              body: messageText,
              notice: `[imessage ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]`,
            }),
          }
        : decision;
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: decision.route.sessionKey,
    });
    const dmHistoryLimit = !decision.isGroup
      ? resolveIMessageDmHistoryLimit({
          config: imessageCfg,
          sender: decision.sender,
          senderNormalized: decision.senderNormalized,
        })
      : 0;
    const dmHistory =
      !decision.isGroup && dmHistoryLimit > 0 && !previousTimestamp
        ? await resolveIMessageDmHistoryContext({
            client: getActiveClient(),
            message,
            senderNormalized: decision.senderNormalized,
            limit: dmHistoryLimit,
            envelopeOptions: resolveEnvelopeFormatOptions(cfg),
            logVerbose,
          })
        : undefined;
    // SAFETY: Gateway startup supplies the full plugin channel runtime; the surface type is the minimal external view.
    const pluginChannelRuntime = opts.channelRuntime as PluginRuntime["channel"] | undefined;
    const { ctxPayload, chatTarget, imessageTo } = await buildIMessageInboundContext({
      cfg,
      accountService: imessageCfg.service,
      decision: contextDecision,
      message,
      previousTimestamp,
      remoteHost,
      historyLimit,
      groupHistories,
      dmHistory,
      buildContext: pluginChannelRuntime?.inbound.buildContext,
      media: {
        facts: mediaAttachments,
      },
    });

    const updateTarget = chatTarget || imessageTo;
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom,
      normalizeEntry: normalizeIMessageHandle,
    });
    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(ctxPayload.Body ?? "", 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${
          (ctxPayload.Body ?? "").length
        } preview="${preview}"`,
      );
    }

    const sendReadReceipts = imessageCfg.sendReadReceipts !== false;
    const typingTarget = ctxPayload.To;
    // The read RPC has no service argument, so preserve the inbound direct
    // conversation through its exact chat GUID instead of a bare handle.
    const readTarget =
      !decision.isGroup && decision.chatGuid ? `chat_guid:${decision.chatGuid}` : typingTarget;

    if (supportsRead && sendReadReceipts && readTarget) {
      // Detached, short-lived RPC keeps slow read receipts off the dispatch/watch path.
      void markIMessageChatRead(readTarget, {
        cfg,
        accountId: accountInfo.accountId,
        cliPath,
        dbPath,
        remoteHost,
      }).catch((err: unknown) => {
        runtime.error?.(`imessage: mark read failed: ${String(err)}`);
      });
    }

    const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
      cfg,
      agentId: decision.route.agentId,
      channel: "imessage",
      accountId: decision.route.accountId,
      typing:
        supportsTyping && typingTarget
          ? {
              start: async () => {
                await sendTyping(typingTarget, true, getActiveClient());
              },
              stop: async () => {
                await sendTyping(typingTarget, false, getActiveClient());
              },
              // Keep the native typing bubble alive through long tool chains.
              // The dispatcher idle path below still owns teardown on final,
              // error, abort, or monitor shutdown.
              keepaliveIntervalMs: IMESSAGE_TYPING_KEEPALIVE_INTERVAL_MS,
              maxDurationMs: IMESSAGE_TYPING_KEEPALIVE_MAX_DURATION_MS,
              onStartError: (err) => logTypingError("start", typingTarget, err),
              onStopError: (err) => logTypingError("stop", typingTarget, err),
            }
          : undefined,
    });

    const dispatcherOptions = {
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
    };
    const delivery: ChannelInboundTurnPlan["delivery"] = {
      durable: ctxPayload.To
        ? {
            to: ctxPayload.To,
            deps: {
              imessage: createIMessageEchoCachingSend({
                accountId: accountInfo.accountId,
                sentMessageCache,
              }),
            },
          }
        : false,
      observeMessageSent: true,
      deliver: async (payload: Parameters<typeof deliverIMessageReply>[0]["payload"]) => {
        const target = ctxPayload.To;
        if (!target) {
          runtime.error?.(danger("imessage: missing delivery target"));
          return {
            visibleReplySent: false,
            suppression: { reason: "no_visible_result" },
          } as const;
        }
        return await deliverIMessageReply({
          cfg,
          payload,
          target,
          accountId: accountInfo.accountId,
          runtime,
          maxBytes: mediaMaxBytes,
          textLimit,
          sentMessageCache,
        });
      },
      onError: (err, info) => {
        runtime.error?.(danger(`imessage ${info.kind} reply failed: ${String(err)}`));
      },
    };
    let directTypingController: IMessageTypingController | undefined;
    const startDirectToolTyping = async () => {
      await directTypingController?.startTypingLoop();
      return false;
    };
    const directToolTypingOptions = shouldUseDirectToolTypingOptions
      ? ({
          // Native typing stays active even while text progress is hidden or source-suppressed.
          suppressDefaultToolProgressMessages: true,
          allowToolLifecycleWhenProgressHidden: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onTypingController: (typing: IMessageTypingController) => {
            directTypingController = typing;
          },
          // Keep the channel-owned progress lane present even when private-API
          // typing is unavailable. Fast-mode notices are then consumed here
          // instead of falling back to a durable iMessage bubble.
          onToolResult: startDirectToolTyping,
          ...(supportsTyping ? { onToolStart: startDirectToolTyping } : {}),
        } as const)
      : {};
    const configuredBlockStreaming = resolveChannelStreamingBlockEnabled(accountInfo.config);
    const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
      route: decision.route,
      sessionKey: decision.route.sessionKey,
    });

    await runChannelInboundEvent({
      channel: "imessage",
      accountId: decision.route.accountId,
      raw: decision,
      adapter: {
        ingest: () => ({
          id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
          timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : undefined,
          rawText: ctxPayload.RawBody ?? "",
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: decision,
        }),
        resolveTurn: () => ({
          cfg,
          channel: "imessage",
          accountId: decision.route.accountId,
          route: {
            agentId: decision.route.agentId,
            sessionKey: decision.route.sessionKey,
          },
          ctxPayload,
          // Forward the owning runtime's bound dispatcher into the turn plan; never invoked here.
          dispatchReplyFromConfig: pluginChannelRuntime?.reply?.dispatchReplyFromConfig,
          record: {
            updateLastRoute:
              !decision.isGroup && updateTarget
                ? {
                    sessionKey: inboundLastRouteSessionKey,
                    channel: "imessage",
                    to: updateTarget,
                    accountId: decision.route.accountId,
                    mainDmOwnerPin:
                      inboundLastRouteSessionKey === decision.route.mainSessionKey &&
                      pinnedMainDmOwner &&
                      decision.senderNormalized
                        ? {
                            ownerRecipient: pinnedMainDmOwner,
                            senderRecipient: decision.senderNormalized,
                            onSkip: ({ ownerRecipient, senderRecipient }) => {
                              logVerbose(
                                `imessage: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                              );
                            },
                          }
                        : undefined,
                  }
                : undefined,
            onRecordError: (err) => {
              logVerbose(`imessage: failed updating session meta: ${String(err)}`);
            },
          },
          history: {
            isGroup: decision.isGroup,
            historyKey: decision.historyKey,
            historyMap: groupHistories,
            limit: historyLimit,
          },
          delivery,
          dispatcherOptions: {
            ...dispatcherOptions,
            onSettled: () => stopEarlyDirectTyping?.(),
          },
          replyOptions: {
            ...(ingressLifecycle ? bindIngressLifecycleToReplyOptions(ingressLifecycle) : {}),
            disableBlockStreaming:
              typeof configuredBlockStreaming === "boolean" ? !configuredBlockStreaming : undefined,
            onModelSelected,
            ...directToolTypingOptions,
          },
        }),
        onFinalize: () => stopEarlyDirectTyping?.(),
      },
    });
  }

  const suppressStaleIngress = (
    message: IMessagePayload,
    receivedAt: number,
    provenance?: { catchup?: boolean },
  ): boolean => {
    const isRecoveryReplay =
      recoveryCursorRowid !== null &&
      recoveryBoundaryRowid !== null &&
      typeof message.id === "number" &&
      message.id <= recoveryBoundaryRowid;
    const staleThresholdMs = isRecoveryReplay
      ? IMESSAGE_RECOVERY_MAX_AGE_MS
      : IMESSAGE_STALE_INBOUND_THRESHOLD_MS;
    if (provenance?.catchup || !isStaleIMessageBacklog(message, receivedAt, staleThresholdMs)) {
      return false;
    }
    staleBacklogSuppressed += 1;
    runtime.log?.(
      warn(
        `imessage: suppressed stale inbound backlog account=${accountInfo.accountId} ` +
          `sent=${message.created_at ?? "unknown"} recovery=${isRecoveryReplay} ` +
          `(${staleBacklogSuppressed} suppressed since start)`,
      ),
    );
    return true;
  };

  const maybeHandleApprovalControl = async (message: IMessagePayload): Promise<boolean> => {
    if (
      await maybeResolveIMessageApprovalPollVote({
        cfg,
        accountId: accountInfo.accountId,
        message,
        gatewayRuntime: approvalGatewayRuntime,
      })
    ) {
      return true;
    }
    return await maybeResolveIMessageApprovalReaction({
      cfg,
      accountId: accountInfo.accountId,
      message,
      bodyText: resolveIMessageInboundBodyText(message).bodyText,
      gatewayRuntime: approvalGatewayRuntime,
      logVerboseMessage: logVerbose,
    });
  };

  const resolveApprovalControlConversation = (message: IMessagePayload) => {
    const sender = normalizeIMessageHandle((message.sender ?? "").trim());
    const destination = normalizeIMessageHandle((message.destination_caller_id ?? "").trim());
    const receivedSenderIsLocalFallback =
      message.is_from_me !== true && Boolean(sender) && sender === destination;
    const actorHandle =
      (receivedSenderIsLocalFallback ? "" : sender) ||
      (message.is_from_me === true ? destination : "");
    return actorHandle
      ? buildIMessageApprovalConversationKeyForInbound({
          chatGuid: message.chat_guid,
          chatIdentifier: message.chat_identifier,
          chatId: message.chat_id,
          isGroup: message.is_group,
          actorHandle,
        })
      : null;
  };

  const ingress = createIMessageDurableIngress({
    accountId: accountInfo.accountId,
    runtime,
    dispatchPriority: async (message, lifecycle, receivedAt, provenance) => {
      const bodyText = (message.text ?? "").trim();
      const isApprovalCommand = /^\/approve(?:@[^\s]+)?(?:\s|$)/i.test(bodyText);
      const isCandidate =
        isApprovalCommand ||
        message.poll?.kind === "vote" ||
        Boolean(resolveIMessageReactionContext(message, bodyText));
      if (!isCandidate) {
        return undefined;
      }
      if (suppressStaleIngress(message, receivedAt, provenance)) {
        return { kind: "completed" };
      }
      const repairedMessage = await repairMessageConversationAnchor(message);
      if (!repairedMessage) {
        return { kind: "completed" };
      }
      if (isApprovalCommand) {
        // Resolve approval commands through the ordinary authenticated command
        // pipeline, but ahead of the chat lane containing the run they release.
        await handleMessageNow(repairedMessage);
        return { kind: "completed" };
      }
      const conversation = resolveApprovalControlConversation(repairedMessage);
      while (true) {
        if (await maybeHandleApprovalControl(repairedMessage)) {
          return { kind: "completed" };
        }
        if (!conversation) {
          return undefined;
        }
        const waited = await iMessageApprovalControlBindings.wait({
          accountId: accountInfo.accountId,
          conversation,
          abortSignal: lifecycle.abortSignal,
        });
        if (!waited) {
          // The binding may have completed between the ownership check and
          // window lookup. Close that check-then-wait race before queueing.
          return (await maybeHandleApprovalControl(repairedMessage))
            ? { kind: "completed" }
            : undefined;
        }
      }
    },
    dispatch: async (message, ingressLifecycle, receivedAt, provenance) => {
      // Recovery rows get the wider age fence; explicit catchup uses its own age window.
      if (suppressStaleIngress(message, receivedAt, provenance)) {
        // Complete the claim so restart or catchup cannot reinterpret a suppressed live row.
        return { kind: "completed" };
      }
      const repairedMessage = await repairMessageConversationAnchor(message);
      if (!repairedMessage) {
        return { kind: "completed" };
      }
      // A candidate can arrive during the narrow send-to-binding window. If it
      // initially proved unowned and waited in the chat lane, recheck before
      // rendering it as ordinary inbound content.
      if (await maybeHandleApprovalControl(repairedMessage)) {
        return { kind: "completed" };
      }
      await inboundDebouncer.enqueue({
        message: repairedMessage,
        ingressLifecycle,
      });
      // Debounce owns the claim until its eventual flush adopts or abandons.
      return { kind: "deferred" };
    },
    onDurableEnqueue: async (facts) => {
      await advanceRecoveryCursorAfterDurableEnqueue(facts.rowid);
      await maybeAdvanceLiveCatchupCursor({ id: facts.rowid, created_at: facts.createdAt });
    },
    onDurableEnqueueFailure: (rowid) => {
      holdRecoveryCursorBeforeFailedEnqueue(rowid);
    },
  });

  await waitForTransportReady({
    label: "imsg rpc",
    timeoutMs: 30_000,
    logAfterMs: 10_000,
    logIntervalMs: 10_000,
    pollIntervalMs: 500,
    abortSignal: opts.abortSignal,
    runtime,
    check: async () => {
      const probe = await probeIMessage(probeTimeoutMs, {
        cliPath,
        dbPath,
        remoteHost,
        runtime,
      });
      if (probe.ok) {
        return { ok: true };
      }
      if (probe.fatal) {
        throw new Error(probe.error ?? "imsg rpc unavailable");
      }
      return { ok: false, error: probe.error ?? "unreachable" };
    },
  });

  if (opts.abortSignal?.aborted) {
    return;
  }
  const abort = opts.abortSignal;

  for (let attempt = 1; attempt <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (abort?.aborted) {
      return;
    }
    let attemptClient: IMessageRpcClient | undefined;
    let attemptDetachAbortHandler = () => {};
    let keepAttemptClient = false;
    try {
      attemptClient = await createIMessageRpcClient({
        cliPath,
        dbPath,
        remoteHost,
        runtime,
        onNotification: (msg) => {
          if (msg.method === "message") {
            void ingress.receive(msg.params).catch((err: unknown) => {
              runtime.error?.(`imessage: durable admission failed: ${String(err)}`);
            });
          } else if (msg.method === "error") {
            runtime.error?.(
              `imessage: watch error ${JSON.stringify(sanitizeIMessageWatchErrorPayload(msg.params))}`,
            );
          }
        },
      });
      let attemptSubscriptionId: number | null = null;
      attemptDetachAbortHandler = attachIMessageMonitorAbortHandler({
        abortSignal: abort,
        client: attemptClient,
        getSubscriptionId: () => attemptSubscriptionId,
      });
      // The pre-probe durable cursor replays startup/downtime rows. Without a cursor,
      // imsg self-fences at subscribe-time MAX(ROWID) and tails only new rows.
      const result = await attemptClient.request<{ subscription?: number }>(
        "watch.subscribe",
        {
          attachments: includeAttachments,
          include_reactions: true,
          ...(watchSinceRowid !== null ? { since_rowid: watchSinceRowid } : {}),
        },
        { timeoutMs: probeTimeoutMs },
      );
      attemptSubscriptionId = result?.subscription ?? null;
      opts.statusSink?.(channelReadyPatch());
      client = attemptClient;
      detachAbortHandler = attemptDetachAbortHandler;
      keepAttemptClient = true;
      break;
    } catch (err) {
      if (abort?.aborted) {
        return;
      }
      const retriable = isRetriableWatchSubscribeStartupError(err);
      const shouldRetry = attempt < WATCH_SUBSCRIBE_MAX_ATTEMPTS && retriable;
      const retry = shouldRetry ? ` retry_in_ms=${WATCH_SUBSCRIBE_RETRY_DELAY_MS}` : "";
      const failure =
        `imessage: watch.subscribe startup failed attempt=${attempt}/${WATCH_SUBSCRIBE_MAX_ATTEMPTS} ` +
        `account=${accountInfo.accountId} cliPath=${cliPath} ` +
        `dbPath=${dbPath ? "configured" : "default"} remoteHost=${remoteHost ? "configured" : "none"} ` +
        `timeoutMs=${probeTimeoutMs} since_rowid=${watchSinceRowid ?? "none"} ` +
        `attachments=${includeAttachments} include_reactions=true${retry}: ${String(err)}`;
      if (!shouldRetry) {
        opts.statusSink?.({
          connected: false,
          lifecycle: retriable ? "recovering" : "blocked",
          terminalDisconnect: retriable ? undefined : true,
          lastError: String(err),
        });
        runtime.error?.(danger(`imessage: monitor failed: ${failure}`));
        throw err;
      }
      opts.statusSink?.({
        connected: false,
        lifecycle: "recovering",
        lastError: String(err),
      });
      runtime.log?.(warn(failure));
      // Tear down the failed client before waiting so a slow subscribe attempt
      // cannot keep emitting notifications into the next retry window.
      attemptDetachAbortHandler();
      attemptDetachAbortHandler = () => {};
      await attemptClient?.stop();
      attemptClient = undefined;
      await sleepWithAbort(WATCH_SUBSCRIBE_RETRY_DELAY_MS, abort).catch((error: unknown) => {
        if (!abort?.aborted) {
          throw error;
        }
      });
      if (abort?.aborted) {
        return;
      }
    } finally {
      if (!keepAttemptClient) {
        attemptDetachAbortHandler();
        await attemptClient?.stop();
      }
    }
  }

  const activeClient = client;
  if (!activeClient || scheduler.signal.aborted) {
    detachAbortHandler();
    await activeClient?.stop();
    return;
  }
  ingress.start();

  // The lazy native approval adapter requires a live account runtime context.
  const approvalContextLease = opts.channelRuntime
    ? registerChannelRuntimeContext({
        channelRuntime: opts.channelRuntime,
        channelId: "imessage",
        accountId: accountInfo.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: { accountId: accountInfo.accountId },
        abortSignal: abort,
      })
    : undefined;
  const approvalScheduler = scheduler.scope();
  let nextDiscoveryAt = 0;
  approvalScheduler.schedule({
    id: "approval-reactions",
    delayMs: 0,
    everyMs: APPROVAL_REACTION_POLL_INTERVAL_MS,
    run: () => {
      const now = approvalScheduler.now();
      const allowRecentChatDiscovery = now >= nextDiscoveryAt;
      if (allowRecentChatDiscovery) {
        nextDiscoveryAt = now + APPROVAL_REACTION_DISCOVERY_INTERVAL_MS;
      }
      return pollPendingIMessageApprovalReactions({
        signal: approvalScheduler.signal,
        client: activeClient,
        cfg,
        accountId: accountInfo.accountId,
        allowRecentChatDiscovery,
        gatewayRuntime: approvalGatewayRuntime,
        logVerboseMessage: logVerbose,
      }).catch((err: unknown) => {
        logVerbose(`imessage: approval reaction poll failed: ${String(err)}`);
      });
    },
  });

  // Legacy opt-in catchup remains the compatibility path for users who
  // explicitly enabled it, including remote SSH setups where the gateway
  // cannot read chat.db for the always-on local startup cursor.
  if (catchupCfg.enabled && !abort?.aborted) {
    startupCatchupInProgress = true;
    try {
      const catchupSummary = await runIMessageCatchup({
        client: activeClient,
        accountId: accountInfo.accountId,
        config: catchupCfg,
        includeAttachments,
        dispatchPayload: async (_message, rawEnvelope) => {
          await ingress.receive(rawEnvelope, { catchup: true });
        },
        observeSkippedFromMePayload: (message) => {
          const { bodyText } = resolveIMessageInboundBodyText(message);
          rememberIMessageSkippedFromMeForSelfChatDedupe({
            accountId: accountInfo.accountId,
            message,
            bodyText,
            selfChatCache,
          });
        },
        runtime,
      });
      liveCatchupCursorAdvanceEnabled =
        catchupSummary.querySucceeded && catchupSummary.fullyCaughtUp;
      if (liveCatchupCursorAdvanceEnabled) {
        await flushPendingLiveCatchupCursorAdvances();
      } else {
        pendingLiveCatchupCursorAdvances.length = 0;
      }
    } catch (err) {
      pendingLiveCatchupCursorAdvances.length = 0;
      runtime.error?.(`imessage catchup: pass failed: ${String(err)}`);
    } finally {
      startupCatchupInProgress = false;
    }
  }

  try {
    await activeClient.waitForClose();
  } catch (err) {
    if (abort?.aborted) {
      return;
    }
    runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
    throw err;
  } finally {
    approvalScheduler.beginClose();
    approvalContextLease?.dispose();
    detachAbortHandler();
    await activeClient.stop();
    await approvalScheduler.stop();
    await ingress.stop();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
