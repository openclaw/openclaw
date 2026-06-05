// Signal plugin module implements event handler behavior.
import crypto from "node:crypto";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  buildMentionRegexes,
  buildChannelInboundEventContext,
  createChannelInboundDebouncer,
  formatInboundEnvelope,
  formatInboundFromLabel,
  matchesMentionPatterns,
  resolveInboundMentionDecision,
  resolveEnvelopeFormatOptions,
  runChannelInboundEvent,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth-native";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { settleReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute, resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  resolveSignalApprovalConversationKey,
  resolveSignalApprovalReactionAttempt,
} from "../approval-reactions.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
  type SignalSender,
} from "../identity.js";
import { normalizeSignalMessagingTarget, normalizeSignalUuidForCompare } from "../normalize.js";
import {
  hasSignalSelfReplyEcho,
  rememberSignalSelfReplyEcho,
  resolveSignalSelfReplyMediaEchoText,
} from "../self-reply-echoes.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import type {
  SignalDataMessage,
  SignalEnvelope,
  SignalEventHandlerDeps,
  SignalReactionMessage,
  SignalReceivePayload,
  SignalSentSyncMessage,
} from "./event-handler.types.js";
import { resolveSignalQuoteContext } from "./inbound-context.js";
import { renderSignalMentions } from "./mentions.js";

function isOwnSignalSender(params: {
  sender: SignalSender;
  account?: string;
  accountUuid?: string;
  sourceUuid?: string | null;
}): boolean {
  const normalizedAccount = params.account ? normalizeE164(params.account) : undefined;
  const normalizedAccountUuid = normalizeSignalUuidForCompare(params.accountUuid);
  const normalizedSourceUuid = normalizeSignalUuidForCompare(params.sourceUuid);
  return (
    (params.sender.kind === "phone" &&
      normalizedAccount != null &&
      params.sender.e164 === normalizedAccount) ||
    (normalizedAccountUuid != null &&
      normalizedSourceUuid != null &&
      normalizedSourceUuid === normalizedAccountUuid) ||
    (params.sender.kind === "uuid" &&
      normalizedAccountUuid != null &&
      normalizeSignalUuidForCompare(params.sender.raw) === normalizedAccountUuid)
  );
}

function isSentSyncAddressedToOwnAccount(params: {
  sentMessage: SignalSentSyncMessage;
  account?: string;
  accountUuid?: string;
  sourceNumber?: string | null;
}): boolean {
  const destination = params.sentMessage.destinationNumber ?? params.sentMessage.destination;
  if (
    destination &&
    ((params.account && normalizeE164(destination) === normalizeE164(params.account)) ||
      (!params.account &&
        params.accountUuid &&
        params.sourceNumber &&
        normalizeE164(destination) === normalizeE164(params.sourceNumber)))
  ) {
    return true;
  }
  const destinationUuid = normalizeSignalUuidForCompare(params.sentMessage.destinationUuid);
  const accountUuid = normalizeSignalUuidForCompare(params.accountUuid);
  return Boolean(destinationUuid && accountUuid && destinationUuid === accountUuid);
}

function resolveConfiguredSignalSelfSender(params: {
  account?: string;
  accountUuid?: string;
}): SignalSender | null {
  if (params.account) {
    return {
      kind: "phone",
      raw: params.account,
      e164: normalizeE164(params.account),
    };
  }
  if (params.accountUuid) {
    return { kind: "uuid", raw: params.accountUuid.toLowerCase() };
  }
  return null;
}

function resolveSentSyncDataMessage(sentMessage: SignalSentSyncMessage): SignalDataMessage | null {
  if (sentMessage.dataMessage) {
    return sentMessage.dataMessage;
  }
  if (sentMessage.editMessage?.dataMessage) {
    return sentMessage.editMessage.dataMessage;
  }
  if (sentMessage.message && typeof sentMessage.message === "object") {
    return sentMessage.message;
  }
  const hasUnwrappedDataMessageFields = Boolean(
    sentMessage.attachments?.length ||
    sentMessage.mentions?.length ||
    sentMessage.groupInfo ||
    sentMessage.quote ||
    sentMessage.reaction,
  );
  if (typeof sentMessage.message !== "string" && !hasUnwrappedDataMessageFields) {
    return null;
  }
  return {
    timestamp: sentMessage.timestamp ?? undefined,
    message: typeof sentMessage.message === "string" ? sentMessage.message : "",
    attachments: sentMessage.attachments ?? [],
    mentions: sentMessage.mentions ?? [],
    groupInfo: sentMessage.groupInfo ?? null,
    quote: sentMessage.quote ?? null,
    reaction: sentMessage.reaction ?? null,
  };
}

