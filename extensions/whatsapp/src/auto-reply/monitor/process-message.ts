// Whatsapp plugin module implements process message behavior.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  logAckFailure,
  removeAckReactionHandleAfterReply,
  type AckReactionHandle,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  runChannelInboundEvent,
  type CommandTurnContext,
} from "openclaw/plugin-sdk/channel-inbound";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createInternalHookEvent,
  deriveInboundMessageHookContext,
  fireAndForgetBoundedHook,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveBatchedReplyThreadingPolicy } from "openclaw/plugin-sdk/reply-reference";
import { getPrimaryIdentityId, getSelfIdentity, getSenderIdentity } from "../../identity.js";
import {
  resolveWhatsAppCommandAuthorized,
  resolveWhatsAppInboundPolicy,
} from "../../inbound-policy.js";
import { newConnectionId } from "../../reconnect.js";
import { formatError } from "../../session.js";
import {
  resolveWhatsAppDirectSystemPrompt,
  resolveWhatsAppGroupSystemPrompt,
} from "../../system-prompt.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog } from "../loggers.js";
import type { WebInboundMsg } from "../types.js";
import { elide } from "../util.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
  type GroupHistoryEntry,
} from "./inbound-context.js";
import {
  buildWhatsAppInboundContext,
  dispatchWhatsAppBufferedReply,
  resolveWhatsAppDmRouteTarget,
  resolveWhatsAppResponsePrefix,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { buildInboundLine } from "./message-line.js";
import {
  buildHistoryContextFromEntries,
  createChannelMessageReplyPipeline,
  formatInboundEnvelope,
  logVerbose,
  normalizeE164,
  resolveChannelContextVisibilityMode,
  resolveInboundSessionEnvelopeContext,
  resolvePinnedMainDmOwnerFromAllowlist,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
  shouldLogVerbose,
  type getChildLogger,
  type getReplyFromConfig,
  type HistoryEntry,
  type LoadConfigFn,
  type resolveAgentRoute,
} from "./runtime-api.js";
import {
  createWhatsAppStatusReactionController,
  type StatusReactionController,
} from "./status-reaction.js";

const VOROZHYLA_OWNER_E164 = "+2975666192";
const VOROZHYLA_ACTION_ROUTER = "/Users/amigolive/.openclaw/workspace/vorozhyla-action";
const VOROZHYLA_SERVICE_ROUTER =
  "/Users/amigolive/.openclaw/workspace/scripts/vorozhyla-incoming-router.py";
const VOROZHYLA_PERSONAL_ROUTER =
  "/Users/amigolive/.openclaw/workspace/scripts/vorozhyla-personal-router.py";
const VOROZHYLA_PAUSED_CONTACTS =
  "/Users/amigolive/.openclaw/workspace/vorozhyla/state/paused_contacts.json";
const VOROZHYLA_INTERCEPT_LOG =
  "/Users/amigolive/.openclaw/workspace/vorozhyla/logs/whatsapp-intercept.log";

function vorozhylaNormalizeE164(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("297")) return `+${cleaned}`;
  if (/^\d+$/.test(cleaned)) return `+297${cleaned}`;
  return cleaned;
}

function vorozhylaLog(action: string, data: Record<string, unknown>): void {
  try {
    mkdirSync("/Users/amigolive/.openclaw/workspace/vorozhyla/logs", { recursive: true });
    appendFileSync(
      VOROZHYLA_INTERCEPT_LOG,
      `${JSON.stringify({ time: new Date().toISOString(), action, data })}\n`,
    );
  } catch {
    // Never break WhatsApp because logging failed.
  }
}

