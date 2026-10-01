import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createChannelInboundEnvelopeBuilder,
  formatInboundMediaUnavailableText,
} from "openclaw/plugin-sdk/channel-inbound";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  bindIngressLifecycleToReplyOptions,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { GetReplyOptions, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  asFiniteNumber,
  asNullableRecord as asRecord,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { OpenClawConfig } from "../../runtime-api.js";
import { createLoggerBackedRuntime } from "../../runtime-api.js";
import { getTlonRuntime } from "../runtime.js";
import {
  createSettingsManager,
  putTlonSetting,
  type PendingApproval,
  type TlonSettingsStore,
} from "../settings.js";
import { normalizeShip, parseChannelNest } from "../targets.js";
import { resolveTlonAccount } from "../types.js";
import { authenticate } from "../urbit/auth.js";
import { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../urbit/context.js";
import type { DmInvite, Foreigns } from "../urbit/foreigns.js";
import { sendDm, sendGroupMessage } from "../urbit/send.js";
import { UrbitSSEClient } from "../urbit/sse-client.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";
import { createPendingApproval } from "./approval.js";
import { resolveChannelAuthorization } from "./authorization.js";
import { createTlonCitationResolver } from "./cites.js";
import { fetchInitData } from "./discovery.js";
import { createChannelHistoryCache, fetchThreadHistory } from "./history.js";
import { createTlonIngressMonitor, type TlonIngressLifecycle } from "./ingress.js";
import { buildTlonInboundMediaPrompt, downloadMessageImages } from "./media.js";
import { prepareTlonGroupAdmission } from "./mentions.js";
import {
  applyTlonSettingsOverrides,
  buildTlonSettingsMigrations,
  mergeUniqueStrings,
  shouldMigrateTlonSetting,
} from "./settings-helpers.js";
import { createActiveSnapshotTracker, createParticipatedThreadTracker } from "./tracking.js";
import {
  extractDmPartnerShip,
  extractMessageText,
  formatModelName,
  formatSummarizationHistoryText,
  isDmAllowedWithIngress,
  isGroupInviteAllowed,
  isSummarizationRequest,
  resolveTlonCommandAuthorizationWithIngress,
  resolveTlonMessageIngress,
  stripBotMention,
} from "./utils.js";

type MonitorTlonOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string | null;
};

export async function monitorTlonProvider(opts: MonitorTlonOpts = {}): Promise<void> {
  const core = getTlonRuntime();
  const cfg = core.config.current() as OpenClawConfig;
  if (cfg.channels?.tlon?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "tlon-auto-reply" });
  const runtime: RuntimeEnv =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger,
    });

  const account = resolveTlonAccount(cfg, opts.accountId ?? undefined);
  if (!account.enabled) {
    return;
  }
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured (ship/url/code required)");
  }

  const botShipName = normalizeShip(account.ship);
  runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);

  const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(
    account.dangerouslyAllowPrivateNetwork,
  );

  // Store validated values for use in closures (TypeScript narrowing doesn't propagate)
  const accountUrl = account.url;
  const accountCode = account.code;

  async function authenticateWithRetry(maxAttempts = 10): Promise<string> {
    let authAttempt = 0;
    return await retryAsync(
      async () => {
        authAttempt += 1;
        if (opts.abortSignal?.aborted) {
          throw new Error("Aborted while waiting to authenticate");
        }
        try {
          runtime.log?.(`[tlon] Attempting authentication to ${accountUrl}...`);
          return await authenticate(accountUrl, accountCode, { ssrfPolicy });
        } catch (error: unknown) {
          runtime.error?.(
            `[tlon] Failed to authenticate (attempt ${authAttempt}): ${formatErrorMessage(error)}`,
          );
          throw error;
        }
      },
      {
        attempts: Math.max(1, maxAttempts),
        minDelayMs: 0,
        shouldRetry: () => !opts.abortSignal?.aborted,
        delayMs: ({ attempt }) => Math.min(30_000, 1_000 * 2 ** (attempt - 1)),
        onRetry: ({ delayMs }) => {
          runtime.log?.(`[tlon] Retrying authentication in ${delayMs}ms...`);
        },
        sleep: (delayMs) => sleepWithAbort(delayMs, opts.abortSignal),
      },
    );
  }

  const cookie = await authenticateWithRetry();
  const api = new UrbitSSEClient(account.url, cookie, {
    ship: botShipName,
    ssrfPolicy,
    logger: {
      log: (message) => runtime.log?.(message),
      error: (message) => runtime.error?.(message),
    },
    // Re-authenticate on reconnect in case the session expired
    onReconnect: async (client) => {
      runtime.log?.("[tlon] Re-authenticating on SSE reconnect...");
      const newCookie = await authenticateWithRetry(5);
      client.updateCookie(newCookie);
      runtime.log?.("[tlon] Re-authentication successful");
    },
  });

  let groupChannels: string[] = [];
  let botNickname: string | null = null;

  const settingsManager = createSettingsManager(api, {
    log: (msg) => runtime.log?.(msg),
    error: (msg) => runtime.error?.(msg),
  });

  // Reactive state that can be updated via settings store
  let effectiveDmAllowlist: string[] = account.dmAllowlist;
  let effectiveShowModelSig: boolean = account.showModelSignature ?? false;
  let effectiveAutoAcceptDmInvites: boolean = account.autoAcceptDmInvites ?? false;
  let effectiveAutoAcceptGroupInvites: boolean = account.autoAcceptGroupInvites ?? false;
  let effectiveGroupInviteAllowlist: string[] = account.groupInviteAllowlist;
  let effectiveAutoDiscoverChannels: boolean = account.autoDiscoverChannels ?? false;
  let effectiveOwnerShip: string | null = account.ownerShip
    ? normalizeShip(account.ownerShip)
    : null;
  let pendingApprovals: PendingApproval[] = [];
  let currentSettings: TlonSettingsStore = {};

  // Track recent threads we've participated in so replies can omit a mention.
  const participatedThreads = createParticipatedThreadTracker();
  const channelHistory = createChannelHistoryCache();

  // Track DM senders per session to detect shared sessions (security warning)
  const dmSendersBySession = new Map<string, Set<string>>();
  let sharedSessionWarningSent = false;

  try {
    const selfProfile = await api.scry("/contacts/v1/self.json");
    if (selfProfile && typeof selfProfile === "object") {
      const profile = selfProfile as { nickname?: { value?: string } };
      botNickname = profile.nickname?.value || null;
      if (botNickname) {
        runtime.log?.(`[tlon] Bot nickname: ${botNickname}`);
      }
    }
  } catch (error: unknown) {
    runtime.log?.(`[tlon] Could not fetch nickname: ${formatErrorMessage(error)}`);
  }

  // Store init foreigns for processing after settings are loaded
  let initForeigns: Foreigns | null = null;

  async function migrateConfigToSettings() {
    const migrations = buildTlonSettingsMigrations(account, currentSettings);

    for (const { key, fileValue, settingsValue } of migrations) {
      if (shouldMigrateTlonSetting(fileValue, settingsValue)) {
        try {
          await putTlonSetting(api, key, fileValue);
          runtime.log?.(`[tlon] Migrated ${key} from config to settings store`);
        } catch (err) {
          runtime.log?.(`[tlon] Failed to migrate ${key}: ${String(err)}`);
        }
      }
    }
  }

  try {
    currentSettings = await settingsManager.load();

    await migrateConfigToSettings();
    ({
      effectiveDmAllowlist,
      effectiveShowModelSig,
      effectiveAutoAcceptDmInvites,
      effectiveAutoAcceptGroupInvites,
      effectiveGroupInviteAllowlist,
      effectiveAutoDiscoverChannels,
      effectiveOwnerShip,
      pendingApprovals,
      currentSettings,
    } = applyTlonSettingsOverrides({
      account,
      currentSettings,
      log: (message) => runtime.log?.(message),
    }));
  } catch (err) {
    runtime.log?.(`[tlon] Settings store not available, using file config: ${String(err)}`);
  }

  // Run channel discovery AFTER settings are loaded (so settings store value is used)
  if (effectiveAutoDiscoverChannels) {
    try {
      const initData = await fetchInitData(api, runtime);
      if (initData.channels.length > 0) {
        groupChannels = initData.channels;
      }
      initForeigns = initData.foreigns;
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Auto-discovery failed: ${formatErrorMessage(error)}`);
    }
  }

  if (account.groupChannels.length > 0) {
    groupChannels = mergeUniqueStrings(groupChannels, account.groupChannels);
    runtime.log?.(
      `[tlon] Added ${account.groupChannels.length} manual groupChannels to monitoring`,
    );
  }

  // Also merge settings store groupChannels (may have been set via tlon settings command)
  groupChannels = mergeUniqueStrings(groupChannels, currentSettings.groupChannels);

  if (groupChannels.length > 0) {
    runtime.log?.(
      `[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`,
    );
  } else {
    runtime.log?.("[tlon] No group channels to monitor (DMs only)");
  }

  function isOwner(ship: string): boolean {
    if (!effectiveOwnerShip) {
      return false;
    }
    return normalizeShip(ship) === effectiveOwnerShip;
  }

  const processMessage = async (params: {
    messageId: string;
    senderShip: string;
    messageText: string;
    messageContent?: unknown; // Raw Tlon content for media extraction
    isGroup: boolean;
    channelNest?: string;
    timestamp: number;
    parentId?: string | null;
    isThreadReply?: boolean;
    isAdmissionAllowed?: () => boolean;
    turnAdoptionLifecycle?: TlonIngressLifecycle;
    resolveChannelIngress: (
      contextBinding: ChannelIngressContextBinding,
    ) => Promise<ResolvedChannelMessageIngress>;
  }) => {
    const {
      messageId,
      senderShip,
      isGroup,
      channelNest,
      timestamp,
      parentId,
      isThreadReply,
      isAdmissionAllowed,
      messageContent,
      turnAdoptionLifecycle,
      resolveChannelIngress,
    } = params;
    let messageText = params.messageText;

    let attachments: Array<{ path: string; contentType: string }> = [];
    let unavailableMediaCount = 0;
    if (messageContent) {
      try {
        ({ attachments, unavailableCount: unavailableMediaCount } = await downloadMessageImages(
          messageContent,
          account.mediaMaxBytes,
        ));
        if (attachments.length > 0) {
          runtime.log?.(`[tlon] Downloaded ${attachments.length} image(s) from message`);
        }
      } catch (error: unknown) {
        runtime.log?.(`[tlon] Failed to download images: ${formatErrorMessage(error)}`);
      }
    }

    // Fetch thread context when entering a thread for the first time
    if (isThreadReply && parentId && channelNest) {
      try {
        const threadHistory = await fetchThreadHistory(api, channelNest, parentId, 20, runtime);
        if (threadHistory.length > 0) {
          const threadContext = threadHistory
            .slice(-10) // Last 10 messages for context
            .map((msg) => `${msg.author}: ${msg.content}`)
            .join("\n");

          const contextNote = `[Thread conversation - ${threadHistory.length} previous replies. You are participating in this thread. Only respond if relevant or helpful - you don't need to reply to every message.]`;
          messageText = `${contextNote}\n\n[Previous messages]\n${threadContext}\n\n[Current message]\n${messageText}`;
          runtime?.log?.(
            `[tlon] Added thread context (${threadHistory.length} replies) to message`,
          );
        }
      } catch (error: unknown) {
        runtime?.log?.(`[tlon] Could not fetch thread context: ${formatErrorMessage(error)}`);
      }
    }

    if (isGroup && channelNest && isSummarizationRequest(messageText)) {
      try {
        const history = await channelHistory.getChannelHistory(api, channelNest, 50, runtime);
        if (history.length === 0) {
          const noHistoryMsg =
            "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
          const parsed = parseChannelNest(channelNest);
          if (parsed && isAdmissionAllowed?.() !== false) {
            await sendGroupMessage({
              api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: noHistoryMsg,
            });
          }
          return;
        }

        const historyText = formatSummarizationHistoryText(history, cfg);

        messageText =
          `Please summarize this channel conversation (${history.length} recent messages):\n\n${historyText}\n\n` +
          "Provide a concise summary highlighting:\n" +
          "1. Main topics discussed\n" +
          "2. Key decisions or conclusions\n" +
          "3. Action items if any\n" +
          "4. Notable participants";
      } catch (error: unknown) {
        const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${formatErrorMessage(error)}`;
        const parsed = parseChannelNest(channelNest);
        if (parsed && isAdmissionAllowed?.() !== false) {
          await sendGroupMessage({
            api,
            fromShip: botShipName,
            hostShip: parsed.hostShip,
            channelName: parsed.channelName,
            text: errorMsg,
          });
        }
        return;
      }
    }

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "tlon",
      accountId: opts.accountId ?? undefined,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? (channelNest ?? senderShip) : senderShip,
      },
    });
    const channelIngress = await resolveChannelIngress({
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId,
      inboundEventKind: "user_request",
    });
    if (!channelIngress.senderAccess.allowed) {
      runtime.log?.(`[tlon] Authorization changed before dispatch for ${senderShip}`);
      return;
    }

    if (!isGroup) {
      const sessionKey = route.sessionKey;
      if (!dmSendersBySession.has(sessionKey)) {
        dmSendersBySession.set(sessionKey, new Set());
      }
      const senders = dmSendersBySession.get(sessionKey)!;
      if (senders.size > 0 && !senders.has(senderShip)) {
        runtime.log?.(
          `[tlon] ⚠️ SECURITY: Multiple users sharing DM session. ` +
            `Configure "session.dmScope: per-channel-peer" in OpenClaw config.`,
        );

        if (!sharedSessionWarningSent && effectiveOwnerShip) {
          sharedSessionWarningSent = true;
          const warningMsg =
            `⚠️ Security Warning: Multiple users are sharing a DM session with this bot. ` +
            `This can leak conversation context between users.\n\n` +
            `Fix: Add to your OpenClaw config:\n` +
            `session:\n  dmScope: "per-channel-peer"\n\n` +
            `Docs: https://docs.openclaw.ai/concepts/session#dm-isolation`;

          sendDm({
            api,
            fromShip: botShipName,
            toShip: effectiveOwnerShip,
            text: warningMsg,
          }).catch((err: unknown) =>
            runtime.error?.(
              `[tlon] Failed to send security warning to owner: ${formatErrorMessage(err)}`,
            ),
          );
        }
      }
      senders.add(senderShip);
    }

    const senderRole = isOwner(senderShip) ? "owner" : "user";
    const fromLabel = isGroup
      ? `${senderShip} [${senderRole}] in ${channelNest}`
      : `${senderShip} [${senderRole}]`;

    const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
      messageText,
      cfg,
    );
    let commandAuthorized = false;

    if (shouldComputeAuth) {
      const useAccessGroups = true;
      const commandAccess = await resolveTlonCommandAuthorizationWithIngress({
        senderShip,
        ownerShip: effectiveOwnerShip,
        useAccessGroups,
      });
      commandAuthorized = commandAccess.commandAccess.authorized;

      if (!commandAuthorized) {
        console.log(
          `[tlon] Command attempt denied: ${senderShip} is not owner (owner=${effectiveOwnerShip ?? "not configured"})`,
        );
      }
    }

    const promptMedia = buildTlonInboundMediaPrompt(messageText, attachments);

    const body = createChannelInboundEnvelopeBuilder({ cfg, route })({
      channel: "Tlon",
      from: fromLabel,
      timestamp,
      body: promptMedia.body,
    });

    const commandBody = isGroup ? stripBotMention(messageText, botShipName) : messageText;
    const bodyForAgent =
      unavailableMediaCount > 0
        ? formatInboundMediaUnavailableText({
            body: commandBody,
            notice: `[tlon ${unavailableMediaCount > 1 ? `${unavailableMediaCount} attachments` : "attachment"} unavailable]`,
          })
        : commandBody;
    const tlonConversationId = isGroup ? (channelNest ?? senderShip) : senderShip;
    const ctxPayload = core.channel.inbound.buildContext({
      channel: "tlon",
      accountId: route.accountId,
      messageId,
      timestamp,
      from: isGroup ? `tlon:group:${channelNest}` : `tlon:${senderShip}`,
      sender: {
        id: senderShip,
        name: senderShip,
        roles: [senderRole],
      },
      conversation: {
        kind: isGroup ? "group" : "direct",
        id: tlonConversationId,
        label: fromLabel,
      },
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: `tlon:${botShipName}`,
        originatingTo: `tlon:${isGroup ? channelNest : botShipName}`,
        replyToId: parentId ?? undefined,
      },
      message: {
        body,
        bodyForAgent,
        rawBody: messageText,
        commandBody,
      },
      channelIngress,
      extra: {
        GroupSubject: undefined,
        SenderRole: senderRole,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
        ...(attachments.length > 0 && { Attachments: attachments }),
        ...(parentId && { ThreadId: parentId }),
      },
    });

    const dispatchStartTime = Date.now();

    const humanDelay = resolveHumanDelayConfig(cfg, route.agentId);
    const deliveryTarget = isGroup ? channelNest : senderShip;

    const prepareReplyPayload = (payload: ReplyPayload): ReplyPayload => {
      const replyText = payload.text;
      if (!replyText || !effectiveShowModelSig) {
        return payload;
      }
      const extPayload = payload as {
        metadata?: { model?: string };
        model?: string;
      };
      const defaultModel = cfg.agents?.defaults?.model;
      const modelInfo =
        extPayload.metadata?.model ||
        extPayload.model ||
        (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary);
      return {
        ...payload,
        text: `${replyText}\n\n_[Generated by ${formatModelName(modelInfo)}]_`,
      };
    };

    const rememberThreadParticipation = (result: { visibleReplySent?: boolean } | void) => {
      if (!isGroup || !channelNest || !parentId || result?.visibleReplySent === false) {
        return;
      }
      participatedThreads.add(parentId);
      runtime.log?.(`[tlon] Now tracking thread for future replies: ${parentId}`);
    };

    const replyOptions: GetReplyOptions = {
      ...(turnAdoptionLifecycle ? bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle) : {}),
      ...(promptMedia.media.length > 0 ? { media: promptMedia.media } : {}),
    };
    if (isAdmissionAllowed?.() === false) {
      return;
    }
    await core.channel.inbound.dispatch({
      channel: "tlon",
      accountId: route.accountId,
      cfg,
      route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
      ctxPayload,
      replyPipeline: {},
      delivery: {
        preparePayload: prepareReplyPayload,
        durable: deliveryTarget
          ? () => ({
              to: deliveryTarget,
              replyToId: parentId ?? undefined,
              threadId: parentId ?? undefined,
            })
          : false,
        deliver: async (payload: ReplyPayload) => {
          const replyText = payload.text;
          if (!replyText) {
            return { visibleReplySent: false };
          }

          if (isGroup && channelNest) {
            const parsed = parseChannelNest(channelNest);
            if (!parsed) {
              return { visibleReplySent: false };
            }
            await sendGroupMessage({
              api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: replyText,
              replyToId: parentId ?? undefined,
            });
            return { visibleReplySent: true, replyToId: parentId ?? undefined };
          }

          await sendDm({
            api,
            fromShip: botShipName,
            toShip: senderShip,
            text: replyText,
          });
          return { visibleReplySent: true };
        },
        onDelivered: (_payload, _info, result) => {
          rememberThreadParticipation(result);
        },
        onError: (err, info) => {
          const dispatchDuration = Date.now() - dispatchStartTime;
          runtime.error?.(
            `[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`,
          );
        },
      },
      dispatcherOptions: {
        humanDelay,
      },
      ...(turnAdoptionLifecycle || promptMedia.media.length > 0 ? { replyOptions } : {}),
      record: {
        onRecordError: (err) => {
          runtime.error?.(`[tlon] failed updating session meta: ${String(err)}`);
        },
      },
    });
  };

  const watchedChannels = new Set<string>(groupChannels);

  const refreshWatchedChannels = async (): Promise<number> => {
    const { channels: discoveredChannels } = await fetchInitData(api, runtime);
    let newCount = 0;
    for (const channelNest of discoveredChannels) {
      if (!watchedChannels.has(channelNest)) {
        watchedChannels.add(channelNest);
        newCount++;
      }
    }
    return newCount;
  };

  const { resolveAllCites } = createTlonCitationResolver({
    api,
    runtime,
  });

  const { queueApprovalRequest, handleApprovalResponse, handleAdminCommand } =
    createTlonApprovalRuntime({
      api,
      runtime,
      botShipName,
      getPendingApprovals: () => pendingApprovals,
      setPendingApprovals: (approvals) => {
        pendingApprovals = approvals;
      },
      getCurrentSettings: () => currentSettings,
      setCurrentSettings: (settings) => {
        currentSettings = settings;
      },
      getEffectiveDmAllowlist: () => effectiveDmAllowlist,
      setEffectiveDmAllowlist: (ships) => {
        effectiveDmAllowlist = ships;
      },
      getEffectiveOwnerShip: () => effectiveOwnerShip,
      processApprovedMessage: async (approval) => {
        if (!approval.originalMessage || approval.type === "group") {
          return;
        }
        const isGroup = approval.type === "channel";
        const conversationId = isGroup ? (approval.channelNest ?? "") : approval.requestingShip;
        if (isGroup && !conversationId) {
          return;
        }
        await processMessage({
          messageId: approval.originalMessage.messageId,
          senderShip: approval.requestingShip,
          messageText: approval.originalMessage.messageText,
          messageContent: approval.originalMessage.messageContent,
          timestamp: approval.originalMessage.timestamp,
          isGroup,
          ...(isGroup
            ? {
                channelNest: conversationId,
                parentId: approval.originalMessage.parentId,
                isThreadReply: approval.originalMessage.isThreadReply,
              }
            : {}),
          resolveChannelIngress: async (contextBinding) =>
            await resolveTlonMessageIngress({
              senderShip: approval.requestingShip,
              accountId: account.accountId,
              conversation: { kind: isGroup ? "group" : "direct", id: conversationId },
              allowFrom: [approval.requestingShip],
              ...(isGroup ? { groupPolicy: "allowlist" } : { dmPolicy: "allowlist" }),
              contextBinding,
            }),
        });
      },
      refreshWatchedChannels,
    });

  const handleChannelsFirehose = async (
    event: unknown,
    turnAdoptionLifecycle?: TlonIngressLifecycle,
  ) => {
    try {
      const eventRecord = asRecord(event);
      const nest = readString(eventRecord, "nest");
      if (!nest) {
        return;
      }

      if (!watchedChannels.has(nest)) {
        return;
      }

      const response = asRecord(eventRecord?.response);
      if (!response) {
        return;
      }

      const post = asRecord(response.post);
      const rPost = asRecord(post?.["r-post"]);
      const set = asRecord(rPost?.set);
      const reply = asRecord(rPost?.reply);
      const replyPayload = asRecord(reply?.["r-reply"]);
      const replySet = asRecord(replyPayload?.set);
      const essay = asRecord(set?.essay);
      const memo = asRecord(replySet?.memo);
      const content = memo ?? essay;
      if (!content) {
        return;
      }
      const isThreadReply = Boolean(memo);
      const messageId = isThreadReply ? readString(reply, "id") : readString(post, "id");
      if (!messageId) {
        return;
      }

      const senderShip = normalizeShip(readString(content, "author") ?? "");
      if (!senderShip || senderShip === botShipName) {
        return;
      }

      const rawText = extractMessageText(content.content);
      if (!rawText.trim()) {
        return;
      }

      const contentBody = content.content;
      const sentAt = asFiniteNumber(content?.sent) ?? Date.now();

      channelHistory.cacheMessage(nest, {
        author: senderShip,
        content: rawText,
        timestamp: sentAt,
        id: messageId,
      });

      const { allowedShips, senderAllowed, mentionDecision, parentId, isAdmissionAllowed } =
        await prepareTlonGroupAdmission({
          cfg,
          account,
          api,
          channelNest: nest,
          senderShip,
          isOwner,
          botShipName,
          botNickname,
          rawText,
          messageSeal: isThreadReply ? asRecord(replySet?.seal) : asRecord(set?.seal),
          isThreadReply,
          hasParticipatedInThread: participatedThreads.has,
          getSettings: () => currentSettings,
          runtime,
        });

      if (mentionDecision.shouldSkip) {
        return;
      }

      if (!senderAllowed) {
        // If owner is configured, queue approval request
        if (effectiveOwnerShip) {
          const approval = createPendingApproval({
            type: "channel",
            requestingShip: senderShip,
            channelNest: nest,
            messagePreview: sliceUtf16Safe(rawText, 0, 100),
            originalMessage: {
              messageId,
              messageText: rawText,
              messageContent: contentBody,
              timestamp: sentAt,
              parentId: parentId ?? undefined,
              isThreadReply,
            },
          });
          await queueApprovalRequest(approval);
        } else {
          runtime.log?.(
            `[tlon] Access denied: ${senderShip} in ${nest} (allowed: ${allowedShips.join(", ")})`,
          );
        }
        return;
      }

      const messageText = (await resolveAllCites(contentBody)) + rawText;

      await processMessage({
        messageId,
        senderShip,
        messageText,
        messageContent: contentBody,
        isGroup: true,
        channelNest: nest,
        timestamp: sentAt,
        parentId,
        isThreadReply,
        turnAdoptionLifecycle,
        isAdmissionAllowed,
        resolveChannelIngress: async (contextBinding) => {
          const { mode, allowedShips: currentAllowedShips } = resolveChannelAuthorization(
            cfg,
            nest,
            currentSettings,
          );
          return await resolveTlonMessageIngress({
            senderShip,
            accountId: account.accountId,
            conversation: { kind: "group", id: nest },
            allowFrom: [
              ...currentAllowedShips.map(normalizeShip),
              ...(effectiveOwnerShip ? [normalizeShip(effectiveOwnerShip)] : []),
            ],
            groupPolicy: mode === "restricted" ? "allowlist" : "open",
            contextBinding,
          });
        },
      });
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Error handling channel firehose event: ${formatErrorMessage(error)}`);
      throw error;
    }
  };

  // Firehose handler for all DM messages (/v3)
  // Track processed DM invites only while they remain in the active /v3 snapshot.
  const processedDmInvites = createActiveSnapshotTracker();

  const handleChatFirehose = async (
    event: unknown,
    turnAdoptionLifecycle?: TlonIngressLifecycle,
  ) => {
    try {
      if (Array.isArray(event)) {
        // UrbitSSEClient awaits each handler before reading and acking the next fact,
        // so snapshot replacement and invite side effects cannot overlap.
        // The /v3 invite array is the active snapshot. Forget ships that left it
        // instead of retaining every invite seen during the monitor lifetime.
        const ships = processedDmInvites.beginSnapshot(
          (event as DmInvite[]).map((invite) => normalizeShip(invite.ship || "")).filter(Boolean),
        );

        for (const ship of ships) {
          if (processedDmInvites.has(ship)) {
            continue;
          }

          const ownerInvite = isOwner(ship);
          const allowed = ownerInvite || (await isDmAllowedWithIngress(ship, effectiveDmAllowlist));
          if (ownerInvite || (effectiveAutoAcceptDmInvites && allowed)) {
            try {
              await api.poke({
                app: "chat",
                mark: "chat-dm-rsvp",
                json: { ship, ok: true },
              });
              processedDmInvites.add(ship);
              runtime.log?.(
                ownerInvite
                  ? `[tlon] Auto-accepted DM invite from owner ${ship}`
                  : `[tlon] Auto-accepted DM invite from ${ship}`,
              );
            } catch (err) {
              runtime.error?.(
                ownerInvite
                  ? `[tlon] Failed to auto-accept DM from owner: ${String(err)}`
                  : `[tlon] Failed to auto-accept DM from ${ship}: ${String(err)}`,
              );
              throw err;
            }
            continue;
          }

          if (effectiveOwnerShip && !allowed) {
            const approval = createPendingApproval({
              type: "dm",
              requestingShip: ship,
              messagePreview: "(DM invite - no message yet)",
            });
            processedDmInvites.addIfAccepted(ship, await queueApprovalRequest(approval));
          }
        }
        return;
      }
      const eventRecord = asRecord(event);
      if (!eventRecord) {
        return;
      }

      const whom = eventRecord.whom; // DM partner ship or club ID
      const messageId = readString(eventRecord, "id");
      const response = asRecord(eventRecord.response);
      if (!messageId || !response) {
        return;
      }

      const essay = asRecord(asRecord(response.add)?.essay);
      if (!essay) {
        return;
      }

      const authorShip = normalizeShip(readString(essay, "author") ?? "");
      const partnerShip = extractDmPartnerShip(whom);
      const senderShip = partnerShip || authorShip;

      // Ignore the bot's own outbound DM events.
      if (authorShip === botShipName) {
        return;
      }
      if (!senderShip || senderShip === botShipName) {
        return;
      }

      if (authorShip && partnerShip && authorShip !== partnerShip) {
        runtime.log?.(
          `[tlon] DM ship mismatch (author=${authorShip}, partner=${partnerShip}) - routing to partner`,
        );
      }

      const rawText = extractMessageText(essay.content);
      if (!rawText.trim()) {
        return;
      }

      const messageText = rawText;
      if (isOwner(senderShip) && (await handleApprovalResponse(messageText))) {
        runtime.log?.(`[tlon] Processed approval response from owner: ${messageText}`);
        return;
      }

      if (isOwner(senderShip) && (await handleAdminCommand(messageText))) {
        runtime.log?.(`[tlon] Processed admin command from owner: ${messageText}`);
        return;
      }

      const ownerDm = isOwner(senderShip);
      const resolveChannelIngress = async (contextBinding?: ChannelIngressContextBinding) =>
        await resolveTlonMessageIngress({
          senderShip,
          accountId: account.accountId,
          conversation: { kind: "direct", id: senderShip },
          allowFrom: ownerDm ? [senderShip] : effectiveDmAllowlist,
          dmPolicy: "allowlist",
          contextBinding,
        });
      if (!ownerDm && !(await resolveChannelIngress()).senderAccess.allowed) {
        if (effectiveOwnerShip) {
          const approval = createPendingApproval({
            type: "dm",
            requestingShip: senderShip,
            messagePreview: sliceUtf16Safe(messageText, 0, 100),
            originalMessage: {
              messageId,
              messageText,
              messageContent: essay.content,
              timestamp: asFiniteNumber(essay?.sent) ?? Date.now(),
            },
          });
          await queueApprovalRequest(approval);
        } else {
          runtime.log?.(`[tlon] Blocked DM from ${senderShip}: not in allowlist`);
        }
        return;
      }

      const resolvedMessageText = (await resolveAllCites(essay.content)) + rawText;
      if (ownerDm) {
        runtime.log?.(`[tlon] Processing DM from owner ${senderShip}`);
      }
      await processMessage({
        messageText: resolvedMessageText,
        messageId,
        senderShip,
        messageContent: essay.content,
        isGroup: false,
        timestamp: asFiniteNumber(essay?.sent) ?? Date.now(),
        turnAdoptionLifecycle,
        resolveChannelIngress,
      });
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Error handling chat firehose event: ${formatErrorMessage(error)}`);
      throw error;
    }
  };

  const ingress = createTlonIngressMonitor({
    accountId: account.accountId,
    runtime,
    abortSignal: opts.abortSignal,
    dispatch: async (source, event, turnAdoptionLifecycle) => {
      if (source === "channels") {
        await handleChannelsFirehose(event, turnAdoptionLifecycle);
        return;
      }
      await handleChatFirehose(event, turnAdoptionLifecycle);
    },
  });

  try {
    runtime.log?.("[tlon] Subscribing to firehose updates...");

    for (const [source, path, label, handleEvent] of [
      ["channels", "/v2", "Channels", handleChannelsFirehose],
      ["chat", "/v3", "Chat", handleChatFirehose],
    ] as const) {
      await api.subscribe({
        app: source,
        path,
        event: async (event) => {
          const result = await ingress.receive({ source, event });
          if (result.kind === "ignored") {
            await handleEvent(event);
          }
        },
        err: (error) => {
          runtime.error?.(`[tlon] ${label} firehose error: ${String(error)}`);
        },
        quit: () => {
          runtime.log?.(`[tlon] ${label} firehose subscription ended`);
        },
      });
      runtime.log?.(`[tlon] Subscribed to ${source} firehose (${path})`);
    }

    // Subscribe to contacts updates to track nickname changes
    await api.subscribe({
      app: "contacts",
      path: "/v1/news",
      event: (event: unknown) => {
        try {
          const eventRecord = asRecord(event);
          if (eventRecord?.self) {
            const selfUpdate = asRecord(eventRecord.self);
            const contact = asRecord(selfUpdate?.contact);
            const nickname = asRecord(contact?.nickname);
            if (nickname && "value" in nickname) {
              const newNickname = readString(nickname, "value") ?? null;
              if (newNickname !== botNickname) {
                botNickname = newNickname;
                runtime.log?.(`[tlon] Nickname updated: ${botNickname}`);
              }
            }
          }
        } catch (error: unknown) {
          runtime.error?.(`[tlon] Error handling contacts event: ${formatErrorMessage(error)}`);
        }
      },
      err: (error) => {
        runtime.error?.(`[tlon] Contacts subscription error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Contacts subscription ended");
      },
    });
    runtime.log?.("[tlon] Subscribed to contacts updates (/v1/news)");

    // Subscribe to settings store for hot-reloading config
    settingsManager.onChange((newSettings) => {
      currentSettings = newSettings;

      if (newSettings.groupChannels?.length) {
        const newChannels = newSettings.groupChannels;
        for (const ch of newChannels) {
          if (!watchedChannels.has(ch)) {
            watchedChannels.add(ch);
            runtime.log?.(`[tlon] Settings: now watching channel ${ch}`);
          }
        }
        // Note: we don't remove channels from watchedChannels to avoid missing messages
        // during transitions. The authorization check handles access control.
      }

      // Recompute effective settings from the latest snapshot so deletions
      // cleanly fall back to file config and empty arrays remain authoritative.
      ({
        effectiveDmAllowlist,
        effectiveShowModelSig,
        effectiveAutoAcceptDmInvites,
        effectiveAutoAcceptGroupInvites,
        effectiveGroupInviteAllowlist,
        effectiveAutoDiscoverChannels,
        effectiveOwnerShip,
        pendingApprovals,
      } = applyTlonSettingsOverrides({
        account,
        currentSettings: newSettings,
        log: (message) => runtime.log?.(message),
      }));
    });

    try {
      await settingsManager.startSubscription();
    } catch (err) {
      // Settings subscription is optional - don't fail if it doesn't work
      runtime.log?.(`[tlon] Settings subscription not available: ${String(err)}`);
    }

    // Subscribe to groups-ui for real-time channel additions (when invites are accepted)
    try {
      await api.subscribe({
        app: "groups",
        path: "/groups/ui",
        event: async (event: unknown) => {
          try {
            const eventRecord = asRecord(event);
            if (!eventRecord) {
              return;
            }

            const join = asRecord(eventRecord.join);
            const joinedChannels = Array.isArray(join?.channels) ? join.channels : [];
            const discoveredChannels = mergeUniqueStrings(
              Object.keys(asRecord(eventRecord.channels) ?? {}),
              joinedChannels.filter((channel): channel is string => typeof channel === "string"),
            ).filter((channel) => channel.startsWith("chat/"));

            for (const channelNest of discoveredChannels) {
              if (!watchedChannels.has(channelNest)) {
                watchedChannels.add(channelNest);
                runtime.log?.(`[tlon] Auto-detected new channel: ${channelNest}`);
              }
            }

            if (!effectiveAutoAcceptGroupInvites) {
              return;
            }
            const currentChannels = currentSettings.groupChannels ?? [];
            const unpersistedChannels = discoveredChannels.filter(
              (channel) => !currentChannels.includes(channel),
            );
            if (unpersistedChannels.length === 0) {
              return;
            }
            const updatedChannels = mergeUniqueStrings(currentChannels, unpersistedChannels);
            await putTlonSetting(api, "groupChannels", updatedChannels);
            // The subscription snapshot lags its poke, so keep back-to-back facts cumulative.
            currentSettings = { ...currentSettings, groupChannels: updatedChannels };
            runtime.log?.(`[tlon] Persisted ${unpersistedChannels.join(", ")} to settings store`);
          } catch (error: unknown) {
            runtime.error?.(`[tlon] Error handling groups-ui event: ${formatErrorMessage(error)}`);
            // SSE advances its durable ack only after this callback resolves.
            throw error;
          }
        },
        err: (error) => {
          runtime.error?.(`[tlon] Groups-ui subscription error: ${String(error)}`);
        },
        quit: () => {
          runtime.log?.("[tlon] Groups-ui subscription ended");
        },
      });
      runtime.log?.("[tlon] Subscribed to groups-ui for real-time channel detection");
    } catch (err) {
      // Groups-ui subscription is optional - channel discovery will still work via polling
      runtime.log?.(`[tlon] Groups-ui subscription failed (will rely on polling): ${String(err)}`);
    }

    // Subscribe to foreigns for auto-accepting group invites
    // Always subscribe so we can hot-reload the setting via settings store
    {
      const processedGroupInvites = new Set<string>();

      const processPendingInvites = async (foreigns: Foreigns, propagateWriteFailures = false) => {
        if (!foreigns || typeof foreigns !== "object") {
          return;
        }

        let firstWriteError: Error | undefined;
        for (const [groupFlag, foreign] of Object.entries(foreigns)) {
          const validInvite = foreign.invites?.find((invite) => invite.valid);
          // Foreigns facts are per-group deltas. Retire only this group's terminal
          // invite so a later invitation can be admitted without replaying other groups.
          if (foreign.progress === "done" || !validInvite) {
            processedGroupInvites.delete(groupFlag);
            continue;
          }
          if (processedGroupInvites.has(groupFlag)) {
            continue;
          }

          const inviterShip = validInvite.from;
          const ownerInvite = isOwner(inviterShip);
          const shouldAccept =
            ownerInvite ||
            (effectiveAutoAcceptGroupInvites &&
              isGroupInviteAllowed(inviterShip, effectiveGroupInviteAllowlist));
          if (shouldAccept) {
            try {
              await api.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: groupFlag,
                  "join-all": true,
                },
              });
              processedGroupInvites.add(groupFlag);
              runtime.log?.(
                ownerInvite
                  ? `[tlon] Auto-accepted group invite from owner: ${groupFlag}`
                  : `[tlon] Auto-accepted group invite: ${groupFlag} (from ${inviterShip})`,
              );
            } catch (err) {
              runtime.error?.(
                ownerInvite
                  ? `[tlon] Failed to accept group invite from owner: ${String(err)}`
                  : `[tlon] Failed to auto-accept group ${groupFlag}: ${String(err)}`,
              );
              if (propagateWriteFailures && firstWriteError === undefined) {
                firstWriteError = err instanceof Error ? err : new Error(formatErrorMessage(err));
              }
            }
            continue;
          }

          if (effectiveOwnerShip) {
            const approval = createPendingApproval({
              type: "group",
              requestingShip: inviterShip,
              groupFlag,
            });
            if (await queueApprovalRequest(approval)) {
              processedGroupInvites.add(groupFlag);
            }
            continue;
          }

          if (effectiveAutoAcceptGroupInvites) {
            runtime.log?.(
              `[tlon] Rejected group invite from ${inviterShip} (not in groupInviteAllowlist): ${groupFlag}`,
            );
            processedGroupInvites.add(groupFlag);
          }
        }

        if (firstWriteError !== undefined) {
          throw firstWriteError;
        }
      };

      if (initForeigns) {
        try {
          await processPendingInvites(initForeigns);
        } catch (error: unknown) {
          runtime.error?.(`[tlon] Error handling initial foreigns: ${formatErrorMessage(error)}`);
        }
      }

      try {
        await api.subscribe({
          app: "groups",
          path: "/v1/foreigns",
          event: async (data: unknown) => {
            try {
              await processPendingInvites(data as Foreigns, true);
            } catch (error: unknown) {
              runtime.error?.(`[tlon] Error handling foreigns event: ${formatErrorMessage(error)}`);
              // SSE advances its durable ack only after this callback resolves.
              throw error;
            }
          },
          err: (error) => {
            runtime.error?.(`[tlon] Foreigns subscription error: ${String(error)}`);
          },
          quit: () => {
            runtime.log?.("[tlon] Foreigns subscription ended");
          },
        });
        runtime.log?.(
          "[tlon] Subscribed to foreigns (/v1/foreigns) for auto-accepting group invites",
        );
      } catch (err) {
        runtime.log?.(`[tlon] Foreigns subscription failed: ${String(err)}`);
      }
    }

    if (effectiveAutoDiscoverChannels) {
      const { channels: discoveredChannels } = await fetchInitData(api, runtime);
      for (const channelNest of discoveredChannels) {
        watchedChannels.add(channelNest);
      }
      runtime.log?.(`[tlon] Watching ${watchedChannels.size} channel(s)`);
    }

    for (const channelNest of watchedChannels) {
      runtime.log?.(`[tlon] Watching channel: ${channelNest}`);
    }

    runtime.log?.("[tlon] All subscriptions registered, connecting to SSE stream...");
    await api.connect();
    ingress.start();
    runtime.log?.("[tlon] Connected! Firehose subscriptions active");

    const pollInterval = setInterval(
      () => {
        void (async () => {
          if (!opts.abortSignal?.aborted) {
            try {
              if (effectiveAutoDiscoverChannels) {
                const { channels: discoveredChannels } = await fetchInitData(api, runtime);
                for (const channelNest of discoveredChannels) {
                  if (!watchedChannels.has(channelNest)) {
                    watchedChannels.add(channelNest);
                    runtime.log?.(`[tlon] Now watching new channel: ${channelNest}`);
                  }
                }
              }
            } catch (error: unknown) {
              runtime.error?.(`[tlon] Channel refresh error: ${formatErrorMessage(error)}`);
            }
          }
        })();
      },
      2 * 60 * 1000,
    );

    // Startup may finish after cancellation, so replay an already-aborted signal
    // and release the discovery timer before running the monitor cleanup.
    await waitUntilAbort(opts.abortSignal, () => {
      clearInterval(pollInterval);
    });
  } finally {
    api.stopReceiving();
    await ingress.stop();
    try {
      await api.close();
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Cleanup error: ${formatErrorMessage(error)}`);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