function resolveSelfReplyEchoText(dataMessage: SignalDataMessage | null): string | undefined {
  const text = dataMessage?.message?.trim();
  if (text) {
    return dataMessage?.message ?? undefined;
  }
  const firstAttachment = dataMessage?.attachments?.[0];
  if (!firstAttachment) {
    return undefined;
  }
  const mediaEchoText = resolveSignalSelfReplyMediaEchoText({
    contentType: firstAttachment.contentType,
    size: firstAttachment.size,
  });
  if (mediaEchoText) {
    return mediaEchoText;
  }
  if ((dataMessage?.attachments?.length ?? 0) > 1) {
    return formatAttachmentSummaryPlaceholder(
      dataMessage?.attachments?.map((attachment) => attachment.contentType) ?? [],
    );
  }
  const kind = kindFromMime(firstAttachment.contentType ?? undefined);
  return kind ? `<media:${kind}>` : "<media:attachment>";
}

function resolveEditedSelfReplyEchoId(params: {
  timestamp?: number;
  text?: string;
}): string | undefined {
  if (typeof params.timestamp !== "number" || !Number.isFinite(params.timestamp)) {
    return undefined;
  }
  const text = params.text?.trim();
  if (!text) {
    return undefined;
  }
  const textHash = crypto.createHash("sha256").update(text).digest("base64url").slice(0, 32);
  return `edit:${params.timestamp}:${textHash}`;
}

function resolveNoteToSelfDataMessage(params: {
  envelope: SignalEnvelope;
  isOwnMessage: boolean;
  noteToSelfMode: boolean;
  account?: string;
  accountUuid?: string;
}): { envelope: SignalEnvelope; dataMessage: SignalDataMessage | null; isEdit?: boolean } | null {
  if ("syncMessage" in params.envelope) {
    if (!params.noteToSelfMode) {
      return null;
    }
    const sentMessage = params.envelope.syncMessage?.sentMessage;
    const addressedToOwnAccount = sentMessage
      ? isSentSyncAddressedToOwnAccount({
          sentMessage,
          account: params.account,
          accountUuid: params.accountUuid,
          sourceNumber: params.envelope.sourceNumber,
        })
      : false;
    if (
      !sentMessage ||
      (!params.isOwnMessage && !addressedToOwnAccount) ||
      !addressedToOwnAccount
    ) {
      return null;
    }
    const dataMessage = resolveSentSyncDataMessage(sentMessage);
    if (!dataMessage) {
      return null;
    }
    return {
      envelope: {
        ...params.envelope,
        timestamp: params.envelope.timestamp ?? sentMessage?.timestamp ?? undefined,
      },
      dataMessage,
      isEdit: Boolean(sentMessage.editMessage?.dataMessage),
    };
  }
  if (params.isOwnMessage) {
    return null;
  }
  return {
    envelope: params.envelope,
    dataMessage: params.envelope.dataMessage ?? params.envelope.editMessage?.dataMessage ?? null,
  };
}

function formatAttachmentKindCount(kind: string, count: number): string {
  if (kind === "attachment") {
    return `${count} file${count > 1 ? "s" : ""}`;
  }
  return `${count} ${kind}${count > 1 ? "s" : ""}`;
}

