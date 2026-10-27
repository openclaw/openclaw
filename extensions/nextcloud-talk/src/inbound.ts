import {
  createChannelInboundEnvelopeBuilderAsync,
  filterChannelInboundQuoteContext,
  formatInboundMediaUnavailableText,
  resolveInboundSupplementalSenderAllowed,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  type ChannelIngressContextBinding,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  bindIngressLifecycleToReplyOptions,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { expandAllowFromWithAccessGroups } from "openclaw/plugin-sdk/security-runtime";
import {
  isRecord,
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  createChannelPairingController,
  logInboundDrop,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type OpenClawConfig,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  classifyNextcloudTalkMediaFailure,
  isNextcloudTalkMediaSenderAllowed,
  logNextcloudTalkMediaNonOutcome,
  resolveNextcloudTalkAttachmentReference,
  resolveNextcloudTalkAuthenticatedMediaSource,
  resolveNextcloudTalkMediaMaxBytes,
  saveNextcloudTalkInboundMedia,
} from "./inbound-media.js";
import {
  normalizeNextcloudTalkAllowEntry,
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkGroupRequireMention,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";
import { canonicalizeNextcloudTalkNativeVoiceMedia } from "./voice-media.js";

const CHANNEL_ID = "nextcloud-talk" as const;

function hasAllowEntries(entries: string[]): boolean {
  return normalizeNextcloudTalkAllowlist(entries).length > 0;
}

export async function handleNextcloudTalkInbound(params: {
  message: NextcloudTalkInboundMessage;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  turnAdoptionLifecycle?: Parameters<typeof bindIngressLifecycleToReplyOptions>[0];
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const ingressAbortSignal = params.turnAdoptionLifecycle?.abortSignal;
  ingressAbortSignal?.throwIfAborted();
  const core = getNextcloudTalkRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  const hasInboundMedia = Boolean(message.attachment || message.attachmentIssue);
  if (!rawBody && !hasInboundMedia) {
    logInboundDrop({
      log: (messageLocal) => runtime.log?.(messageLocal),
      channel: CHANNEL_ID,
      reason: `empty message body (mediaType=${message.mediaType})`,
      target: message.senderId,
    });
    return;
  }

  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime,
  });
  const isGroup = roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
  const { senderId, senderName, roomToken, roomName } = message;

  statusSink?.({ lastInboundAt: message.timestamp });

  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
  });
  const roomConfig = roomMatch.roomConfig;
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  // Talk encodes message text and rich parameters inside object.content. Keep
  // the raw payload for the agent; command detection and execution share decoded text.
  const structuredBody = rawBody.startsWith("{") ? safeParseJson<unknown>(rawBody) : undefined;
  const structuredText =
    isRecord(structuredBody) && Object.hasOwn(structuredBody, "parameters")
      ? normalizeOptionalString(structuredBody.message)
      : undefined;
  const commandBody = structuredText?.startsWith("/") ? structuredText : rawBody;
  const hasControlCommand = core.channel.text.hasControlCommand(
    commandBody,
    config as OpenClawConfig,
  );
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkGroupRequireMention({
        cfg: config as OpenClawConfig,
        accountId: account.accountId,
        groupId: roomToken,
      })
    : false;
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] ?? undefined) !==
        undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(config as OpenClawConfig),
    });
  const allowFrom = normalizeStringEntries(account.config.allowFrom);
  const outerGroupAllowFrom = account.config.groupAllowFrom?.length
    ? normalizeStringEntries(account.config.groupAllowFrom)
    : allowFrom;
  const roomAllowFrom = normalizeStringEntries(roomConfig?.allowFrom);
  const resolveAccess = async (
    wasMentioned?: boolean,
    contextBinding?: ChannelIngressContextBinding,
  ) =>
    await core.channel.inbound.ingress.resolveStable({
      channelId: CHANNEL_ID,
      accountId: account.accountId,
      identity: {
        key: "nextcloud-talk-user-id",
        normalize: (value) => normalizeNextcloudTalkAllowEntry(value) || null,
        sensitivity: "pii",
        entryIdPrefix: "nextcloud-talk-entry",
      },
      cfg: config as OpenClawConfig,
      readStoreAllowFrom: async () =>
        await pairing.readStoreForDmPolicy(CHANNEL_ID, account.accountId),
      subject: { stableId: senderId },
      conversation: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? roomToken : senderId,
      },
      contextBinding,
      route: isGroup
        ? channelIngressRoutes(
            roomMatch.allowlistConfigured && {
              id: "nextcloud-talk:room",
              allowed: roomMatch.allowed,
              precedence: 0,
              matchId: "nextcloud-talk-room",
              blockReason: "room_not_allowlisted",
            },
            roomConfig?.enabled === false && {
              id: "nextcloud-talk:room-enabled",
              enabled: false,
              precedence: 10,
              blockReason: "room_disabled",
            },
            groupPolicy === "allowlist" &&
              hasAllowEntries(roomAllowFrom) && {
                id: "nextcloud-talk:room-sender",
                kind: "nestedAllowlist",
                precedence: 20,
                blockReason: "room_sender_not_allowlisted",
                ...(!hasAllowEntries(outerGroupAllowFrom)
                  ? {
                      senderPolicy: "replace" as const,
                      senderAllowFrom: roomAllowFrom,
                    }
                  : {
                      allowed: resolveNextcloudTalkAllowlistMatch({
                        allowFrom: roomAllowFrom,
                        senderId,
                      }).allowed,
                      matchId: "nextcloud-talk-room-sender",
                    }),
              },
          )
        : [],
      dmPolicy: account.config.dmPolicy ?? "pairing",
      groupPolicy,
      policy: {
        groupAllowFromFallbackToAllowFrom: true,
        activation: {
          requireMention: isGroup && shouldRequireMention,
          allowTextCommands,
        },
      },
      mentionFacts:
        isGroup && wasMentioned !== undefined
          ? {
              canDetectMention: true,
              wasMentioned,
              hasAnyMention: wasMentioned,
            }
          : undefined,
      allowFrom,
      groupAllowFrom: account.config.groupAllowFrom,
      command: {
        allowTextCommands,
        hasControlCommand,
      },
    });
  let access = await resolveAccess();
  const logAuthorizationChanged = () => {
    runtime.log?.(
      isGroup && access.activationAccess.shouldSkip
        ? `nextcloud-talk: drop room ${roomToken} (no mention)`
        : `nextcloud-talk: drop ${isGroup ? "room" : "DM"} ${roomToken} (authorization changed)`,
    );
  };
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "nextcloud-talk",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (messageValue) => runtime.log?.(messageValue),
  });
  const accessReason =
    access.ingress.reasonCode === "route_blocked"
      ? "route blocked"
      : access.senderAccess.reasonCode;
  const ignoreOwnOutboundFileShare = async () => {
    if (!message.attachment) {
      return false;
    }
    const { isNextcloudTalkOutboundFileEcho } = await import("./outbound-media.js");
    const echo = await isNextcloudTalkOutboundFileEcho({
      account,
      message,
      signal: ingressAbortSignal,
    });
    if (echo) {
      runtime.log?.("nextcloud-talk: ignored own outbound file share");
    }
    return echo;
  };

  if (isGroup) {
    if (access.routeAccess.reason === "room_not_allowlisted") {
      runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
      return;
    }
    if (access.routeAccess.reason === "room_disabled") {
      runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
      return;
    }
    if (access.routeAccess.reason === "room_sender_not_allowlisted") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
    if (access.senderAccess.decision !== "allow") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${accessReason})`);
      return;
    }
  } else if (access.senderAccess.decision !== "allow") {
    if (access.senderAccess.decision === "pairing") {
      // An unpaired API user's own file share is an echo, not a pairing request.
      if (await ignoreOwnOutboundFileShare()) {
        return;
      }
      ingressAbortSignal?.throwIfAborted();
      await pairing.issueChallenge({
        senderId,
        senderIdLine: `Your Nextcloud user id: ${senderId}`,
        meta: { name: senderName || undefined },
        sendPairingReply: async (text) => {
          await sendMessageNextcloudTalk(roomToken, text, {
            cfg: config,
            accountId: account.accountId,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        onReplyError: (err) => {
          runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
        },
      });
    }
    runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${accessReason})`);
    return;
  }

  if (access.commandAccess.shouldBlockControlCommand) {
    logInboundDrop({
      log: (messageLocal) => runtime.log?.(messageLocal),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(message.mentionText ?? rawBody, mentionRegexes)
    : false;
  const route = resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? roomToken : senderId,
    },
  });
  const contextBinding: ChannelIngressContextBinding = {
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    messageId: message.messageId,
    inboundEventKind: "user_request",
  };
  // Prepare session history before revalidating authority or staging media, so
  // a failed read cannot leak staged files or yield past the final dispatch fence.
  const buildEnvelope = await createChannelInboundEnvelopeBuilderAsync({ cfg: config, route });
  ingressAbortSignal?.throwIfAborted();
  access = await resolveAccess(isGroup ? wasMentioned : undefined, contextBinding);

  if (access.ingress.admission !== "dispatch") {
    logAuthorizationChanged();
    return;
  }

  if (await ignoreOwnOutboundFileShare()) {
    return;
  }

  let stagedMedia: { path: string; contentType?: string } | undefined;
  let stagedMediaId: string | undefined;
  let sourceModality: "audio" | "voice" | undefined;
  let authorizedMediaUnavailable = false;
  let performedAsyncMediaWork = false;
  // Claim retirement may race a store write that ignores or narrowly loses the abort.
  // Clear local adoption state before best-effort deletion so no later branch can dispatch it.
  const deleteStagedMedia = async () => {
    const mediaId = stagedMediaId;
    stagedMediaId = undefined;
    stagedMedia = undefined;
    if (!mediaId) {
      return;
    }
    try {
      await core.channel.media.deleteMediaBuffer(mediaId);
    } catch {
      logNextcloudTalkMediaNonOutcome({
        log: (messageLocal) => runtime.log?.(messageLocal),
        reason: "media_cleanup_failed",
        accountId: account.accountId,
        messageId: message.messageId,
        senderId,
      });
    }
  };
  const throwIfIngressAborted = () => ingressAbortSignal?.throwIfAborted();
  const mediaSenderAllowed =
    hasInboundMedia &&
    isNextcloudTalkMediaSenderAllowed({
      mediaAllowFrom: account.config.mediaAllowFrom,
      senderId,
    });
  let mediaHandedOff = false;
  try {
    if (hasInboundMedia && !mediaSenderAllowed) {
      logNextcloudTalkMediaNonOutcome({
        log: (messageLocal) => runtime.log?.(messageLocal),
        reason: "media_sender_not_allowlisted",
        accountId: account.accountId,
        messageId: message.messageId,
        senderId,
      });
      if (!rawBody) {
        return;
      }
    } else if (message.attachmentIssue) {
      authorizedMediaUnavailable = true;
      logNextcloudTalkMediaNonOutcome({
        log: (messageLocal) => runtime.log?.(messageLocal),
        reason: message.attachmentIssue,
        accountId: account.accountId,
        messageId: message.messageId,
        senderId,
      });
    } else if (message.attachment?.hideDownload) {
      authorizedMediaUnavailable = true;
      logNextcloudTalkMediaNonOutcome({
        log: (messageLocal) => runtime.log?.(messageLocal),
        reason: "media_hidden_download",
        accountId: account.accountId,
        messageId: message.messageId,
        senderId,
      });
    } else if (message.attachment) {
      const mediaMaxBytes = resolveNextcloudTalkMediaMaxBytes({
        // SAFETY: runtime ingress receives full OpenClawConfig; local CoreConfig is narrower.
        cfg: config as OpenClawConfig,
        accountId: account.accountId,
        mediaMaxMb: account.config.mediaMaxMb,
      });
      if (message.attachment.declaredSizeBytes > mediaMaxBytes) {
        authorizedMediaUnavailable = true;
        logNextcloudTalkMediaNonOutcome({
          log: (messageLocal) => runtime.log?.(messageLocal),
          reason: "media_declared_oversize",
          accountId: account.accountId,
          messageId: message.messageId,
          senderId,
          sizeBytes: message.attachment.declaredSizeBytes,
          maxBytes: mediaMaxBytes,
        });
      } else {
        const attachmentReference = resolveNextcloudTalkAttachmentReference({
          baseUrl: account.baseUrl,
          shareUrl: message.attachment.shareUrl,
          fileName: message.attachment.name,
        });
        if (!attachmentReference.ok) {
          authorizedMediaUnavailable = true;
          logNextcloudTalkMediaNonOutcome({
            log: (messageLocal) => runtime.log?.(messageLocal),
            reason: attachmentReference.reason,
            accountId: account.accountId,
            messageId: message.messageId,
            senderId,
          });
        } else {
          performedAsyncMediaWork = true;
          throwIfIngressAborted();
          const authenticatedSource = await resolveNextcloudTalkAuthenticatedMediaSource({
            baseUrl: account.baseUrl,
            roomToken,
            messageId: message.messageId,
            senderId,
            attachment: message.attachment,
            accountConfig: account.config,
            reference: attachmentReference,
            signal: ingressAbortSignal,
          });
          throwIfIngressAborted();
          if (!authenticatedSource.ok) {
            authorizedMediaUnavailable = true;
            logNextcloudTalkMediaNonOutcome({
              log: (messageLocal) => runtime.log?.(messageLocal),
              reason: authenticatedSource.reason,
              accountId: account.accountId,
              messageId: message.messageId,
              senderId,
              status: authenticatedSource.status,
            });
          } else {
            sourceModality = authenticatedSource.sourceModality;
            access = await resolveAccess(isGroup ? wasMentioned : undefined, contextBinding);
            throwIfIngressAborted();
            if (access.ingress.admission !== "dispatch") {
              logAuthorizationChanged();
              return;
            }
            try {
              throwIfIngressAborted();
              const saved = await saveNextcloudTalkInboundMedia({
                saveRemoteMedia: core.channel.media.saveRemoteMedia,
                url: authenticatedSource.url,
                origin: authenticatedSource.origin,
                hostname: authenticatedSource.hostname,
                accountConfig: account.config,
                maxBytes: mediaMaxBytes,
                fileName: authenticatedSource.fileName,
                mimeType: authenticatedSource.contentTypeOverride ?? message.attachment.mimeType,
                authorization: authenticatedSource.authorization,
                signal: ingressAbortSignal,
              });
              stagedMediaId = saved.id;
              const canonicalized =
                sourceModality === "voice"
                  ? await canonicalizeNextcloudTalkNativeVoiceMedia(saved)
                  : { ok: true as const, media: saved };
              if (!canonicalized.ok) {
                await deleteStagedMedia();
                authorizedMediaUnavailable = true;
                logNextcloudTalkMediaNonOutcome({
                  log: (messageLocal) => runtime.log?.(messageLocal),
                  reason: "media_unsupported",
                  accountId: account.accountId,
                  messageId: message.messageId,
                  senderId,
                });
              } else {
                stagedMediaId = canonicalized.media.id;
                stagedMedia = {
                  path: canonicalized.media.path,
                  contentType: canonicalized.media.contentType,
                };
                if (!sourceModality && stagedMedia.contentType?.startsWith("audio/")) {
                  sourceModality = "audio";
                }
              }
              throwIfIngressAborted();
            } catch (error) {
              await deleteStagedMedia();
              throwIfIngressAborted();
              authorizedMediaUnavailable = true;
              const failure = classifyNextcloudTalkMediaFailure(error);
              logNextcloudTalkMediaNonOutcome({
                log: (messageLocal) => runtime.log?.(messageLocal),
                reason: failure.reason,
                accountId: account.accountId,
                messageId: message.messageId,
                senderId,
                status: failure.status,
                ...(failure.reason === "media_download_oversize"
                  ? { maxBytes: mediaMaxBytes }
                  : {}),
              });
            }
          }
        }
      }
    }

    const quote = message.quote;
    let quoteAllowFrom = hasAllowEntries(outerGroupAllowFrom) ? outerGroupAllowFrom : roomAllowFrom;
    let quoteRoomAllowFrom = roomAllowFrom;
    const hasQuotePolicyWork = quote !== undefined && isGroup && groupPolicy === "allowlist";
    if (hasQuotePolicyWork) {
      const expandQuoteAllowFrom = (entries: string[]) =>
        expandAllowFromWithAccessGroups({
          cfg: config,
          allowFrom: entries,
          channel: CHANNEL_ID,
          accountId: account.accountId,
          senderId: quote.senderId,
          isSenderAllowed: (id, allow) =>
            resolveNextcloudTalkAllowlistMatch({ senderId: id, allowFrom: allow }).allowed,
        });
      quoteAllowFrom = await expandQuoteAllowFrom(quoteAllowFrom);
      quoteRoomAllowFrom = await expandQuoteAllowFrom(roomAllowFrom);
    }

    if (performedAsyncMediaWork || hasQuotePolicyWork) {
      throwIfIngressAborted();
      access = await resolveAccess(isGroup ? wasMentioned : undefined, contextBinding);
      throwIfIngressAborted();
      if (access.ingress.admission !== "dispatch") {
        await deleteStagedMedia();
        logAuthorizationChanged();
        return;
      }
    }

    throwIfIngressAborted();
    const agentBody = authorizedMediaUnavailable
      ? formatInboundMediaUnavailableText({
          body: rawBody,
          notice: "[Nextcloud Talk attachment unavailable]",
        })
      : rawBody;
    const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
    const body = buildEnvelope({
      channel: "Nextcloud Talk",
      from: fromLabel,
      timestamp: message.timestamp,
      body: agentBody,
    });

    const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);
    const visibleQuote = quote
      ? filterChannelInboundQuoteContext(
          resolveChannelContextVisibilityMode({
            cfg: config,
            channel: CHANNEL_ID,
            accountId: account.accountId,
          }),
          {
            id: quote.id,
            body: quote.body,
            sender: quote.senderName || quote.senderId,
            senderAllowed: resolveInboundSupplementalSenderAllowed({
              isGroup,
              groupPolicy,
              allowFrom: quoteAllowFrom,
              isSenderAllowed: (candidateAllowFrom) =>
                resolveNextcloudTalkAllowlistMatch({
                  allowFrom: [...candidateAllowFrom],
                  senderId: quote.senderId,
                }).allowed &&
                (!hasAllowEntries(quoteRoomAllowFrom) ||
                  resolveNextcloudTalkAllowlistMatch({
                    allowFrom: quoteRoomAllowFrom,
                    senderId: quote.senderId,
                  }).allowed),
            }),
          },
        )
      : undefined;

    const ctxPayload = core.channel.inbound.buildContext({
      channelIngress: access,
      channel: CHANNEL_ID,
      accountId: route.accountId,
      messageId: message.messageId,
      timestamp: message.timestamp,
      from: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
      sender: { id: senderId, name: senderName || undefined },
      conversation: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? roomToken : senderId,
        label: fromLabel,
      },
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: { to: `nextcloud-talk:${roomToken}`, originatingTo: `nextcloud-talk:${roomToken}` },
      message: {
        body,
        bodyForAgent: agentBody,
        rawBody,
        commandBody,
        ...(sourceModality ? { sourceModality } : {}),
      },
      access: {
        commands: { authorized: access.commandAccess.authorized },
        mentions: { canDetectMention: isGroup, wasMentioned: isGroup && wasMentioned },
      },
      ...(stagedMedia ? { media: [stagedMedia] } : {}),
      extra: {
        GroupSubject: isGroup ? roomName || roomToken : undefined,
        GroupSystemPrompt: isGroup ? normalizeOptionalString(roomConfig?.systemPrompt) : undefined,
        // ReplyChain carries quoted identity without changing the outgoing ReplyToId fallback.
        ReplyChain:
          quote && visibleQuote
            ? [
                {
                  messageId: visibleQuote.id,
                  senderId: quote.senderId,
                  sender: visibleQuote.sender,
                  body: visibleQuote.body,
                  isQuote: true,
                },
              ]
            : undefined,
      },
    });

    throwIfIngressAborted();
    const dispatchParams = {
      cfg: config as OpenClawConfig,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      route: { agentId: route.agentId, sessionKey: route.sessionKey },
      ctxPayload,
      delivery: {
        preparePayload: (payload) =>
          payload.text === undefined
            ? payload
            : {
                ...payload,
                text: sanitizeAssistantVisibleText(payload.text),
              },
        deliverWithProviderMessageSending: async (payload, info) => {
          const { deliverNextcloudTalkReply } = await import("./reply.js");
          return await deliverNextcloudTalkReply({
            cfg: config,
            accountId: account.accountId,
            agentId: route.agentId,
            ctxPayload,
            payload,
            info,
            to: roomToken,
            signal: ingressAbortSignal,
          });
        },
        onDelivered: (_payload, _info, result) => {
          if (result?.visibleReplySent) {
            statusSink?.({ lastOutboundAt: Date.now() });
          }
        },
        onError: (err, info) => {
          runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyPipeline: {},
      replyOptions: {
        ...(params.turnAdoptionLifecycle
          ? bindIngressLifecycleToReplyOptions(params.turnAdoptionLifecycle)
          : {}),
        skillFilter: roomConfig?.skills,
        disableBlockStreaming:
          typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
      },
      record: {
        onRecordError: (err) => {
          runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
        },
      },
    } satisfies ChannelInboundTurnPlan<"provider_message_sending">;
    // Dispatch owns accepted media even if its downstream processing rejects.
    mediaHandedOff = true;
    await core.channel.inbound.dispatch(dispatchParams);
  } finally {
    if (!mediaHandedOff) {
      await deleteStagedMedia();
    }
  }
}
