import { normalizeE164 } from "openclaw/plugin-sdk/account-core";
import type { AckReactionHandle } from "openclaw/plugin-sdk/channel-feedback";
import {
  type ChannelInboundTurnPlan,
  resolveGroupThreadConfig,
  runGroupThread,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-binding-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { parseActivationCommand } from "openclaw/plugin-sdk/group-activation";
import { formatAudioTranscriptForAgent } from "openclaw/plugin-sdk/media-understanding-runtime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import type { getReplyFromConfig, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveAgentRoute,
  buildGroupHistoryKey,
  buildAgentSessionKey,
  deriveLastRoutePolicy,
  buildAgentMainSessionKey,
  DEFAULT_MAIN_KEY,
} from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppAccount } from "../../accounts.js";
import { resolveWhatsAppGroupsConfigPath } from "../../group-config-path.js";
import { resolveWhatsAppGroupSessionRoute } from "../../group-session-key.js";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSelfIdentity,
  getSenderIdentity,
  identitiesOverlap,
} from "../../identity.js";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { formatError } from "../../session.js";
import { whatsappInboundLog } from "../loggers.js";
import { buildMentionConfig, isBotMentioned, resolveOwnerList } from "../mentions.js";
import { maybeSendAckReaction } from "./ack-reaction.js";
import { hasWhatsAppAudioBody, transcribeWhatsAppAudioMessage } from "./audio-preflight.js";
import { stripMentionsForCommand } from "./commands.js";
import { resolveGroupActivationFor } from "./group-activation.js";
import { noteGroupMember } from "./group-members.js";
import type { GroupHistoryEntry } from "./inbound-context.js";
import { updateLastRouteInBackground } from "./last-route.js";
import { resolvePeerId } from "./peer.js";
import { processMessage } from "./process-message.js";
import {
  createWhatsAppStatusReactionController,
  type StatusReactionController,
} from "./status-reaction.js";

const MAX_GROUP_DROP_WARNINGS = 100;
const groupDropWarned = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_GROUP_DROP_WARNINGS,
});