function formatAttachmentSummaryPlaceholder(contentTypes: Array<string | undefined>): string {
  const kindCounts = new Map<string, number>();
  for (const contentType of contentTypes) {
    const kind = kindFromMime(contentType) ?? "attachment";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const parts = [...kindCounts.entries()].map(([kind, count]) =>
    formatAttachmentKindCount(kind, count),
  );
  return `[${parts.join(" + ")} attached]`;
}

function resolveSignalInboundRoute(params: {
  cfg: SignalEventHandlerDeps["cfg"];
  accountId: SignalEventHandlerDeps["accountId"];
  isGroup: boolean;
  groupId?: string;
  senderPeerId: string;
}) {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? (params.groupId ?? "unknown") : params.senderPeerId,
    },
  });
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  const noteToSelfMode = deps.ingressMode === "note-to-self";

  async function isKnownSelfReplyEcho(
    envelope: SignalEnvelope,
    dataMessage: SignalDataMessage | null,
    options?: { ignorePrimaryId?: boolean },
  ) {
    if (!noteToSelfMode) {
      return false;
    }
    const timestamp =
      typeof envelope.timestamp === "number"
        ? envelope.timestamp
        : typeof dataMessage?.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    const echoText = resolveSelfReplyEchoText(dataMessage);
    const editedEchoId = options?.ignorePrimaryId
      ? resolveEditedSelfReplyEchoId({ timestamp, text: echoText })
      : undefined;
    return await hasSignalSelfReplyEcho({
      accountId: deps.accountId,
      accountIdentity: deps.accountUuid ?? deps.account,
      messageId:
        editedEchoId ??
        (!options?.ignorePrimaryId && timestamp != null ? String(timestamp) : undefined),
      timestamp: options?.ignorePrimaryId ? undefined : timestamp,
      text: echoText,
      includeTextWithPrimary: true,
    });
  }

  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    commandBody: string;
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    commandAuthorized: boolean;
    wasMentioned?: boolean;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    recordSelfEchoAfterDispatch?: boolean;
    selfEchoRecords?: Array<{ messageId?: string; timestamp?: number; text: string }>;
  };

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? undefined,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Group",
      directLabel: entry.senderName,
      directId: entry.senderDisplay,
    });
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup: entry.isGroup,
      groupId: entry.groupId,
      senderPeerId: entry.senderPeerId,
    });
    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: entry.timestamp ?? undefined,
      body: entry.bodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? (entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey) {
      const channelHistory = createChannelHistoryWindow({ historyMap: deps.groupHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: deps.historyLimit,
        currentMessage: combinedBody,
        formatEntry: (historyEntry) =>
          formatInboundEnvelope({
            channel: "Signal",
            from: fromLabel,
            timestamp: historyEntry.timestamp,
            body: `${historyEntry.body}${
              historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""
            }`,
            chatType: "group",
            senderLabel: historyEntry.sender,
            envelope: envelopeOptions,
          }),
      });
    }
    const signalToRaw = entry.isGroup
      ? `group:${entry.groupId}`
      : `signal:${entry.senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory =
      entry.isGroup && historyKey && deps.historyLimit > 0
        ? createChannelHistoryWindow({ historyMap: deps.groupHistories }).buildInboundHistory({
            historyKey,
            limit: deps.historyLimit,
          })
        : undefined;
    const media =
      entry.mediaPaths && entry.mediaPaths.length > 0
        ? entry.mediaPaths.map((path, index) => ({
            path,
            url: path,
            contentType: entry.mediaTypes?.[index],
          }))
        : entry.mediaPath
          ? [{ path: entry.mediaPath, url: entry.mediaPath, contentType: entry.mediaType }]
          : undefined;
    const ctxPayload = buildChannelInboundEventContext({
      channel: "signal",
      supplemental: {
        quote: entry.replyToBody
          ? {
              body: entry.replyToBody,
              sender: entry.replyToSender,
              isQuote: entry.replyToIsQuote,
            }
          : undefined,
      },
      messageId: entry.messageId,
      timestamp: entry.timestamp ?? undefined,
      from: entry.isGroup
        ? `group:${entry.groupId ?? "unknown"}`
        : `signal:${entry.senderRecipient}`,
      sender: {
        id: entry.senderDisplay,
        name: entry.senderName,
      },
      conversation: {
        kind: entry.isGroup ? "group" : "direct",
        id: entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderRecipient,
        label: fromLabel,
      },
      route: {
        agentId: route.agentId,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: signalTo,
      },
      message: {
        body: combinedBody,
        bodyForAgent: entry.bodyText,
        inboundHistory,
        rawBody: entry.bodyText,
        commandBody: entry.commandBody,
      },
      access: {
        ...(entry.isGroup
          ? {
              mentions: {
                canDetectMention: true,
                wasMentioned: entry.wasMentioned === true,
              },
            }
          : {}),
        commands: {
          authorized: entry.commandAuthorized,
        },
      },
      media,
      extra: {
        GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
      },
    });

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\\n/g, "\\\\n");
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }

    const { onModelSelected, typingCallbacks, ...replyPipeline } =
      createChannelMessageReplyPipeline({
        cfg: deps.cfg,
        agentId: route.agentId,
        channel: "signal",
        accountId: route.accountId,
        typing: {
          start: async () => {
            if (!ctxPayload.To) {
              return;
            }
            await sendTypingSignal(ctxPayload.To, {
              cfg: deps.cfg,
              baseUrl: deps.baseUrl,
              account: deps.account,
              accountId: deps.accountId,
            });
          },
          onStartError: (err) => {
            logTypingFailure({
              log: logVerbose,
              channel: "signal",
              target: ctxPayload.To ?? undefined,
              error: err,
            });
          },
        },
      });

    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      typingCallbacks,
      deliver: async (payload, _info) => {
        await deps.deliverReplies({
          cfg: deps.cfg,
          replies: [payload],
          target: ctxPayload.To,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountUuid: deps.accountUuid,
          accountId: deps.accountId,
          runtime: deps.runtime,
          maxBytes: deps.mediaMaxBytes,
          textLimit: deps.textLimit,
        });
      },
      onError: (err, info) => {
        deps.runtime.error?.(danger(`signal ${info.kind} reply failed: ${String(err)}`));
      },
    });
    const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
      route,
      sessionKey: route.sessionKey,
    });

    await runChannelInboundEvent({
      channel: "signal",
      accountId: route.accountId,
      raw: entry,
      adapter: {
        ingest: () => ({
          id: entry.messageId ?? `${entry.timestamp ?? Date.now()}`,
          timestamp: entry.timestamp,
          rawText: entry.bodyText,
          raw: entry,
        }),
        resolveTurn: () => ({
          channel: "signal",
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession,
          record: {
            updateLastRoute: !entry.isGroup
              ? {
                  sessionKey: inboundLastRouteSessionKey,
                  channel: "signal",
                  to: entry.senderRecipient,
                  accountId: route.accountId,
                  mainDmOwnerPin: (() => {
                    if (inboundLastRouteSessionKey !== route.mainSessionKey) {
                      return undefined;
                    }
                    const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
                      dmScope: deps.cfg.session?.dmScope,
                      allowFrom: deps.allowFrom,
                      normalizeEntry: normalizeSignalAllowRecipient,
                    });
                    if (!pinnedOwner) {
                      return undefined;
                    }
                    return {
                      ownerRecipient: pinnedOwner,
                      senderRecipient: entry.senderRecipient,
                      onSkip: ({ ownerRecipient, senderRecipient }) => {
                        logVerbose(
                          `signal: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                        );
                      },
                    };
                  })(),
                }
              : undefined,
            onRecordError: (err) => {
              logVerbose(`signal: failed updating session meta: ${String(err)}`);
            },
          },
          history: {
            isGroup: entry.isGroup,
            historyKey,
            historyMap: deps.groupHistories,
            limit: deps.historyLimit,
          },
          onPreDispatchFailure: () =>
            settleReplyDispatcher({
              dispatcher,
              onSettled: () => markDispatchIdle(),
            }),
          runDispatch: async () => {
            try {
              return await dispatchInboundMessage({
                ctx: ctxPayload,
                cfg: deps.cfg,
                dispatcher,
                replyOptions: {
                  ...replyOptions,
                  disableBlockStreaming:
                    typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : undefined,
                  onModelSelected,
                },
              });
            } finally {
              markDispatchIdle();
            }
          },
        }),
      },
    });
    if (entry.recordSelfEchoAfterDispatch) {
      const records = entry.selfEchoRecords ?? [
        { messageId: entry.messageId, timestamp: entry.timestamp, text: entry.bodyText },
      ];
      for (const record of records) {
        if (!record.messageId && record.timestamp == null && !record.text.trim()) {
          continue;
        }
        await rememberSignalSelfReplyEcho({
          accountId: deps.accountId,
          accountIdentity: deps.accountUuid ?? deps.account,
          messageId: record.messageId,
          timestamp: record.timestamp,
          text: record.text,
        });
      }
    }
  }

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<SignalInboundEntry>({
    cfg: deps.cfg,
    channel: "signal",
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      return shouldDebounceTextInbound({
        text: entry.bodyText,
        cfg: deps.cfg,
        hasMedia: Boolean(entry.mediaPath || entry.mediaType || entry.mediaPaths?.length),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join("\\n");
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: undefined,
        mediaType: undefined,
        mediaPaths: undefined,
        mediaTypes: undefined,
        selfEchoRecords: entries.flatMap((entry) => entry.selfEchoRecords ?? []),
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  async function handleReactionOnlyInbound(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    conversationSender?: SignalSender;
    senderDisplay: string;
    reaction: SignalReactionMessage;
    hasBodyContent: boolean;
    suppressNotification?: boolean;
    accessDecision: { decision: "allow" | "block" | "pairing"; reasonCode: string };
  }): Promise<boolean> {
    if (params.hasBodyContent) {
      return false;
    }
    if (params.reaction.isRemove) {
      return true; // Ignore reaction removals
    }
    const emojiLabel = normalizeOptionalString(params.reaction.emoji) ?? "emoji";
    const senderName = params.envelope.sourceName ?? params.senderDisplay;
    logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
    const groupId = params.reaction.groupInfo?.groupId ?? undefined;
    const groupName = params.reaction.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const messageId = params.reaction.targetSentTimestamp
      ? String(params.reaction.targetSentTimestamp)
      : "unknown";
    const conversationSender = params.conversationSender ?? params.sender;
    const conversationKey = resolveSignalApprovalConversationKey(
      groupId ? `group:${groupId}` : `signal:${resolveSignalRecipient(conversationSender)}`,
    );
    const conversationKeys = new Set<string>();
    if (conversationKey) {
      conversationKeys.add(conversationKey);
    }
    const isOwnReactionSender = isOwnSignalSender({
      sender: params.sender,
      account: deps.account,
      accountUuid: deps.accountUuid,
      sourceUuid: params.envelope.sourceUuid,
    });
    const actorIds = Array.from(
      new Set(
        [
          isOwnReactionSender && deps.account ? normalizeE164(deps.account) : null,
          isOwnReactionSender && deps.accountUuid
            ? `uuid:${normalizeSignalUuidForCompare(deps.accountUuid)}`
            : null,
          params.sender.kind === "uuid"
            ? `uuid:${normalizeSignalUuidForCompare(params.sender.raw)}`
            : formatSignalSenderId(params.sender),
        ].filter((id): id is string => Boolean(id)),
      ),
    );
    if (!groupId && noteToSelfMode && isOwnReactionSender) {
      const accountConversationKey = deps.account
        ? resolveSignalApprovalConversationKey(`signal:${normalizeE164(deps.account)}`)
        : undefined;
      if (accountConversationKey) {
        conversationKeys.add(accountConversationKey);
      }
      const accountUuidConversationKey = deps.accountUuid
        ? resolveSignalApprovalConversationKey(`signal:${deps.accountUuid}`)
        : undefined;
      if (accountUuidConversationKey) {
        conversationKeys.add(accountUuidConversationKey);
      }
    }
    const targetAuthorUuid = normalizeSignalUuidForCompare(params.reaction.targetAuthorUuid);
    const accountUuid = normalizeSignalUuidForCompare(deps.accountUuid);
    if (!groupId && targetAuthorUuid && accountUuid && targetAuthorUuid === accountUuid) {
      const uuidConversationKey = resolveSignalApprovalConversationKey(`signal:${accountUuid}`);
      if (uuidConversationKey) {
        conversationKeys.add(uuidConversationKey);
      }
    }
    let handledApprovalReaction = false;
    for (const key of conversationKeys) {
      for (const actorId of actorIds) {
        const approvalAttempt = await resolveSignalApprovalReactionAttempt({
          cfg: deps.cfg,
          accountId: deps.accountId,
          conversationKey: key,
          messageId,
          reactionKey: emojiLabel,
          actorId,
          targetAuthor: params.reaction.targetAuthor,
          targetAuthorUuid: params.reaction.targetAuthorUuid,
          logVerboseMessage: logVerbose,
        });
        if (approvalAttempt === "resolved") {
          return true;
        }
        handledApprovalReaction ||= approvalAttempt === "denied";
      }
    }
    if (handledApprovalReaction) {
      return true;
    }
    if (params.accessDecision.decision !== "allow") {
      logVerbose(
        `Blocked signal reaction sender ${params.senderDisplay} (${params.accessDecision.reasonCode})`,
      );
      return true;
    }
    if (params.suppressNotification) {
      return true;
    }
    const targets = deps.resolveSignalReactionTargets(params.reaction);
    const shouldNotify = deps.shouldEmitSignalReactionNotification({
      mode: deps.reactionMode,
      account: deps.account,
      accountUuid: deps.accountUuid,
      targets,
      sender: params.sender,
      allowlist: deps.reactionAllowlist,
    });
    if (!shouldNotify) {
      return true;
    }

    const senderPeerId = resolveSignalPeerId(params.sender);
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId,
    });
    const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
    const text = deps.buildSignalReactionSystemEventText({
      emojiLabel,
      actorLabel: senderName,
      messageId,
      targetLabel: targets[0]?.display,
      groupLabel,
    });
    const senderId = formatSignalSenderId(params.sender);
    const contextKey = [
      "signal",
      "reaction",
      "added",
      messageId,
      senderId,
      emojiLabel,
      groupId ?? "",
    ]
      .filter(Boolean)
      .join(":");
    enqueueSystemEvent(text, {
      sessionKey: route.sessionKey,
      contextKey,
    });
    return true;
  }

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }

    let payload: SignalReceivePayload | null;
    try {
      payload = JSON.parse(event.data) as SignalReceivePayload;
    } catch (err) {
      deps.runtime.error?.(`failed to parse event: ${String(err)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }

    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }

    const isOwnMessage = isOwnSignalSender({
      sender,
      account: deps.account,
      accountUuid: deps.accountUuid,
      sourceUuid: envelope.sourceUuid,
    });
    const resolvedMessage = resolveNoteToSelfDataMessage({
      envelope,
      isOwnMessage,
      noteToSelfMode,
      account: deps.account,
      accountUuid: deps.accountUuid,
    });
    if (!resolvedMessage) {
      return;
    }
    const resolvedEnvelope = resolvedMessage.envelope;
    const dataMessage = resolvedMessage.dataMessage;
    const noteToSelfOwnMessage =
      noteToSelfMode && (isOwnMessage || "syncMessage" in resolvedEnvelope);
    if (
      noteToSelfOwnMessage &&
      (await isKnownSelfReplyEcho(resolvedEnvelope, dataMessage, {
        ignorePrimaryId: resolvedMessage.isEdit,
      }))
    ) {
      return;
    }

    const reaction = deps.isSignalReactionMessage(resolvedEnvelope.reactionMessage)
      ? resolvedEnvelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;

    // Replace ￼ (object replacement character) with @uuid or @phone from mentions
    // Signal encodes mentions as the object replacement character; hydrate them from metadata first.
    const rawMessage = dataMessage?.message ?? "";
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();
    const groupId = dataMessage?.groupInfo?.groupId ?? reaction?.groupInfo?.groupId ?? undefined;
    const isGroup = Boolean(groupId);
    const hasControlCommandInMessage = hasControlCommand(messageText, deps.cfg);

    const senderDisplay = formatSignalSenderDisplay(sender);
    const senderAllowId = formatSignalSenderId(sender);
    const noteToSelfDirectMessage = noteToSelfOwnMessage && !isGroup;
    const { senderAccess, commandAccess } = await resolveSignalAccessState({
      accountId: deps.accountId,
      dmPolicy: noteToSelfDirectMessage ? "allowlist" : deps.dmPolicy,
      groupPolicy: deps.groupPolicy,
      allowFrom: noteToSelfDirectMessage ? [senderAllowId] : deps.allowFrom,
      groupAllowFrom: deps.groupAllowFrom,
      sender,
      groupId,
      isGroup,
      cfg: deps.cfg,
      hasControlCommand: hasControlCommandInMessage,
    });
    const quoteText = normalizeOptionalString(dataMessage?.quote?.text) ?? "";
    const { contextVisibilityMode, quoteSenderAllowed, visibleQuoteText, visibleQuoteSender } =
      resolveSignalQuoteContext({
        cfg: deps.cfg,
        accountId: deps.accountId,
        isGroup,
        dataMessage,
        effectiveGroupAllow: senderAccess.effectiveGroupAllowFrom,
      });
    if (quoteText && !visibleQuoteText && isGroup) {
      logVerbose(
        `signal: drop quote context (mode=${contextVisibilityMode}, sender_allowed=${quoteSenderAllowed ? "yes" : "no"})`,
      );
    }
    const hasBodyContent =
      Boolean(messageText || visibleQuoteText) ||
      Boolean(!reaction && dataMessage?.attachments?.length);

    if (
      reaction &&
      (await handleReactionOnlyInbound({
        envelope: resolvedEnvelope,
        sender,
        senderDisplay,
        reaction,
        hasBodyContent,
        suppressNotification: noteToSelfOwnMessage && "syncMessage" in resolvedEnvelope,
        accessDecision: senderAccess,
      }))
    ) {
      return;
    }
    if (!dataMessage) {
      return;
    }

    const routingSender = noteToSelfDirectMessage
      ? (resolveConfiguredSignalSelfSender({
          account: deps.account,
          accountUuid: deps.accountUuid,
        }) ?? sender)
      : sender;
    const senderRecipient = resolveSignalRecipient(routingSender);
    const senderPeerId = resolveSignalPeerId(routingSender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;

    if (!isGroup) {
      const allowedDirectMessage = await handleSignalDirectMessageAccess({
        dmPolicy: deps.dmPolicy,
        dmAccessDecision: senderAccess.decision,
        senderId: senderAllowId,
        senderIdLine,
        senderDisplay,
        senderName: resolvedEnvelope.sourceName ?? undefined,
        accountId: deps.accountId,
        sendPairingReply: async (text) => {
          await sendMessageSignal(`signal:${senderRecipient}`, text, {
            cfg: deps.cfg,
            baseUrl: deps.baseUrl,
            account: deps.account,
            configPath: deps.configPath,
            maxBytes: deps.mediaMaxBytes,
            accountId: deps.accountId,
          });
        },
        log: logVerbose,
      });
      if (!allowedDirectMessage) {
        return;
      }
    }
    if (isGroup) {
      if (senderAccess.decision !== "allow") {
        if (senderAccess.reasonCode === "group_policy_disabled") {
          logVerbose("Blocked signal group message (groupPolicy: disabled)");
        } else if (senderAccess.reasonCode === "group_policy_empty_allowlist") {
          logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        } else {
          logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        }
        return;
      }
    }

    const commandAuthorized = commandAccess.authorized;
    if (isGroup && commandAccess.shouldBlockControlCommand) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId,
    });
    const mentionRegexes = buildMentionRegexes(deps.cfg, route.agentId);
    const wasMentioned = isGroup && matchesMentionPatterns(messageText, mentionRegexes);
    const requireMention =
      isGroup &&
      resolveChannelGroupRequireMention({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
        configuredGroupDefaultsToNoMention: true,
      });
    const canDetectMention = mentionRegexes.length > 0;
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention,
        wasMentioned,
        hasAnyMention: false,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup,
        requireMention,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized,
      },
    });
    const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
    if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "no mention",
        target: senderDisplay,
      });
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        // When we're skipping a message we intentionally avoid downloading attachments.
        // Still record a useful placeholder for pending-history context.
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const attachmentTypes = (dataMessage.attachments ?? []).map((attachment) =>
          typeof attachment?.contentType === "string" ? attachment.contentType : undefined,
        );
        if (attachmentTypes.length > 1) {
          return formatAttachmentSummaryPlaceholder(attachmentTypes);
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = kindFromMime(firstContentType ?? undefined);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = messageText || pendingPlaceholder || visibleQuoteText;
      const historyKey = groupId ?? "unknown";
      createChannelHistoryWindow({ historyMap: deps.groupHistories }).record({
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: resolvedEnvelope.sourceName ?? senderDisplay,
          body: pendingBodyText,
          timestamp: resolvedEnvelope.timestamp ?? undefined,
          messageId:
            typeof resolvedEnvelope.timestamp === "number"
              ? String(resolvedEnvelope.timestamp)
              : undefined,
        },
      });
      const signalGroupPolicy = resolveChannelGroupPolicy({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
      });
      if (
        (signalGroupPolicy.groupConfig?.ingest ?? signalGroupPolicy.defaultConfig?.ingest) === true
      ) {
        const canonicalGroupTarget =
          normalizeSignalMessagingTarget(`group:${groupId}`) ?? `group:${groupId}`;
        fireAndForgetHook(
          triggerInternalHook(
            createInternalHookEvent(
              "message",
              "received",
              route.sessionKey,
              toInternalMessageReceivedContext({
                from: `group:${groupId}`,
                to: canonicalGroupTarget,
                content: pendingBodyText,
                timestamp: resolvedEnvelope.timestamp ?? undefined,
                channelId: "signal",
                accountId: deps.accountId,
                conversationId: canonicalGroupTarget,
                messageId:
                  typeof resolvedEnvelope.timestamp === "number"
                    ? String(resolvedEnvelope.timestamp)
                    : undefined,
                senderId: senderDisplay,
                senderName: resolvedEnvelope.sourceName ?? undefined,
                provider: "signal",
                surface: "signal",
                originatingChannel: "signal",
                originatingTo: canonicalGroupTarget,
                isGroup: true,
                groupId: canonicalGroupTarget,
              }),
            ),
          ),
          "signal: mention-skip message hook failed",
        );
      }
      return;
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    let placeholder = "";
    const attachments = dataMessage.attachments ?? [];
    if (!deps.ignoreAttachments) {
      for (const attachment of attachments) {
        if (!attachment?.id) {
          continue;
        }
        try {
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment,
            sender: senderRecipient,
            groupId,
            maxBytes: deps.mediaMaxBytes,
          });
          if (fetched) {
            mediaPaths.push(fetched.path);
            mediaTypes.push(
              fetched.contentType ?? attachment.contentType ?? "application/octet-stream",
            );
            if (!mediaPath) {
              mediaPath = fetched.path;
              mediaType = fetched.contentType ?? attachment.contentType ?? undefined;
            }
          }
        } catch (err) {
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
        }
      }
    }

    if (mediaPaths.length > 1) {
      placeholder = formatAttachmentSummaryPlaceholder(mediaTypes);
    } else {
      const kind = kindFromMime(mediaType ?? undefined);
      if (kind) {
        placeholder = `<media:${kind}>`;
      } else if (attachments.length) {
        placeholder = "<media:attachment>";
      }
    }

    const bodyText = messageText || placeholder || visibleQuoteText || "";
    if (!bodyText) {
      return;
    }

    const receiptTimestamp =
      typeof resolvedEnvelope.timestamp === "number"
        ? resolvedEnvelope.timestamp
        : typeof dataMessage.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && receiptTimestamp) {
      try {
        await sendReadReceiptSignal(`signal:${senderRecipient}`, receiptTimestamp, {
          cfg: deps.cfg,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
        });
      } catch (err) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      }
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !receiptTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const senderName = resolvedEnvelope.sourceName ?? senderDisplay;
    const messageId =
      typeof resolvedEnvelope.timestamp === "number"
        ? String(resolvedEnvelope.timestamp)
        : undefined;
    const editedSelfEchoId = resolvedMessage.isEdit
      ? resolveEditedSelfReplyEchoId({
          timestamp: resolvedEnvelope.timestamp ?? undefined,
          text: resolveSelfReplyEchoText(dataMessage),
        })
      : undefined;
    const editedSelfEchoText = resolvedMessage.isEdit
      ? resolveSelfReplyEchoText(dataMessage)
      : undefined;
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      commandBody: messageText,
      timestamp: resolvedEnvelope.timestamp ?? undefined,
      messageId,
      mediaPath,
      mediaType,
      mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
      replyToBody: visibleQuoteText || undefined,
      replyToSender: visibleQuoteSender,
      replyToIsQuote: visibleQuoteText ? true : undefined,
      recordSelfEchoAfterDispatch: noteToSelfDirectMessage && "syncMessage" in resolvedEnvelope,
      selfEchoRecords:
        noteToSelfDirectMessage && "syncMessage" in resolvedEnvelope
          ? [
              resolvedMessage.isEdit
                ? { messageId: editedSelfEchoId, text: editedSelfEchoText ?? bodyText }
                : { messageId, timestamp: resolvedEnvelope.timestamp ?? undefined, text: bodyText },
            ]
          : undefined,
    });
  };
}
