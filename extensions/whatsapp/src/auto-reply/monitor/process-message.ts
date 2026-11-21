import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import {
  type buildChannelInboundEventContext,
  type ChannelInboundTurnPlan,
  formatMediaPlaceholderText,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import { bindIngressLifecycleToReplyOptions } from "openclaw/plugin-sdk/channel-outbound";
import {
  createInternalHookEvent,
  deriveInboundMessageHookContext,
  fireAndForgetBoundedHook,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { formatAudioTranscriptForAgent } from "openclaw/plugin-sdk/media-understanding-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveBatchedReplyThreadingPolicy } from "openclaw/plugin-sdk/reply-reference";
import { getPrimaryIdentityId, getSelfIdentity, getSenderIdentity } from "../../identity.js";
import {
  resolveWhatsAppCommandAuthorized,
  resolveWhatsAppInboundPolicy,
} from "../../inbound-policy.js";
import type { WhatsAppInboundAdmission } from "../../inbound/admission.js";
import { resolveWhatsAppIngressLifecycle } from "../../inbound/ingress-lifecycle.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { formatError } from "../../session.js";
import { deliverWebReply } from "../deliver-reply.js";
import { whatsappInboundLog } from "../loggers.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { hasWhatsAppAudioBody, transcribeWhatsAppAudioMessage } from "./audio-preflight.js";
import {
  resolveVisibleWhatsAppGroupHistory,
  resolveVisibleWhatsAppReplyContext,
  type GroupHistoryEntry,
} from "./inbound-context.js";
import {
  buildWhatsAppInboundTransportContext,
  createWhatsAppReplyPlan,
  prepareWhatsAppInboundContext,
  resolveWhatsAppDmRouteTarget,
  updateWhatsAppMainLastRoute,
} from "./inbound-dispatch.js";
import { trackBackgroundTask, updateLastRouteInBackground } from "./last-route.js";
import { formatInboundEnvelope as formatWhatsAppInboundEnvelope } from "./message-line.runtime.js";
import {
  buildHistoryContextFromEntries,
  createChannelMessageReplyPipeline,
  formatInboundEnvelope,
  logVerbose,
  normalizeE164,
  resolveChannelContextVisibilityMode,
  resolveInboundSessionEnvelopeContextAsync,
  resolveIdentityNamePrefix,
  resolvePinnedMainDmOwnerFromAllowlist,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
  shouldLogVerbose,
  type getChildLogger,
  type getReplyFromConfig,
  type LoadConfigFn,
  type resolveAgentRoute,
} from "./runtime-api.js";
import {
  createWhatsAppStatusReactionController,
  type StatusReactionController,
} from "./status-reaction.js";

const WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

function mapWhatsAppIngressToTurnAdmission(ingress: WhatsAppInboundAdmission["ingress"]) {
  const reason = ingress.reasonCode;
  if (ingress.admission === "dispatch") {
    return { kind: "dispatch" as const, reason };
  }
  if (ingress.admission === "observe") {
    return { kind: "observeOnly" as const, reason };
  }
  if (ingress.admission === "skip") {
    return { kind: "handled" as const, reason };
  }
  return { kind: "drop" as const, reason, recordHistory: false };
}

export async function processMessage(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: AdmittedWebInboundMessage;
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
  groupHistory?: GroupHistoryEntry[];
  groupHistoryLimit?: number;
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
  buildContext?: typeof buildChannelInboundEventContext;
  dispatchReplyFromConfig?: NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]>;
}) {
  const admission = params.msg.admission;
  if (admission.ingress.admission !== "dispatch" && admission.ingress.admission !== "observe") {
    return false;
  }
  const conversationId = admission.conversation.id;
  const conversationKind = admission.conversation.kind;
  const self = getSelfIdentity(params.msg);
  const inboundPolicy = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.route.accountId ?? admission.accountId,
    selfE164: self.e164 ?? null,
  });
  const account = inboundPolicy.account;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: account.accountId,
  });
  const { storePath, envelopeOptions, previousTimestamp } =
    await resolveInboundSessionEnvelopeContextAsync({
      cfg: params.cfg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
    });
  // A caller's null result is a completed preflight, so broadcast agents must not retry it.
  let audioTranscript: string | undefined = params.preflightAudioTranscript ?? undefined;
  if (
    params.preflightAudioTranscript === undefined &&
    hasWhatsAppAudioBody(params.msg) &&
    params.msg.payload.media?.path
  ) {
    try {
      audioTranscript = await transcribeWhatsAppAudioMessage(
        params.cfg,
        params.msg,
        params.route.accountId,
      );
    } catch {
      // Transcription failure is non-fatal: keep the empty caption and structured audio fact.
      if (shouldLogVerbose()) {
        logVerbose("whatsapp: audio preflight transcription failed, keeping structured audio");
      }
    }
  }

  // Commands retain the original body; media facts and the transcript prevent duplicate STT.
  const msgForAgent: AdmittedWebInboundMessage =
    audioTranscript !== undefined
      ? {
          ...params.msg,
          payload: {
            ...params.msg.payload,
            body: formatAudioTranscriptForAgent(audioTranscript),
          },
        }
      : params.msg;
  const visibleReplyTo = resolveVisibleWhatsAppReplyContext({
    msg: params.msg,
    authDir: account.authDir,
    mode: contextVisibilityMode,
    groupPolicy: inboundPolicy.groupPolicy,
    groupAllowFrom: inboundPolicy.groupAllowFrom,
  });

  let replyContext: string | null = null;
  if (visibleReplyTo?.body) {
    const replySender =
      visibleReplyTo.sender?.label ?? visibleReplyTo.sender?.e164 ?? "unknown sender";
    const idPart = visibleReplyTo.id ? ` id:${visibleReplyTo.id}` : "";
    replyContext = `[Replying to ${replySender}${idPart}]\n${visibleReplyTo.body}\n[/Replying]`;
  }
  const envelopeSender = getSenderIdentity(msgForAgent);
  let combinedBody = formatWhatsAppInboundEnvelope({
    channel: "WhatsApp",
    from: conversationKind === "group" ? conversationId : conversationId.replace(/^whatsapp:/, ""),
    timestamp: msgForAgent.event.timestamp,
    body: `${msgForAgent.payload.body}${replyContext ? `\n\n${replyContext}` : ""}`,
    chatType: conversationKind,
    sender: {
      name: envelopeSender.name ?? undefined,
      e164: envelopeSender.e164 ?? undefined,
      id: getPrimaryIdentityId(envelopeSender) ?? undefined,
    },
    previousTimestamp,
    envelope: envelopeOptions,
    fromMe: msgForAgent.platform.fromMe,
  });
  const visibleGroupHistory =
    conversationKind === "group"
      ? resolveVisibleWhatsAppGroupHistory({
          history: params.groupHistory ?? params.groupHistories.get(params.groupHistoryKey) ?? [],
          mode: contextVisibilityMode,
          groupPolicy: inboundPolicy.groupPolicy,
          groupAllowFrom: inboundPolicy.groupAllowFrom,
          authDir: account.authDir,
        })
      : undefined;

  if (conversationKind === "group") {
    const history = visibleGroupHistory ?? [];
    if (history.length > 0) {
      combinedBody = buildHistoryContextFromEntries({
        entries: history,
        currentMessage: combinedBody,
        excludeLast: false,
        formatEntry: (entry) => {
          return formatInboundEnvelope({
            channel: "WhatsApp",
            from: conversationId,
            timestamp: entry.timestamp,
            body: [entry.body, formatMediaPlaceholderText(entry.media ?? [])]
              .filter(Boolean)
              .join("\n"),
            chatType: "group",
            senderLabel: entry.sender,
            envelope: envelopeOptions,
          });
        },
      });
    }
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
          verbose: params.verbose,
        })
      : null);

  if (statusReactionController && !params.statusReactionController) {
    void statusReactionController.setQueued();
  }

  // Send ack reaction immediately upon message receipt (post-gating). Callers
  // that do preflight work before processMessage can send it first and set
  // ackAlreadySent so slow STT does not delay user-visible receipt feedback.
  // Skip if the status reaction controller is handling lifecycle signaling.
  if (!statusReactionController && !params.ackReaction && params.ackAlreadySent !== true) {
    await maybeSendAckReaction({
      cfg: params.cfg,
      msg: params.msg,
      agentId: params.route.agentId,
      sessionKey: params.route.sessionKey,
      verbose: params.verbose,
      warn: params.replyLogger.warn.bind(params.replyLogger),
    });
  }

  const kindLabel = params.msg.payload.media?.type ? `, ${params.msg.payload.media?.type}` : "";
  whatsappInboundLog.info(
    `Inbound message ${conversationId} -> ${params.msg.platform.recipientJid} (${conversationKind}${kindLabel}, ${combinedBody.length} chars)`,
  );

  const sender = getSenderIdentity(params.msg);
  const commandBody = params.msg.payload.commandBody ?? params.msg.payload.body;
  const dmRouteTarget = resolveWhatsAppDmRouteTarget({
    msg: params.msg,
    senderE164: sender.e164 ?? undefined,
    normalizeE164,
  });
  const shouldCheckCommandAuth = shouldComputeCommandAuthorized(commandBody, params.cfg);
  const isTextCommand = isControlCommandMessage(commandBody, params.cfg);
  const commandAuthorized = shouldCheckCommandAuth
    ? await resolveWhatsAppCommandAuthorized({
        cfg: params.cfg,
        msg: params.msg,
        policy: inboundPolicy,
        authDir: account.authDir,
      })
    : undefined;
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: "whatsapp",
    accountId: params.route.accountId,
  });
  const configuredResponsePrefix = params.cfg.messages?.responsePrefix;
  const responsePrefix =
    replyPipeline.responsePrefix ??
    (configuredResponsePrefix === "auto"
      ? resolveIdentityNamePrefix(params.cfg, params.route.agentId)
      : configuredResponsePrefix) ??
    (conversationKind !== "group" && inboundPolicy.isSelfChat
      ? resolveIdentityNamePrefix(params.cfg, params.route.agentId)
      : undefined);
  const replyThreading = resolveBatchedReplyThreadingPolicy(
    account.replyToMode ?? "off",
    params.msg.event.isBatched === true,
  );

  const conversationPrompts = conversationKind === "group" ? account.groups : account.direct;
  const promptTargetId =
    conversationKind === "group" ? conversationId : (dmRouteTarget ?? conversationId);
  const selectedPrompt = promptTargetId
    ? (conversationPrompts?.[promptTargetId]?.systemPrompt ??
      conversationPrompts?.["*"]?.systemPrompt)
    : undefined;
  const conversationSystemPrompt = selectedPrompt?.trim() || undefined;

  const prepared = await prepareWhatsAppInboundContext({
    bodyForAgent: msgForAgent.payload.body,
    combinedBody,
    command: {
      kind: isTextCommand ? "text-slash" : "normal",
      body: commandBody,
      ...(commandAuthorized !== undefined ? { authorized: commandAuthorized } : {}),
    },
    groupHistory: visibleGroupHistory,
    groupHistoryLimit: params.groupHistoryLimit,
    groupMemberRoster: params.groupMemberNames.get(params.groupHistoryKey),
    groupSystemPrompt: conversationSystemPrompt,
    msg: params.msg,
    rawBody: commandBody,
    route: params.route,
    buildContext: params.buildContext,
    sender: {
      id: getPrimaryIdentityId(sender) ?? undefined,
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
    },
    ...(audioTranscript !== undefined ? { transcript: audioTranscript } : {}),
    ...(audioTranscript !== undefined ? { mediaTranscribedIndexes: [0] } : {}),
    replyThreading,
    visibleReplyTo: visibleReplyTo ?? undefined,
    suppressMessageReceivedHooks: true,
  });
  const { inbound, turnInput, ctxPayload } = prepared;
  const turnAdmission = mapWhatsAppIngressToTurnAdmission(
    inbound.channelIngress?.ingress ?? admission.ingress,
  );
  const shouldClearGroupHistory =
    conversationKind === "group" && params.suppressGroupHistoryClear !== true;
  const transport = buildWhatsAppInboundTransportContext(params.msg);
  const ingressLifecycle = resolveWhatsAppIngressLifecycle(params.msg);
  const turnAdoptionLifecycle = ingressLifecycle
    ? bindIngressLifecycleToReplyOptions(ingressLifecycle).turnAdoptionLifecycle
    : undefined;
  const hookConfig = params.cfg;
  const hookAccountId = params.route.accountId;
  const hookSessionKey = params.route.sessionKey;
  const channelConfig = hookConfig.channels?.whatsapp;
  const accountConfig = hookAccountId ? channelConfig?.accounts?.[hookAccountId] : undefined;
  if (
    accountConfig?.pluginHooks?.messageReceived ??
    channelConfig?.pluginHooks?.messageReceived ??
    false
  ) {
    const canonical = deriveInboundMessageHookContext(ctxPayload);
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
            hookSessionKey,
            toInternalMessageReceivedContext(canonical),
          ),
        ),
      "whatsapp: message_received internal hook failed",
      undefined,
      WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
    );
  }

  const pinnedMainDmRecipient = resolvePinnedMainDmOwnerFromAllowlist({
    dmScope: params.cfg.session?.dmScope,
    allowFrom: inboundPolicy.configuredAllowFrom,
    normalizeEntry: normalizeE164,
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
  let finalizeReply: ReturnType<typeof createWhatsAppReplyPlan>["finalize"] | undefined;

  const turnResult = await runChannelInboundEvent({
    channel: "whatsapp",
    accountId: params.route.accountId,
    raw: inbound,
    ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
    adapter: {
      ingest: () => turnInput,
      preflight: () => ({ admission: turnAdmission }),
      onFinalize: (result) => {
        // The shared history option also clears during failure cleanup. WhatsApp keeps pending
        // context when dispatch fails so a later message can retry it.
        if (result.dispatched && turnAdmission.kind === "dispatch" && shouldClearGroupHistory) {
          params.groupHistories.set(params.groupHistoryKey, []);
        }
      },
      resolveTurn: () => {
        const { finalize, ...replyPlan } = createWhatsAppReplyPlan({
          cfg: params.cfg,
          connectionId: params.connectionId,
          context: ctxPayload,
          deliverReply: deliverWebReply,
          maxMediaBytes: params.maxMediaBytes,
          conversationId,
          onModelSelected,
          replyLogger: params.replyLogger,
          replyPipeline: {
            ...replyPipeline,
            responsePrefix,
          },
          replyResolver: params.replyResolver,
          route: params.route,
          statusReactionController,
          transport,
          turnAdoptionLifecycle,
        });
        finalizeReply = finalize;
        return {
          cfg: params.cfg,
          channel: "whatsapp",
          accountId: params.route.accountId,
          route: { agentId: params.route.agentId, sessionKey: params.route.sessionKey },
          ctxPayload,
          dispatchReplyFromConfig: params.dispatchReplyFromConfig,
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
          ...replyPlan,
        };
      },
    },
  });
  return turnResult.dispatched ? (finalizeReply?.(turnResult.dispatchResult) ?? false) : false;
}