function vorozhylaReadPausedContacts(): Record<string, unknown> {
  try {
    if (!existsSync(VOROZHYLA_PAUSED_CONTACTS)) return {};
    const parsed = JSON.parse(readFileSync(VOROZHYLA_PAUSED_CONTACTS, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function vorozhylaMessageBody(msg: unknown): string {
  const body = (msg as { body?: unknown })?.body;
  return typeof body === "string" ? body.trim() : "";
}

function vorozhylaShouldRunOwnerAction(body: string): boolean {
  const clean = body.trim();
  // "Vorozhyla, ..." — any owner command; router exits 3 if no action matched so AI still runs
  if (/^vorozhyla\s*[,:\-]?\s*\S+/i.test(clean)) return true;
  // PostNews pipeline — must never fall through to normal AI conversation
  if (/\bpost\s*news\b/i.test(clean)) return true;
  // Approval replies for pending PostNews
  if (/^(publish|approve|approved|publiceer|publica|confirm)$/i.test(clean)) return true;
  // URL-based news commands: /news https://... or news https://...
  if (/(^|\s)(\/bash\s+news|\/news|news)\s+https?:\/\//i.test(clean)) return true;
  return false;
}

async function maybeHandleVorozhylaWhatsAppIntercept(params: {
  msg: WebInboundMsg;
}): Promise<boolean> {
  const senderIdentity = getSenderIdentity(params.msg);
  const senderE164 = vorozhylaNormalizeE164(
    senderIdentity.e164 ??
      params.msg.senderE164 ??
      (params.msg as { sender?: { e164?: string } }).sender?.e164,
  );
  const body = vorozhylaMessageBody(params.msg);

  if (senderE164 === VOROZHYLA_OWNER_E164 && vorozhylaShouldRunOwnerAction(body)) {
    const result = spawnSync(VOROZHYLA_ACTION_ROUTER, [body], {
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

    // Exit code 3 means: no safe action matched. In that case, continue normal AI processing.
    if (result.status === 3) {
      vorozhylaLog("owner_action_no_match_continue", { senderE164, body });
      return false;
    }

    const replyText = output || `Vorozhyla action completed.`;
    vorozhylaLog("owner_action_executed", {
      senderE164,
      body,
      status: result.status,
      signal: result.signal,
      output: replyText.slice(0, 500),
    });

    await params.msg.reply(replyText.slice(0, 3500));
    return true;
  }

  if (senderE164 && senderE164 !== VOROZHYLA_OWNER_E164) {
    const paused = vorozhylaReadPausedContacts();

    if (Object.prototype.hasOwnProperty.call(paused, senderE164)) {
      const personalResult = spawnSync(VOROZHYLA_PERSONAL_ROUTER, ["record", senderE164, body], {
        encoding: "utf8",
        timeout: 25_000,
        maxBuffer: 1024 * 1024,
      });

      vorozhylaLog("paused_contact_blocked", {
        senderE164,
        body: body.slice(0, 500),
        personalStatus: personalResult.status,
        personalOutput: `${personalResult.stdout ?? ""}${personalResult.stderr ?? ""}`
          .trim()
          .slice(0, 300),
      });
      return true;
    }

    const leadResult = spawnSync(VOROZHYLA_SERVICE_ROUTER, [senderE164, body], {
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
    });

    const leadOutput = `${leadResult.stdout ?? ""}${leadResult.stderr ?? ""}`.trim();

    if (leadOutput.startsWith("__BLOCK__")) {
      vorozhylaLog("public_non_lead_blocked", {
        senderE164,
        body: body.slice(0, 500),
      });
      return true;
    }

    if (leadOutput && !leadOutput.startsWith("__PASS__")) {
      vorozhylaLog("public_auto_reply", {
        senderE164,
        body: body.slice(0, 500),
        status: leadResult.status,
        output: leadOutput.slice(0, 500),
      });

      await params.msg.reply(leadOutput.slice(0, 3500));
      return true;
    }
  }

  return false;
}

const WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

type WhatsAppMessageReceivedHookConfig = {
  pluginHooks?: {
    messageReceived?: boolean;
  };
  accounts?: Record<string, unknown>;
};

function readWhatsAppMessageReceivedHookOptIn(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const pluginHooks = (value as WhatsAppMessageReceivedHookConfig).pluginHooks;
  if (pluginHooks?.messageReceived === undefined) {
    return undefined;
  }
  return pluginHooks.messageReceived;
}

function shouldEmitWhatsAppMessageReceivedHooks(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId?: string;
}): boolean {
  const channelConfig = params.cfg.channels?.whatsapp as
    | WhatsAppMessageReceivedHookConfig
    | undefined;
  const accountConfig =
    params.accountId && channelConfig?.accounts
      ? channelConfig.accounts[params.accountId]
      : undefined;

  return (
    readWhatsAppMessageReceivedHookOptIn(accountConfig) ??
    readWhatsAppMessageReceivedHookOptIn(channelConfig) ??
    false
  );
}

function emitWhatsAppMessageReceivedHooks(params: {
  ctx: Awaited<ReturnType<typeof buildWhatsAppInboundContext>>;
  sessionKey: string;
}): void {
  const canonical = deriveInboundMessageHookContext(params.ctx);
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetBoundedHook(
      () =>
        hookRunner.runMessageReceived(
          toPluginMessageReceivedEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      "whatsapp: message_received plugin hook failed",
      undefined,
      WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
    );
  }
  fireAndForgetBoundedHook(
    () =>
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "received",
          params.sessionKey,
          toInternalMessageReceivedContext(canonical),
        ),
      ),
    "whatsapp: message_received internal hook failed",
    undefined,
    WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
  );
}

function emitWhatsAppMessageReceivedHooksIfEnabled(params: {
  cfg: ReturnType<LoadConfigFn>;
  ctx: Awaited<ReturnType<typeof buildWhatsAppInboundContext>>;
  accountId?: string;
  sessionKey: string;
}): void {
  if (
    !shouldEmitWhatsAppMessageReceivedHooks({
      cfg: params.cfg,
      accountId: params.accountId,
    })
  ) {
    return;
  }

  emitWhatsAppMessageReceivedHooks({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
}

function resolvePinnedMainDmRecipient(params: {
  cfg: ReturnType<LoadConfigFn>;
  allowFrom?: string[];
}): string | null {
  return resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: params.cfg.session?.dmScope,
    allowFrom: params.allowFrom,
    normalizeEntry: (entry) => normalizeE164(entry),
  });
}

export async function processMessage(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: WebInboundMsg;
  route: ReturnType<typeof resolveAgentRoute>;
  groupHistoryKey: string;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  connectionId: string;
  verbose: boolean;
  maxMediaBytes: number;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<typeof getChildLogger>;
  backgroundTasks: Set<Promise<unknown>>;
  rememberSentText: (
    text: string | undefined,
    opts: {
      combinedBody?: string;
      combinedBodySessionKey?: string;
      logVerboseMessage?: boolean;
    },
  ) => void;
  echoHas: (key: string) => boolean;
  echoForget: (key: string) => void;
  buildCombinedEchoKey: (p: { sessionKey: string; combinedBody: string }) => string;
  maxMediaTextChunkLimit?: number;
  groupHistory?: GroupHistoryEntry[];
  suppressGroupHistoryClear?: boolean;
  ackAlreadySent?: boolean;
  ackReaction?: AckReactionHandle | null;
  statusReactionController?: StatusReactionController | null;
  /** Pre-computed audio transcript from a caller-level preflight, used to avoid
   * re-transcribing the same voice note once per broadcast agent.
   * - string  → transcript obtained; use it directly, skip internal STT
   * - null    → preflight was attempted but failed / returned nothing; skip internal STT
   * - undefined (omitted) → caller did not attempt preflight; run internal STT as normal */
  preflightAudioTranscript?: string | null;
}) {
  if (await maybeHandleVorozhylaWhatsAppIntercept({ msg: params.msg })) {
    return;
  }

  const conversationId = params.msg.conversationId ?? params.msg.from;
  const self = getSelfIdentity(params.msg);
  const inboundPolicy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.route.accountId ?? params.msg.accountId,
    selfE164: self.e164 ?? null,
  });
  const account = inboundPolicy.account;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: account.accountId,
  });
  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
  });
  // Preflight audio transcription: transcribe voice notes before building the
  // inbound context so the agent receives the transcript instead of <media:audio>.
  // Mirrors the preflight step added for Telegram in #61008.
  // When the caller already performed transcription (e.g. on-message.ts before
  // broadcast fan-out) the pre-computed result is reused to avoid N STT calls
  // for N broadcast agents on the same voice note.
  // preflightAudioTranscript semantics:
  //   string    → transcript ready, use it
  //   null      → caller attempted but got nothing; skip internal STT to avoid retry
  //   undefined → caller did not attempt; run internal STT
  let audioTranscript: string | undefined = params.preflightAudioTranscript ?? undefined;
  const hasAudioBody =
    params.msg.mediaType?.startsWith("audio/") === true && params.msg.body === "<media:audio>";
  if (params.preflightAudioTranscript === undefined && hasAudioBody && params.msg.mediaPath) {
    try {
      const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
      audioTranscript = await transcribeFirstAudio({
        ctx: {
          MediaPaths: [params.msg.mediaPath],
          MediaTypes: params.msg.mediaType ? [params.msg.mediaType] : undefined,
          From: params.msg.from,
          To: params.msg.to,
          Provider: "whatsapp",
          Surface: "whatsapp",
          OriginatingChannel: "whatsapp",
          OriginatingTo: conversationId,
          AccountId: params.route.accountId,
        },
        cfg: params.cfg,
      });
    } catch {
      // Transcription failure is non-fatal: fall back to <media:audio> placeholder.
      if (shouldLogVerbose()) {
        logVerbose("whatsapp: audio preflight transcription failed, using placeholder");
      }
    }
  }

  // If we have a transcript, replace the agent-facing body so the agent sees the spoken text.
  // mediaPath and mediaType are intentionally preserved so that inboundAudio detection
  // (used by features such as messages.tts.auto: "inbound") still sees this as an
  // audio message. The transcript and transcribed media index are also stored on
  // context so downstream media understanding does not transcribe it again.
  const msgForAgent =
    audioTranscript !== undefined ? { ...params.msg, body: audioTranscript } : params.msg;

  let combinedBody = buildInboundLine({
    cfg: params.cfg,
    msg: msgForAgent,
    agentId: params.route.agentId,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  let shouldClearGroupHistory = false;
  const visibleGroupHistory =
    params.msg.chatType === "group"
      ? resolveVisibleWhatsAppGroupHistory({
          history: params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [],
          mode: contextVisibilityMode,
          groupPolicy: inboundPolicy.groupPolicy,
          groupAllowFrom: inboundPolicy.groupAllowFrom,
        })
      : undefined;

  if (params.msg.chatType === "group") {
    const history = visibleGroupHistory ?? [];
    if (history.length > 0) {
      const historyEntries: HistoryEntry[] = history.map((m) => ({
        sender: m.sender,
        body: m.body,
        timestamp: m.timestamp,
      }));
      combinedBody = buildHistoryContextFromEntries({
        entries: historyEntries,
        currentMessage: combinedBody,
        excludeLast: false,
        formatEntry: (entry) => {
          return formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: entry.body,
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          });
        },
      });
    }
    shouldClearGroupHistory = !(params.suppressGroupHistoryClear ?? false);
  }

  // Echo detection uses combined body so we don't respond twice.
  const combinedEchoKey = params.buildCombinedEchoKey({
    sessionKey: params.route.sessionKey,
    combinedBody,
  });
  if (params.echoHas(combinedEchoKey)) {
    logVerbose("Skipping auto-reply: detected echo for combined message");
    params.echoForget(combinedEchoKey);
    return false;
  }

  // When statusReactions.enabled, a StatusReactionController takes over lifecycle
  // signaling (queued → thinking → tool → done/error). The plain ackReaction is
  // skipped so the same message slot isn't used for two competing systems.
  const statusReactionController =
    params.statusReactionController ??
    (params.cfg.messages?.statusReactions?.enabled === true && !params.ackAlreadySent
      ? await createWhatsAppStatusReactionController({
          cfg: params.cfg,
          msg: params.msg,
          agentId: params.route.agentId,
          sessionKey: params.route.sessionKey,
          conversationId,
          verbose: params.verbose,
          accountId: account.accountId,
        })
      : null);

  if (statusReactionController && !params.statusReactionController) {
    void statusReactionController.setQueued();
  }

  // Send ack reaction immediately upon message receipt (post-gating). Callers
  // that do preflight work before processMessage can send it first and set
  // ackAlreadySent so slow STT does not delay user-visible receipt feedback.
  // Skip if the status reaction controller is handling lifecycle signaling.
  let ackReaction = params.ackReaction ?? null;
  if (!statusReactionController && !ackReaction && params.ackAlreadySent !== true) {
    ackReaction = await maybeSendAckReaction({
      cfg: params.cfg,
      msg: params.msg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      conversationId,
      verbose: params.verbose,
      accountId: account.accountId,
      info: params.replyLogger.info.bind(params.replyLogger),
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
  }

  const correlationId = params.msg.id ?? newConnectionId();
  params.replyLogger.info(
    {
      connectionId: params.connectionId,
      correlationId,
      from: params.msg.chatType === "group" ? conversationId : params.msg.from,
      to: params.msg.to,
      body: elide(combinedBody, 240),
      mediaType: params.msg.mediaType ?? null,
      mediaPath: params.msg.mediaPath ?? null,
    },
    "inbound web message",
  );

  const fromDisplay = params.msg.chatType === "group" ? conversationId : params.msg.from;
  const kindLabel = params.msg.mediaType ? `, ${params.msg.mediaType}` : "";
  whatsappInboundLog.info(
    `Inbound message ${fromDisplay} -> ${params.msg.to} (${params.msg.chatType}${kindLabel}, ${combinedBody.length} chars)`,
  );
  if (shouldLogVerbose()) {
    whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
  }

  const sender = getSenderIdentity(params.msg);
  const visibleReplyTo = resolveVisibleWhatsAppReplyContext({
    msg: params.msg,
    authDir: account.authDir,
    mode: contextVisibilityMode,
    groupPolicy: inboundPolicy.groupPolicy,
    groupAllowFrom: inboundPolicy.groupAllowFrom,
  });
  const dmRouteTarget = resolveWhatsAppDmRouteTarget({
    msg: params.msg,
    senderE164: sender.e164 ?? undefined,
    normalizeE164,
  });
  const shouldCheckCommandAuth = shouldComputeCommandAuthorized(params.msg.body, params.cfg);
  const isTextCommand = isControlCommandMessage(params.msg.body, params.cfg);
  const commandAuthorized = shouldCheckCommandAuth
    ? await resolveWhatsAppCommandAuthorized({
        cfg: params.cfg,
        msg: params.msg,
        policy: inboundPolicy,
      })
    : undefined;
  const commandTurn: CommandTurnContext = isTextCommand
    ? {
        kind: "text-slash",
        source: "text",
        authorized: Boolean(commandAuthorized),
        body: params.msg.body,
      }
    : {
        kind: "normal",
        source: "message",
        authorized: false,
        body: params.msg.body,
      };
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const responsePrefix = resolveWhatsAppResponsePrefix({
    cfg: params.cfg,
    agentId: params.route.agentId,
    isSelfChat: params.msg.chatType !== "group" && inboundPolicy.isSelfChat,
    pipelineResponsePrefix: replyPipeline.responsePrefix,
  });
  const replyThreading = resolveBatchedReplyThreadingPolicy(
    account.replyToMode ?? "off",
    params.msg.isBatched === true,
  );

  // Resolve combined conversation system prompt using the group or direct surface.
  const conversationSystemPrompt =
    params.msg.chatType === "group"
      ? resolveWhatsAppGroupSystemPrompt({
          accountConfig: account,
          groupId: conversationId,
        })
      : resolveWhatsAppDirectSystemPrompt({
          accountConfig: account,
          peerId: dmRouteTarget ?? params.msg.from,
        });

  const ctxPayload = await buildWhatsAppInboundContext({
    bodyForAgent: msgForAgent.body,
    combinedBody,
    commandBody: params.msg.body,
    commandAuthorized,
    commandTurn,
    conversationId,
    groupHistory: visibleGroupHistory,
    groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
    groupSystemPrompt: conversationSystemPrompt,
    msg: params.msg,
    rawBody: params.msg.body,
    route: params.route,
    sender: {
      id: getPrimaryIdentityId(sender) ?? undefined,
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
    },
    ...(audioTranscript !== undefined ? { transcript: audioTranscript } : {}),
    ...(audioTranscript !== undefined ? { mediaTranscribedIndexes: [0] } : {}),
    replyThreading,
    visibleReplyTo: visibleReplyTo ?? undefined,
  });
  emitWhatsAppMessageReceivedHooksIfEnabled({
    cfg: params.cfg,
    ctx: ctxPayload,
    accountId: params.route.accountId,
    sessionKey: params.route.sessionKey,
  });

  const pinnedMainDmRecipient = resolvePinnedMainDmRecipient({
    cfg: params.cfg,
    allowFrom: inboundPolicy.configuredAllowFrom,
  });
  updateWhatsAppMainLastRoute({
    backgroundTasks: params.backgroundTasks,
    cfg: params.cfg,
    ctx: ctxPayload,
    dmRouteTarget,
    pinnedMainDmRecipient,
    route: params.route,
    updateLastRoute: updateLastRouteInBackground,
    warn: params.replyLogger.warn.bind(params.replyLogger),
  });

  const turnResult = await runChannelInboundEvent({
    channel: "whatsapp",
    accountId: params.route.accountId,
    raw: params.msg,
    adapter: {
      ingest: () => ({
        id: params.msg.id ?? `${conversationId}:${Date.now()}`,
        timestamp: params.msg.timestamp,
        rawText: ctxPayload.RawBody ?? "",
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: params.msg,
      }),
      resolveTurn: () => ({
        channel: "whatsapp",
        accountId: params.route.accountId,
        routeSessionKey: params.route.sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession,
        record: {
          onRecordError: (err) => {
            params.replyLogger.warn(
              {
                error: formatError(err),
                storePath,
                sessionKey: params.route.sessionKey,
              },
              "failed updating session meta",
            );
          },
          trackSessionMetaTask: (task) => {
            trackBackgroundTask(params.backgroundTasks, task);
          },
        },
        runDispatch: () =>
          dispatchWhatsAppBufferedReply({
            cfg: params.cfg,
            connectionId: params.connectionId,
            context: ctxPayload,
            conversationId,
            deliverReply: deliverWebReply,
            groupHistories: params.groupHistories,
            groupHistoryKey: params.groupHistoryKey,
            maxMediaBytes: params.maxMediaBytes,
            maxMediaTextChunkLimit: params.maxMediaTextChunkLimit,
            msg: params.msg,
            onModelSelected,
            rememberSentText: params.rememberSentText,
            replyLogger: params.replyLogger,
            replyPipeline: {
              ...replyPipeline,
              responsePrefix,
            },
            replyResolver: params.replyResolver,
            route: params.route,
            shouldClearGroupHistory,
            statusReactionController,
          }),
      }),
    },
  });
  const didSendReply = turnResult.dispatched ? turnResult.dispatchResult : false;
  removeAckReactionHandleAfterReply({
    removeAfterReply: Boolean(params.cfg.messages?.removeAckAfterReply && didSendReply),
    ackReaction,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "whatsapp",
        target: `${params.msg.chatId ?? conversationId}/${params.msg.id ?? "unknown"}`,
        error: err,
      });
    },
  });
  return didSendReply;
}