export function createWebOnMessageHandler(params: {
  cfg: OpenClawConfig;
  loadConfig?: () => OpenClawConfig;
  verbose: boolean;
  connectionId: string;
  maxMediaBytes: number;
  groupHistoryLimit: number;
  groupHistories: Map<string, GroupHistoryEntry[]>;
  groupMemberNames: Map<string, Map<string, string>>;
  backgroundTasks: Set<Promise<unknown>>;
  replyResolver: typeof getReplyFromConfig;
  replyLogger: ReturnType<(typeof import("openclaw/plugin-sdk/runtime-env"))["getChildLogger"]>;
  buildContext?: typeof import("openclaw/plugin-sdk/channel-inbound").buildChannelInboundEventContext;
  dispatchReplyFromConfig?: NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]>;
}) {
  const withDirectSenderPeer = (
    msg: AdmittedWebInboundMessage,
    peerId: string,
  ): AdmittedWebInboundMessage => {
    const admission = msg.admission;
    if (
      admission.conversation.kind === "group" ||
      msg.platform.sender?.e164 ||
      msg.platform.senderE164 ||
      !peerId.startsWith("+")
    ) {
      return msg;
    }
    const normalized = normalizeE164(peerId);
    if (!normalized) {
      return msg;
    }
    return {
      ...msg,
      platform: {
        ...msg.platform,
        sender: { ...msg.platform.sender, e164: normalized },
        senderE164: normalized,
      },
    };
  };

  const processForRoute = async (
    cfg: OpenClawConfig,
    msg: AdmittedWebInboundMessage,
    route: ReturnType<typeof resolveAgentRoute>,
    groupHistoryKey: string,
    opts?: {
      groupHistory?: GroupHistoryEntry[];
      suppressGroupHistoryClear?: boolean;
      preflightAudioTranscript?: string | null;
      ackAlreadySent?: boolean;
      ackReaction?: AckReactionHandle | null;
      statusReactionController?: StatusReactionController | null;
    },
  ) => {
    return processMessage({
      ...params,
      cfg,
      msg,
      route,
      groupHistoryKey,
      buildContext: params.buildContext,
      ...opts,
    });
  };

  return async (normalizedMsg: AdmittedWebInboundMessage) => {
    const canRunDirectEarlyAudioPreflight = normalizedMsg.admission.ingress.decision === "allow";
    const cfg = params.loadConfig?.() ?? params.cfg;
    const peerId = resolvePeerId(normalizedMsg);
    const msg = withDirectSenderPeer(normalizedMsg, peerId);
    const admission = msg.admission;
    if (admission.ingress.admission !== "dispatch" && admission.ingress.admission !== "observe") {
      return;
    }
    const conversationId = admission.conversation.id;
    const conversationKind = admission.conversation.kind;
    const baseRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: admission.accountId,
      peer: {
        kind: conversationKind,
        id: peerId,
      },
    });
    const baseConversationRoute =
      conversationKind === "group" ? resolveWhatsAppGroupSessionRoute(baseRoute) : baseRoute;
    const routeAccountId = baseConversationRoute.accountId ?? admission.accountId;
    const account = resolveWhatsAppAccount({
      cfg,
      accountId: routeAccountId,
    });
    const baseMentionConfig = buildMentionConfig(cfg);

    const configuredRoute = resolveConfiguredBindingRoute({
      cfg,
      route: baseConversationRoute,
      channel: "whatsapp",
      accountId: routeAccountId,
      conversationId: peerId,
    });
    // Bound route facts intentionally feed group activation/mention policy.
    // Side-effectful ACP readiness still waits until the group turn is admitted.
    const route = configuredRoute.route;
    const groupHistoryKey =
      conversationKind === "group"
        ? buildGroupHistoryKey({
            channel: "whatsapp",
            accountId: route.accountId,
            peerKind: "group",
            peerId,
          })
        : route.sessionKey;

    // Share one transcript across broadcast agents, after DM or group admission.
    // Null records a completed attempt; undefined permits a later preflight.
    let preflightAudioTranscript: string | null | undefined;
    const hasAudioBody = hasWhatsAppAudioBody(msg);
    const canRunEarlyAudioPreflight =
      conversationKind === "group" || canRunDirectEarlyAudioPreflight;
    let ackAlreadySent = false;
    let ackReaction: AckReactionHandle | null = null;
    let statusReactionController: StatusReactionController | null = null;
    let recordAcceptedConfiguredGroupRoute: (() => void) | null = null;
    const clearPreDispatchReaction = async () => {
      try {
        if (statusReactionController) {
          const controller = statusReactionController;
          statusReactionController = null;
          controller.cancelPending();
          await controller.clear();
          return;
        }
        if (ackReaction && (await ackReaction.ackReactionPromise)) {
          await ackReaction.remove();
        }
      } catch (err) {
        params.replyLogger.warn(
          { error: String(err) },
          "whatsapp: failed to clear pre-dispatch reaction after pre-dispatch rejection",
        );
      }
    };
    const transcribeAudioOnce = async () => {
      if (preflightAudioTranscript !== undefined || !hasAudioBody || !msg.payload.media?.path) {
        return;
      }
      try {
        preflightAudioTranscript =
          (await transcribeWhatsAppAudioMessage(cfg, msg, route.accountId)) ?? null;
      } catch {
        // Non-fatal: store null so per-agent retries are suppressed.
        preflightAudioTranscript = null;
      }
    };
    const runAudioPreflightOnce = async () => {
      if (
        preflightAudioTranscript !== undefined ||
        !canRunEarlyAudioPreflight ||
        !hasAudioBody ||
        !msg.payload.media?.path
      ) {
        return;
      }
      if (cfg.messages?.statusReactions?.enabled === true) {
        statusReactionController = await createWhatsAppStatusReactionController({
          cfg,
          msg,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          verbose: params.verbose,
        });
        if (statusReactionController) {
          await statusReactionController.setQueued();
        }
      } else {
        ackReaction = await maybeSendAckReaction({
          cfg,
          msg,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          verbose: params.verbose,
          warn: params.replyLogger.warn.bind(params.replyLogger),
        });
        ackAlreadySent = ackReaction !== null;
      }
      await transcribeAudioOnce();
    };

    if (conversationKind === "group") {
      const groupSender = getSenderIdentity(msg);
      const metaCtx = {
        From: conversationId,
        To: msg.platform.recipientJid,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: conversationKind,
        ConversationLabel: conversationId,
        GroupSubject: msg.group?.subject,
        SenderName: groupSender.name ?? undefined,
        SenderId: getPrimaryIdentityId(groupSender) ?? undefined,
        SenderE164: groupSender.e164 ?? undefined,
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        OriginatingTo: conversationId,
      } satisfies MsgContext;
      const recordGroupRoute = () =>
        updateLastRouteInBackground({
          cfg,
          backgroundTasks: params.backgroundTasks,
          storeAgentId: route.agentId,
          sessionKey: route.sessionKey,
          channel: "whatsapp",
          to: conversationId,
          accountId: route.accountId,
          ctx: metaCtx,
          warn: params.replyLogger.warn.bind(params.replyLogger),
        });
      // Last-route state is a dispatch side effect. Group gating must admit the
      // message first; configured ACP routes also wait for backend readiness.
      recordAcceptedConfiguredGroupRoute = recordGroupRoute;

      function skipGroupMessageAndStoreHistory(verboseMessage: string, body?: string) {
        logVerbose(verboseMessage);
        const senderIdentity = getSenderIdentity(msg);
        const sender =
          senderIdentity.name && senderIdentity.e164
            ? `${senderIdentity.name} (${senderIdentity.e164})`
            : (senderIdentity.name ??
              senderIdentity.e164 ??
              getPrimaryIdentityId(senderIdentity) ??
              "Unknown");
        createChannelHistoryWindow({ historyMap: params.groupHistories }).record({
          historyKey: groupHistoryKey,
          limit: params.groupHistoryLimit,
          entry: {
            sender,
            body: body ?? msg.payload.body,
            timestamp: msg.event.timestamp,
            id: msg.event.id,
            senderJid: senderIdentity.jid ?? msg.platform.senderJid,
            ...(msg.payload.media
              ? {
                  media: [
                    {
                      path: msg.payload.media.path,
                      url: msg.payload.media.url ?? msg.payload.media.path,
                      contentType: msg.payload.media.type,
                      kind: msg.payload.media.kind ?? undefined,
                    },
                  ],
                }
              : {}),
          },
        });
        return { shouldProcess: false } as const;
      }

      const applyGroupGating = async (mentionText?: string, deferMissingMention = false) => {
        const sender = getSenderIdentity(msg);
        const self = getSelfIdentity(msg, account.authDir);
        const inboundPolicy = resolveWhatsAppInboundPolicy({
          cfg,
          accountId: admission.accountId,
          selfE164: self.e164 ?? null,
        });
        const conversationGroupPolicy =
          inboundPolicy.resolveConversationGroupPolicy(conversationId);
        if (conversationGroupPolicy.allowlistEnabled && !conversationGroupPolicy.allowed) {
          const accountId = inboundPolicy.account.accountId;
          const warnKey = JSON.stringify([accountId, conversationId, "group registry"]);
          if (!groupDropWarned.check(warnKey)) {
            const groupsPath = resolveWhatsAppGroupsConfigPath({ cfg, accountId });
            params.replyLogger.warn(
              { conversationId, accountId, groupsPath },
              `WhatsApp group ${conversationId} not in ${groupsPath} — inbound dropped. Add the group JID to ${groupsPath} (or add "*" there to admit all groups). Sender authorization still applies.`,
            );
          }
          logVerbose(
            `Dropping message from unregistered WhatsApp group ${conversationId}. Add the group JID to channels.whatsapp.groups, or add "*" there to admit all groups. Sender authorization still applies.`,
          );
          return { shouldProcess: false };
        }

        noteGroupMember(
          params.groupMemberNames,
          groupHistoryKey,
          sender.e164 ?? undefined,
          sender.name ?? undefined,
        );

        const ownerMentionConfig = {
          ...baseMentionConfig,
          allowFrom: inboundPolicy.configuredAllowFrom,
        };
        const mentionConfig = {
          ...buildMentionConfig(cfg, route.agentId, {
            provider: "whatsapp",
            conversationId,
            providerPolicy: account.mentionPatterns,
          }),
          allowFrom: inboundPolicy.configuredAllowFrom,
        };
        const mentionMsg: AdmittedWebInboundMessage = {
          ...msg,
          payload: {
            ...msg.payload,
            body: mentionText ?? msg.payload.commandBody ?? msg.payload.body,
          },
        };
        const commandBody = stripMentionsForCommand(
          mentionMsg.payload.body,
          mentionConfig.mentionRegexes,
          self.e164,
        );
        const activationCommand = parseActivationCommand(commandBody);
        const ownerSender = normalizeE164(getSenderIdentity(msg, account.authDir).e164 ?? "");
        const owner =
          ownerSender.length > 0 &&
          resolveOwnerList(
            ownerMentionConfig,
            getSelfIdentity(msg, account.authDir).e164 ?? undefined,
          ).includes(ownerSender);
        const shouldBypassMention = owner && hasControlCommand(commandBody, cfg);

        if (activationCommand.hasCommand && !owner) {
          return skipGroupMessageAndStoreHistory(
            `Ignoring /activation from non-owner in group ${conversationId}`,
          );
        }

        const wasMentioned = isBotMentioned(mentionMsg, mentionConfig, account.authDir);
        const activation = await resolveGroupActivationFor({
          cfg,
          accountId: inboundPolicy.account.accountId,
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          conversationId,
        });
        const requireMention = activation !== "always";
        const replyContext = getReplyContext(msg, account.authDir);
        const sharedNumberSelfChat = account.selfChatMode === true;
        // Shared-number replies to self do not imply a bot mention; explicit mentions still apply.
        const implicitReplyToSelf = sharedNumberSelfChat && identitiesOverlap(self, sender);
        const implicitMentionKinds = implicitMentionKindWhen(
          "quoted_bot",
          !implicitReplyToSelf && identitiesOverlap(self, replyContext?.sender),
        );
        const mentionDecision = resolveInboundMentionDecision({
          facts: {
            canDetectMention: true,
            wasMentioned,
            implicitMentionKinds,
          },
          policy: {
            isGroup: true,
            requireMention,
            allowTextCommands: false,
            hasControlCommand: false,
            commandAuthorized: false,
          },
        });
        const effectiveWasMentioned = mentionDecision.effectiveWasMentioned || shouldBypassMention;
        // Carry the session activation and mention result together. Dispatch needs
        // both facts to distinguish an always-on group from a blocked unmentioned turn.
        msg.groupMention = { wasMentioned: effectiveWasMentioned, requireMention };
        if (!shouldBypassMention && requireMention && mentionDecision.shouldSkip) {
          if (deferMissingMention) {
            logVerbose(
              `Deferring group mention skip until audio preflight completes in ${conversationId}`,
            );
            return { shouldProcess: false, needsMentionText: true } as const;
          }
          const accountId = inboundPolicy.account.accountId;
          if (!groupDropWarned.check(JSON.stringify([accountId, conversationId, "no mention"]))) {
            const groupsPath = resolveWhatsAppGroupsConfigPath({ cfg, accountId });
            params.replyLogger.warn(
              { conversationId, accountId, groupsPath },
              `WhatsApp group ${conversationId}: skipping messages without a mention. Mention patterns can be derived from the agent identity name. Use /activation always for this session, or set ${groupsPath}[${JSON.stringify(conversationId)}].requireMention=false for the default. Preserve existing groups entries; when adding the first groups map, include "*": {} to keep other chats admitted.`,
            );
          }
          // Mention matching needs raw STT text, but deferred history is model-visible later.
          const pendingHistoryBody =
            mentionText === undefined ? undefined : formatAudioTranscriptForAgent(mentionText);
          return skipGroupMessageAndStoreHistory(
            `Group message stored for context (no mention detected) in ${conversationId}`,
            pendingHistoryBody,
          );
        }

        return { shouldProcess: true };
      };
      let gating = await applyGroupGating(
        undefined,
        hasAudioBody && Boolean(msg.payload.media?.path),
      );
      if (
        !gating.shouldProcess &&
        "needsMentionText" in gating &&
        gating.needsMentionText === true
      ) {
        await runAudioPreflightOnce();
        gating = await applyGroupGating(
          typeof preflightAudioTranscript === "string" ? preflightAudioTranscript : undefined,
        );
      }
      if (!gating.shouldProcess) {
        await clearPreDispatchReaction();
        return;
      }
    }

    if (configuredRoute.bindingResolution) {
      const ensured = await ensureConfiguredBindingRouteReady({
        cfg,
        bindingResolution: configuredRoute.bindingResolution,
      });
      if (!ensured.ok) {
        params.replyLogger.warn(
          `whatsapp: configured ACP binding unavailable for conversation ${configuredRoute.bindingResolution.record.conversation.conversationId}: ${ensured.error}`,
        );
        await clearPreDispatchReaction();
        return;
      }
    }
    if (recordAcceptedConfiguredGroupRoute && !configuredRoute.bindingResolution) {
      recordAcceptedConfiguredGroupRoute();
      recordAcceptedConfiguredGroupRoute = null;
    }

    await runAudioPreflightOnce();

    const broadcastGroup = !configuredRoute.bindingResolution
      ? resolveGroupThreadConfig({ cfg, channel: "whatsapp", peerId })
      : undefined;
    const hasBroadcastTargets = broadcastGroup !== undefined;
    if (hasBroadcastTargets && statusReactionController) {
      await clearPreDispatchReaction();
    }
    if (hasBroadcastTargets && !canRunEarlyAudioPreflight) {
      await transcribeAudioOnce();
    }

    if (broadcastGroup) {
      // Group ack eligibility belongs to each target agent/session.
      const broadcastAckAlreadySent =
        conversationKind !== "group" && (ackAlreadySent || Boolean(statusReactionController));
      whatsappInboundLog.info(
        `Broadcasting message to ${broadcastGroup.agents.length} agents (${broadcastGroup.strategy})`,
      );
      const isGroupConversation = admission.conversation.kind === "group";
      const groupHistorySnapshot = isGroupConversation
        ? [...(params.groupHistories.get(groupHistoryKey) ?? [])]
        : undefined;

      await runGroupThread({
        cfg,
        group: broadcastGroup,
        channel: "whatsapp",
        accountId: route.accountId,
        peerId,
        messageId: msg.event.id,
        text: [msg.payload.body, preflightAudioTranscript].filter(Boolean).join("\n"),
        onError: (err, turn) => {
          whatsappInboundLog.error(`Broadcast agent ${turn.agentId} failed: ${formatError(err)}`);
        },
        runTurn: async (turn) => {
          const sessionKey = buildAgentSessionKey({
            agentId: turn.agentId,
            channel: "whatsapp",
            accountId: route.accountId,
            peer: {
              kind: admission.conversation.kind,
              id: peerId,
            },
            dmScope: cfg.session?.dmScope,
            identityLinks: cfg.session?.identityLinks,
          });
          const mainSessionKey = buildAgentMainSessionKey({
            agentId: turn.agentId,
            mainKey: DEFAULT_MAIN_KEY,
          });

          const baseAgentRoute = {
            ...route,
            agentId: turn.agentId,
            sessionKey,
            mainSessionKey,
            lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
          };
          const agentRoute = isGroupConversation
            ? resolveWhatsAppGroupSessionRoute(baseAgentRoute)
            : baseAgentRoute;

          return processForRoute(cfg, msg, agentRoute, groupHistoryKey, {
            groupHistory: turn.round === 1 ? groupHistorySnapshot : [],
            suppressGroupHistoryClear: true,
            ...(preflightAudioTranscript !== undefined ? { preflightAudioTranscript } : {}),
            ...(broadcastAckAlreadySent || turn.round > 1 ? { ackAlreadySent: true } : {}),
            ...(ackReaction && conversationKind !== "group" && turn.round === 1
              ? { ackReaction }
              : {}),
          });
        },
      });

      if (isGroupConversation) {
        params.groupHistories.set(groupHistoryKey, []);
      }

      return;
    }

    recordAcceptedConfiguredGroupRoute?.();

    await processForRoute(cfg, msg, route, groupHistoryKey, {
      ...(preflightAudioTranscript !== undefined ? { preflightAudioTranscript } : {}),
      ...(ackAlreadySent ? { ackAlreadySent: true } : {}),
      ...(ackReaction ? { ackReaction } : {}),
      ...(statusReactionController ? { statusReactionController } : {}),
    });
  };
}
