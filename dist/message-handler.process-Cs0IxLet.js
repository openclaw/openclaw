import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { p as resolveThreadSessionKeys } from "./session-key-Bte0mmcq.js";
import { a as shouldLogVerbose, r as logVerbose, t as danger } from "./globals-YU5FjfZK.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { F as resolveSessionStoreEntry } from "./store-load-z4thf6ld.js";
import { a as readSessionUpdatedAt } from "./store-BmtchQvp.js";
import { d as resolveAndPersistSessionFile, r as readLatestAssistantTextFromSessionTranscript } from "./transcript-BA0Ngd-A.js";
import { u as stripReasoningTagsFromText } from "./assistant-visible-text-BoF6Ixue.js";
import { r as stripInlineDirectiveTagsForDelivery } from "./directive-tags-CClLEtM7.js";
import { a as getReplyPayloadTtsSupplement, n as buildTtsSupplementMediaPayload } from "./reply-payload-CiT5mlcY.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-DMPQsrQC.js";
import { t as resolveAccountEntry } from "./account-lookup-CQEoGO1F.js";
import { s as formatReasoningMessage } from "./pi-embedded-utils-D6gJe2Np.js";
import { A as resolveChannelStreamingSuppressDefaultToolProgressMessages, S as resolveChannelStreamingBlockEnabled, T as resolveChannelStreamingPreviewChunk, a as createChannelProgressDraftGate, c as formatChannelProgressDraftText, f as mergeChannelProgressDraftLine, i as buildChannelProgressDraftLineForEntry, j as resolveTranscriptBackedChannelFinalText, k as resolveChannelStreamingPreviewToolProgress, p as normalizeChannelProgressDraftLineIdentity, r as buildChannelProgressDraftLine, u as isChannelProgressDraftWorkToolName, y as resolveChannelProgressDraftMaxLines } from "./channel-streaming-BKIuGSWW.js";
import { t as EmbeddedBlockChunker } from "./pi-embedded-block-chunker-BQzqF871.js";
import { t as buildAgentSessionKey } from "./resolve-route-C8IahAyG.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./dm-policy-shared-CXEKnzKD.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-Pi6a9oaK.js";
import { i as resolveHumanDelayConfig, t as resolveAckReaction } from "./identity-nYw-h8DL.js";
import { c as resolveTextChunkLimit, s as resolveChunkMode } from "./chunk-IIklKK4Y.js";
import { a as deliverWithFinalizableLivePreviewAdapter, r as defineFinalizableLivePreviewAdapter } from "./live-CF0ee90S.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import "./routing-79DRZvfm.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope } from "./envelope-DUI2KFD9.js";
import { i as shouldAckReaction } from "./ack-reactions-BceP3SaE.js";
import { t as recordInboundSession } from "./session-CCAfHrW1.js";
import { g as toInboundMediaFacts, h as toHistoryMediaEntries, p as recordChannelBotPairLoopAndCheckSuppression, s as buildChannelInboundEventContext } from "./kernel-BXIm_f4L.js";
import { n as resolveChannelSourceReplyDeliveryMode, t as createChannelReplyPipeline } from "./reply-pipeline-EtNTatED.js";
import { n as hasFinalChannelTurnDispatch } from "./dispatch-result-BM3RYtx4.js";
import { t as evaluateSupplementalContextVisibility } from "./context-visibility-C9pX_aod.js";
import { t as createChannelHistoryWindow } from "./history-window-Gy0CzEef.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DCRkoyVz.js";
import { t as convertMarkdownTables } from "./tables-D3y68tNR.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-jjAiM0PK.js";
import "./reply-history-Dd_Mx-HZ.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-Si-TIKp_.js";
import "./reply-chunking-D-imiKW4.js";
import { f as runPreparedInboundReplyTurn } from "./inbound-reply-dispatch-Bi01ox5N.js";
import "./media-runtime-BheBFFxc.js";
import "./conversation-runtime-guwDSNIo.js";
import "./text-chunking-C154U6-i.js";
import "./agent-runtime-Lc7H-PlR.js";
import "./security-runtime-CcSekjBd.js";
import "./markdown-table-runtime-BRMInqmJ.js";
import { r as logTypingFailure, t as logAckFailure } from "./logging-Dr3f0mtP.js";
import { a as DEFAULT_TIMING, c as createStatusReactionController } from "./channel-feedback-Bn34MjYD.js";
import "./channel-inbound-C7GtKjtG.js";
import { r as createFinalizableDraftLifecycle } from "./channel-lifecycle-B7VOl7bW.js";
import "./channel-message-DMGbyII_.js";
import { t as loadSessionStore } from "./session-store-runtime-DCQkOAps.js";
import "./text-utility-runtime-CaGXarh9.js";
import { f as resolveDiscordMaxLinesPerMessage } from "./accounts-DIRzXd2H.js";
import { n as resolveDiscordChannelId } from "./target-parsing-D1FhMbX6.js";
import { $ as createChannelMessage, Ht as MessageFlags, It as ChannelType, it as editChannelMessage, nt as deleteChannelMessage } from "./discord-Cn5UmvYW.js";
import { N as createDiscordRestClient, P as createDiscordRuntimeAccountContext, _ as resolveDiscordMessageFlags, d as resolveDiscordTargetChannelId } from "./send.shared-DBAwZLzi.js";
import { t as chunkDiscordTextWithMode } from "./chunk-CixrDxH0.js";
import { i as resolveTimestampMs } from "./format-DZW075F7.js";
import { a as normalizeDiscordSlug, r as normalizeDiscordAllowList } from "./allow-list-COYqm2Y0.js";
import { d as editMessageDiscord, i as removeReactionDiscord, n as reactMessageDiscord } from "./send-BASUWZZP.js";
import "./targets-B8AIYxNL.js";
import { t as beginDiscordInboundEventDeliveryCorrelation } from "./inbound-event-delivery-DTGIjZVJ.js";
import { t as resolveDiscordConversationIdentity } from "./conversation-identity-DGBQNoPw.js";
import { t as DISCORD_TEXT_CHUNK_LIMIT } from "./outbound-adapter-Bw8wq78A.js";
import { t as resolveDiscordPreviewStreamMode } from "./preview-streaming-ByVmTycN.js";
import { n as DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS, t as DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS } from "./timeouts-l_PsHQvX.js";
import { a as resolveForwardedMediaList, o as resolveMediaList, r as resolveDiscordMessageText, s as resolveReferencedReplyMediaList } from "./message-utils-B5eEkQa9.js";
import { c as resolveDiscordThreadStarter, r as resolveDiscordAutoThreadReplyPlan } from "./threading-BGoc642R.js";
import { t as sendTyping } from "./typing-V8IvU9PZ.js";
import { n as buildDiscordInboundAccessContext, r as createDiscordSupplementalContextAccessChecker } from "./inbound-context-DXIN2Bms.js";
import { i as resolveReplyContext, n as buildDirectLabel, r as buildGuildLabel, t as deliverDiscordReply } from "./reply-delivery-mSl5EGCh.js";
import path from "node:path";
//#region extensions/discord/src/monitor/ack-reactions.ts
function createDiscordAckReactionContext(params) {
	return {
		rest: params.rest,
		...createDiscordRuntimeAccountContext({
			cfg: params.cfg,
			accountId: params.accountId
		})
	};
}
function createDiscordAckReactionAdapter(params) {
	return {
		setReaction: async (emoji) => {
			await reactMessageDiscord(params.channelId, params.messageId, emoji, params.reactionContext);
		},
		removeReaction: async (emoji) => {
			await removeReactionDiscord(params.channelId, params.messageId, emoji, params.reactionContext);
		}
	};
}
function queueInitialDiscordAckReaction(params) {
	if (params.enabled) {
		params.statusReactions.setQueued();
		return;
	}
	if (!params.shouldSendAckReaction || !params.ackReaction) return;
	params.reactionAdapter.setReaction(params.ackReaction).catch((err) => {
		logAckFailure({
			log: logVerbose,
			channel: "discord",
			target: params.target,
			error: err
		});
	});
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.context.ts
function normalizeDiscordDmOwnerEntry(entry) {
	const candidate = normalizeDiscordAllowList([entry], [
		"discord:",
		"user:",
		"pk:"
	])?.ids.values().next().value;
	return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : void 0;
}
function isContextAborted(abortSignal) {
	return Boolean(abortSignal?.aborted);
}
async function buildDiscordMessageProcessContext(params) {
	const { ctx, text, mediaList } = params;
	const { cfg, discordConfig, accountId, runtime, mediaMaxBytes, discordRestFetch, abortSignal, guildHistories, historyLimit, replyToMode, message, author, sender, canonicalMessageId, data, client, channelInfo, channelName, messageChannelId, isGuildMessage, isDirectMessage, baseText, preflightAudioTranscript, threadChannel, threadParentId, threadParentName, threadParentType, threadName, displayChannelSlug, guildInfo, guildSlug, memberRoleIds, channelConfig, baseSessionKey, boundSessionKey, route, commandAuthorized } = ctx;
	const fromLabel = isDirectMessage ? buildDirectLabel(author) : buildGuildLabel({
		guild: data.guild ?? void 0,
		channelName: channelName ?? messageChannelId,
		channelId: messageChannelId
	});
	const senderLabel = sender.label;
	const isForumParent = threadParentType === ChannelType.GuildForum || threadParentType === ChannelType.GuildMedia;
	const forumParentSlug = isForumParent && threadParentName ? normalizeDiscordSlug(threadParentName) : "";
	const threadChannelId = threadChannel?.id;
	const threadParentInheritanceEnabled = discordConfig?.thread?.inheritParent ?? false;
	const forumContextLine = Boolean(threadChannelId && isForumParent && forumParentSlug) && message.id === threadChannelId ? `[Forum parent: #${forumParentSlug}]` : null;
	const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : void 0;
	const groupSubject = isDirectMessage ? void 0 : groupChannel;
	const senderName = sender.isPluralKit ? sender.name ?? author.username : data.member?.nickname ?? author.globalName ?? author.username;
	const senderUsername = sender.isPluralKit ? sender.tag ?? sender.name ?? author.username : author.username;
	const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
		channelConfig,
		guildInfo,
		sender: {
			id: sender.id,
			name: sender.name,
			tag: sender.tag
		},
		allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
		isGuild: isGuildMessage,
		channelTopic: channelInfo?.topic
	});
	const pinnedMainDmOwner = isDirectMessage ? resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: cfg.session?.dmScope,
		allowFrom: channelConfig?.users ?? guildInfo?.users,
		normalizeEntry: normalizeDiscordDmOwnerEntry
	}) : null;
	const contextVisibilityMode = resolveChannelContextVisibilityMode({
		cfg,
		channel: "discord",
		accountId
	});
	const isSupplementalContextSenderAllowed = createDiscordSupplementalContextAccessChecker({
		channelConfig,
		guildInfo,
		allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
		isGuild: isGuildMessage
	});
	const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
	const previousTimestamp = readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	const channelHistory = createChannelHistoryWindow({ historyMap: guildHistories });
	const isRoomEvent = ctx.inboundEventKind === "room_event";
	let combinedBody = formatInboundEnvelope({
		channel: "Discord",
		from: fromLabel,
		timestamp: resolveTimestampMs(message.timestamp),
		body: text,
		chatType: isDirectMessage ? "direct" : "channel",
		senderLabel,
		previousTimestamp,
		envelope: envelopeOptions
	});
	const shouldIncludeChannelHistory = !isDirectMessage && (isRoomEvent || !(isGuildMessage && channelConfig?.autoThread && !threadChannel));
	if (shouldIncludeChannelHistory) combinedBody = channelHistory.buildPendingContext({
		historyKey: messageChannelId,
		limit: historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "Discord",
			from: fromLabel,
			timestamp: entry.timestamp,
			body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${messageChannelId}]`,
			chatType: "channel",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
	const replyVisibility = replyContext ? evaluateSupplementalContextVisibility({
		mode: contextVisibilityMode,
		kind: "quote",
		senderAllowed: isSupplementalContextSenderAllowed({
			id: replyContext.senderId,
			name: replyContext.senderName,
			tag: replyContext.senderTag,
			memberRoleIds: replyContext.memberRoleIds
		})
	}) : null;
	const filteredReplyContext = replyContext && replyVisibility?.include ? replyContext : null;
	if (replyContext && !filteredReplyContext && isGuildMessage) logVerbose(`discord: drop reply context (mode=${contextVisibilityMode})`);
	const mediaListForContext = [...mediaList];
	if (filteredReplyContext) {
		const referencedReplyMediaList = await resolveReferencedReplyMediaList(message, mediaMaxBytes, {
			fetchImpl: discordRestFetch,
			ssrfPolicy: cfg.browser?.ssrfPolicy,
			readIdleTimeoutMs: DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
			totalTimeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
			abortSignal
		});
		if (!isContextAborted(abortSignal)) mediaListForContext.push(...referencedReplyMediaList);
	}
	if (forumContextLine) combinedBody = `${combinedBody}\n${forumContextLine}`;
	let threadStarterBody;
	let threadLabel;
	let parentSessionKey;
	let modelParentSessionKey;
	if (threadChannel) {
		if (channelConfig?.includeThreadStarter !== false) {
			const starter = await resolveDiscordThreadStarter({
				channel: threadChannel,
				client,
				parentId: threadParentId,
				parentType: threadParentType,
				resolveTimestampMs
			});
			if (starter?.text) if (evaluateSupplementalContextVisibility({
				mode: contextVisibilityMode,
				kind: "thread",
				senderAllowed: isSupplementalContextSenderAllowed({
					id: starter.authorId,
					name: starter.authorName ?? starter.author,
					tag: starter.authorTag,
					memberRoleIds: starter.memberRoleIds
				})
			}).include) threadStarterBody = starter.text;
			else logVerbose(`discord: drop thread starter context (mode=${contextVisibilityMode})`);
		}
		const parentName = threadParentName ?? "parent";
		threadLabel = threadName ? `Discord thread #${normalizeDiscordSlug(parentName)} › ${threadName}` : `Discord thread #${normalizeDiscordSlug(parentName)}`;
		if (threadParentId) {
			parentSessionKey = buildAgentSessionKey({
				agentId: route.agentId,
				channel: route.channel,
				peer: {
					kind: "channel",
					id: threadParentId
				}
			});
			modelParentSessionKey = parentSessionKey;
		}
		if (!threadParentInheritanceEnabled) parentSessionKey = void 0;
	}
	const preflightAudioIndex = preflightAudioTranscript === void 0 ? -1 : mediaListForContext.findIndex((media) => media.contentType?.startsWith("audio/"));
	const threadKeys = resolveThreadSessionKeys({
		baseSessionKey,
		threadId: threadChannel ? messageChannelId : void 0,
		parentSessionKey,
		useSuffix: false
	});
	const replyPlan = await resolveDiscordAutoThreadReplyPlan({
		client,
		message,
		messageChannelId,
		isGuildMessage,
		channelConfig: isRoomEvent ? null : channelConfig,
		threadChannel,
		channelType: channelInfo?.type,
		channelName: channelInfo?.name,
		channelDescription: channelInfo?.topic,
		baseText: baseText ?? "",
		combinedBody,
		replyToMode,
		agentId: route.agentId,
		channel: route.channel,
		cfg,
		threadParentInheritanceEnabled
	});
	const deliverTarget = replyPlan.deliverTarget;
	const replyTarget = replyPlan.replyTarget;
	const replyReference = replyPlan.replyReference;
	const autoThreadContext = replyPlan.autoThreadContext;
	const effectiveFrom = isDirectMessage ? `discord:${author.id}` : autoThreadContext?.From ?? `discord:channel:${messageChannelId}`;
	const dmConversationTarget = isDirectMessage ? resolveDiscordConversationIdentity({
		isDirectMessage,
		userId: author.id
	}) : void 0;
	const effectiveTo = autoThreadContext?.To ?? dmConversationTarget ?? replyTarget;
	if (!effectiveTo) {
		runtime.error?.(danger("discord: missing reply target"));
		return null;
	}
	const lastRouteTo = dmConversationTarget ?? effectiveTo;
	const inboundHistory = shouldIncludeChannelHistory ? channelHistory.buildInboundHistory({
		historyKey: messageChannelId,
		limit: historyLimit
	}) : void 0;
	const originatingTo = autoThreadContext?.OriginatingTo ?? dmConversationTarget ?? replyTarget;
	const effectiveSessionKey = boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey;
	const effectivePreviousTimestamp = effectiveSessionKey === route.sessionKey ? previousTimestamp : readSessionUpdatedAt({
		storePath,
		sessionKey: effectiveSessionKey
	});
	const ctxPayload = buildChannelInboundEventContext({
		channel: "discord",
		provider: "discord",
		surface: "discord",
		accountId: route.accountId,
		messageId: canonicalMessageId ?? message.id,
		messageIdFull: canonicalMessageId && canonicalMessageId !== message.id ? message.id : void 0,
		timestamp: resolveTimestampMs(message.timestamp),
		from: effectiveFrom,
		sender: {
			id: sender.id,
			name: senderName,
			username: senderUsername,
			tag: sender.tag,
			roles: memberRoleIds,
			displayLabel: senderLabel
		},
		conversation: {
			kind: isDirectMessage ? "direct" : "channel",
			id: messageChannelId,
			label: fromLabel,
			spaceId: isGuildMessage ? (guildInfo?.id ?? guildSlug) || void 0 : void 0,
			threadId: threadChannel?.id ?? autoThreadContext?.createdThreadId ?? void 0,
			routePeer: {
				kind: isDirectMessage ? "direct" : "channel",
				id: isDirectMessage ? author.id : messageChannelId
			}
		},
		route: {
			agentId: route.agentId,
			accountId: route.accountId,
			routeSessionKey: route.sessionKey,
			dispatchSessionKey: effectiveSessionKey,
			parentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
			modelParentSessionKey: autoThreadContext?.ModelParentSessionKey ?? modelParentSessionKey ?? void 0
		},
		reply: {
			to: effectiveTo,
			originatingTo
		},
		message: {
			inboundEventKind: ctx.inboundEventKind,
			body: combinedBody,
			rawBody: preflightAudioTranscript ?? baseText,
			bodyForAgent: preflightAudioTranscript ?? baseText ?? text,
			commandBody: preflightAudioTranscript ?? baseText,
			envelopeFrom: fromLabel,
			inboundHistory
		},
		access: {
			mentions: {
				canDetectMention: ctx.canDetectMention,
				wasMentioned: ctx.effectiveWasMentioned,
				hasAnyMention: ctx.hasAnyMention,
				requireMention: ctx.shouldRequireMention,
				effectiveWasMentioned: ctx.effectiveWasMentioned
			},
			commands: {
				authorized: commandAuthorized,
				allowTextCommands: ctx.allowTextCommands,
				useAccessGroups: false,
				authorizers: []
			}
		},
		commandTurn: {
			kind: "text-slash",
			source: "text",
			authorized: commandAuthorized,
			body: preflightAudioTranscript ?? baseText
		},
		media: toInboundMediaFacts(mediaListForContext, { transcribed: (_media, index) => index === preflightAudioIndex }),
		supplemental: {
			quote: filteredReplyContext ? {
				id: filteredReplyContext.id,
				body: filteredReplyContext.body,
				sender: filteredReplyContext.sender
			} : void 0,
			thread: {
				starterBody: !effectivePreviousTimestamp ? threadStarterBody : void 0,
				label: threadLabel
			},
			groupSystemPrompt: isGuildMessage ? groupSystemPrompt : void 0
		},
		extra: {
			...preflightAudioTranscript !== void 0 ? { Transcript: preflightAudioTranscript } : {},
			GroupSubject: groupSubject,
			GroupChannel: groupChannel,
			UntrustedStructuredContext: untrustedContext,
			OwnerAllowFrom: ownerAllowFrom
		}
	});
	const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;
	if (isRoomEvent && shouldIncludeChannelHistory) await channelHistory.recordWithMedia({
		historyKey: messageChannelId,
		limit: historyLimit,
		entry: {
			sender: senderName,
			body: text,
			timestamp: resolveTimestampMs(message.timestamp),
			messageId: message.id
		},
		media: toHistoryMediaEntries(mediaList, { messageId: message.id }),
		messageId: message.id
	});
	if (shouldLogVerbose()) {
		const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
		logVerbose(`discord inbound: channel=${messageChannelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`);
	}
	return {
		ctxPayload,
		persistedSessionKey,
		turn: {
			storePath,
			record: {
				updateLastRoute: {
					sessionKey: persistedSessionKey,
					channel: "discord",
					to: lastRouteTo,
					accountId: route.accountId,
					mainDmOwnerPin: isDirectMessage && persistedSessionKey === route.mainSessionKey && pinnedMainDmOwner ? {
						ownerRecipient: pinnedMainDmOwner,
						senderRecipient: author.id,
						onSkip: ({ ownerRecipient, senderRecipient }) => {
							logVerbose(`discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
						}
					} : void 0
				},
				onRecordError: (err) => {
					logVerbose(`discord: failed updating session meta: ${String(err)}`);
				}
			}
		},
		replyPlan,
		deliverTarget,
		replyTarget,
		replyReference
	};
}
//#endregion
//#region extensions/discord/src/draft-chunking.ts
const DEFAULT_DISCORD_DRAFT_STREAM_MIN = 200;
const DEFAULT_DISCORD_DRAFT_STREAM_MAX = 800;
function resolveDiscordDraftStreamingChunking(cfg, accountId) {
	const textLimit = resolveTextChunkLimit(cfg, "discord", accountId, { fallbackLimit: DISCORD_TEXT_CHUNK_LIMIT });
	const normalizedAccountId = normalizeAccountId(accountId);
	const draftCfg = resolveChannelStreamingPreviewChunk(resolveAccountEntry(cfg?.channels?.discord?.accounts, normalizedAccountId)) ?? resolveChannelStreamingPreviewChunk(cfg?.channels?.discord);
	const maxRequested = Math.max(1, Math.floor(draftCfg?.maxChars ?? DEFAULT_DISCORD_DRAFT_STREAM_MAX));
	const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
	const minRequested = Math.max(1, Math.floor(draftCfg?.minChars ?? DEFAULT_DISCORD_DRAFT_STREAM_MIN));
	return {
		minChars: Math.min(minRequested, maxChars),
		maxChars,
		breakPreference: draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence" ? draftCfg.breakPreference : "paragraph"
	};
}
//#endregion
//#region extensions/discord/src/draft-stream.ts
/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2e3;
const DEFAULT_THROTTLE_MS = 1200;
const DISCORD_PREVIEW_ALLOWED_MENTIONS = { parse: [] };
function createDiscordDraftStream(params) {
	const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
	const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const minInitialChars = params.minInitialChars;
	const channelId = params.channelId;
	const rest = params.rest;
	const flags = resolveDiscordMessageFlags({ suppressEmbeds: params.suppressEmbeds });
	const resolveReplyToMessageId = () => typeof params.replyToMessageId === "function" ? params.replyToMessageId() : params.replyToMessageId;
	const streamState = {
		stopped: false,
		final: false
	};
	let streamMessageId;
	let lastSentText = "";
	const sendOrEditStreamMessage = async (text) => {
		if (streamState.stopped && !streamState.final) return false;
		const trimmed = text.trimEnd();
		if (!trimmed) return false;
		if (trimmed.length > maxChars) {
			streamState.stopped = true;
			params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
			return false;
		}
		if (trimmed === lastSentText) return true;
		if (streamMessageId === void 0 && minInitialChars != null && !streamState.final) {
			if (trimmed.length < minInitialChars) return false;
		}
		lastSentText = trimmed;
		try {
			if (streamMessageId !== void 0) {
				await editChannelMessage(rest, channelId, streamMessageId, { body: {
					content: trimmed,
					allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
					...flags ? { flags } : {}
				} });
				return true;
			}
			const replyToMessageId = resolveReplyToMessageId()?.trim();
			const messageReference = replyToMessageId ? {
				message_id: replyToMessageId,
				fail_if_not_exists: false
			} : void 0;
			const sentMessageId = (await createChannelMessage(rest, channelId, { body: {
				content: trimmed,
				allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
				...flags ? { flags } : {},
				...messageReference ? { message_reference: messageReference } : {}
			} }))?.id;
			if (typeof sentMessageId !== "string" || !sentMessageId) {
				streamState.stopped = true;
				params.warn?.("discord stream preview stopped (missing message id from send)");
				return false;
			}
			streamMessageId = sentMessageId;
			return true;
		} catch (err) {
			streamState.stopped = true;
			params.warn?.(`discord stream preview failed: ${formatErrorMessage(err)}`);
			return false;
		}
	};
	const readMessageId = () => streamMessageId;
	const clearMessageId = () => {
		streamMessageId = void 0;
	};
	const isValidStreamMessageId = (value) => typeof value === "string";
	const deleteStreamMessage = async (messageId) => {
		await deleteChannelMessage(rest, channelId, messageId);
	};
	const { loop, update, stop, clear, discardPending, seal } = createFinalizableDraftLifecycle({
		throttleMs,
		state: streamState,
		sendOrEditStreamMessage,
		readMessageId,
		clearMessageId,
		isValidMessageId: isValidStreamMessageId,
		deleteMessage: deleteStreamMessage,
		warn: params.warn,
		warnPrefix: "discord stream preview cleanup failed"
	});
	const forceNewMessage = () => {
		streamMessageId = void 0;
		lastSentText = "";
		loop.resetPending();
	};
	params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
	return {
		update,
		flush: loop.flush,
		messageId: () => streamMessageId,
		clear,
		discardPending,
		seal,
		stop,
		forceNewMessage
	};
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.draft-preview.ts
function createDiscordDraftPreviewController(params) {
	const discordStreamMode = resolveDiscordPreviewStreamMode(params.discordConfig);
	const draftMaxChars = Math.min(params.textLimit, 2e3);
	const accountBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.discordConfig) ?? params.cfg.agents?.defaults?.blockStreamingDefault === "on";
	const canStreamProgressDraftForToolOnlySource = params.sourceRepliesAreToolOnly && discordStreamMode === "progress";
	const draftStream = (!params.sourceRepliesAreToolOnly || canStreamProgressDraftForToolOnlySource) && discordStreamMode !== "off" && !accountBlockStreamingEnabled ? createDiscordDraftStream({
		rest: params.deliveryRest,
		channelId: params.deliverChannelId,
		maxChars: draftMaxChars,
		replyToMessageId: () => params.replyReference.peek(),
		minInitialChars: discordStreamMode === "progress" ? 0 : 30,
		suppressEmbeds: params.discordConfig?.suppressEmbeds ?? true,
		throttleMs: 1200,
		log: params.log,
		warn: params.log
	}) : void 0;
	const draftChunking = draftStream && discordStreamMode === "block" ? resolveDiscordDraftStreamingChunking(params.cfg, params.accountId) : void 0;
	const shouldSplitPreviewMessages = discordStreamMode === "block";
	const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : void 0;
	let lastPartialText = "";
	let draftText = "";
	let hasStreamedMessage = false;
	let finalizedViaPreviewMessage = false;
	let finalReplyStarted = false;
	let finalReplyDelivered = false;
	const previewToolProgressEnabled = Boolean(draftStream) && resolveChannelStreamingPreviewToolProgress(params.discordConfig);
	const suppressDefaultToolProgressMessages = Boolean(draftStream) && resolveChannelStreamingSuppressDefaultToolProgressMessages(params.discordConfig, {
		draftStreamActive: true,
		previewToolProgressEnabled
	});
	let previewToolProgressSuppressed = false;
	let previewToolProgressLines = [];
	let reasoningProgressRawText = "";
	let lastReasoningProgressLine;
	const progressSeed = `${params.accountId}:${params.deliverChannelId}`;
	const renderProgressDraft = async (options) => {
		if (!draftStream || discordStreamMode !== "progress") return;
		const previewText = formatChannelProgressDraftText({
			entry: params.discordConfig,
			lines: previewToolProgressLines,
			seed: progressSeed
		});
		if (!previewText || previewText === lastPartialText) return;
		lastPartialText = previewText;
		draftText = previewText;
		hasStreamedMessage = true;
		draftChunker?.reset();
		draftStream.update(previewText);
		if (options?.flush) await draftStream.flush();
	};
	const progressDraftGate = createChannelProgressDraftGate({ onStart: () => renderProgressDraft({ flush: true }) });
	const resetProgressState = () => {
		lastPartialText = "";
		draftText = "";
		draftChunker?.reset();
		previewToolProgressSuppressed = false;
		previewToolProgressLines = [];
		reasoningProgressRawText = "";
		lastReasoningProgressLine = void 0;
	};
	const forceNewMessageIfNeeded = () => {
		if (shouldSplitPreviewMessages && hasStreamedMessage) {
			params.log("discord: calling forceNewMessage() for draft stream");
			draftStream?.forceNewMessage();
		}
		resetProgressState();
	};
	return {
		draftStream,
		previewToolProgressEnabled,
		suppressDefaultToolProgressMessages,
		get isProgressMode() {
			return discordStreamMode === "progress";
		},
		get hasProgressDraftStarted() {
			return progressDraftGate.hasStarted;
		},
		get finalizedViaPreviewMessage() {
			return finalizedViaPreviewMessage;
		},
		markFinalReplyStarted() {
			finalReplyStarted = true;
		},
		markFinalReplyDelivered() {
			finalReplyDelivered = true;
		},
		markPreviewFinalized() {
			finalizedViaPreviewMessage = true;
		},
		disableBlockStreamingForDraft: draftStream ? true : void 0,
		async startProgressDraft() {
			if (!draftStream || discordStreamMode !== "progress") return;
			await progressDraftGate.startNow();
		},
		async pushToolProgress(line, options) {
			if (!draftStream) return;
			if (finalReplyStarted || finalReplyDelivered) return;
			if (options?.toolName !== void 0 && !isChannelProgressDraftWorkToolName(options.toolName)) return;
			if (isEmptyDiscordProgressLine(line)) return;
			const normalized = normalizeChannelProgressDraftLineIdentity(line);
			if (!normalized) return;
			const progressLine = typeof line === "object" && line !== void 0 ? line : normalized;
			if (discordStreamMode !== "progress") {
				if (!previewToolProgressEnabled || previewToolProgressSuppressed) return;
				const nextLines = mergeChannelProgressDraftLine(previewToolProgressLines, progressLine, { maxLines: resolveChannelProgressDraftMaxLines(params.discordConfig) });
				if (nextLines === previewToolProgressLines) return;
				previewToolProgressLines = nextLines;
				const previewText = formatChannelProgressDraftText({
					entry: params.discordConfig,
					lines: previewToolProgressLines,
					seed: progressSeed
				});
				lastPartialText = previewText;
				draftText = previewText;
				hasStreamedMessage = true;
				draftChunker?.reset();
				draftStream.update(previewText);
				return;
			}
			if (previewToolProgressEnabled && !previewToolProgressSuppressed && normalized) previewToolProgressLines = mergeChannelProgressDraftLine(previewToolProgressLines, progressLine, { maxLines: resolveChannelProgressDraftMaxLines(params.discordConfig) });
			const alreadyStarted = progressDraftGate.hasStarted;
			if (shouldStartDiscordProgressDraftNow(line)) await progressDraftGate.startNow();
			else await progressDraftGate.noteWork();
			if (alreadyStarted && progressDraftGate.hasStarted) await renderProgressDraft();
		},
		async pushReasoningProgress(text) {
			if (!draftStream || discordStreamMode !== "progress" || !text) return;
			if (finalReplyDelivered) return;
			reasoningProgressRawText = mergeReasoningProgressText(reasoningProgressRawText, text);
			const normalized = normalizeReasoningProgressLine(reasoningProgressRawText);
			if (!normalized) return;
			if (previewToolProgressEnabled && !previewToolProgressSuppressed) {
				const priorIndex = lastReasoningProgressLine === void 0 ? -1 : previewToolProgressLines.lastIndexOf(lastReasoningProgressLine);
				if (priorIndex >= 0) {
					previewToolProgressLines = [...previewToolProgressLines];
					previewToolProgressLines[priorIndex] = normalized;
				} else previewToolProgressLines = [...previewToolProgressLines, normalized].slice(-resolveChannelProgressDraftMaxLines(params.discordConfig));
				lastReasoningProgressLine = normalized;
			}
			const alreadyStarted = progressDraftGate.hasStarted;
			await progressDraftGate.noteWork();
			if (alreadyStarted && progressDraftGate.hasStarted) await renderProgressDraft();
		},
		resolvePreviewFinalText(text) {
			if (typeof text !== "string") return;
			const formatted = convertMarkdownTables(stripInlineDirectiveTagsForDelivery(text).text, params.tableMode);
			const chunks = chunkDiscordTextWithMode(formatted, {
				maxChars: draftMaxChars,
				maxLines: params.maxLinesPerMessage,
				chunkMode: params.chunkMode
			});
			if (!chunks.length && formatted) chunks.push(formatted);
			if (chunks.length !== 1) return;
			const trimmed = chunks[0].trim();
			if (!trimmed) return;
			const currentPreviewText = discordStreamMode === "block" ? draftText : lastPartialText;
			if (currentPreviewText && currentPreviewText.startsWith(trimmed) && trimmed.length < currentPreviewText.length) return;
			return trimmed;
		},
		updateFromPartial(text) {
			if (!draftStream || !text) return;
			const cleaned = stripInlineDirectiveTagsForDelivery(stripReasoningTagsFromText(text, {
				mode: "strict",
				trim: "both"
			})).text;
			if (!cleaned || cleaned.startsWith("Reasoning:\n")) return;
			if (cleaned === lastPartialText) return;
			if (discordStreamMode === "progress") return;
			previewToolProgressSuppressed = true;
			previewToolProgressLines = [];
			hasStreamedMessage = true;
			if (discordStreamMode === "partial") {
				if (lastPartialText && lastPartialText.startsWith(cleaned) && cleaned.length < lastPartialText.length) return;
				lastPartialText = cleaned;
				draftStream.update(cleaned);
				return;
			}
			let delta = cleaned;
			if (cleaned.startsWith(lastPartialText)) delta = cleaned.slice(lastPartialText.length);
			else {
				draftChunker?.reset();
				draftText = "";
			}
			lastPartialText = cleaned;
			if (!delta) return;
			if (!draftChunker) {
				draftText = cleaned;
				draftStream.update(draftText);
				return;
			}
			draftChunker.append(delta);
			draftChunker.drain({
				force: false,
				emit: (chunk) => {
					draftText += chunk;
					draftStream.update(draftText);
				}
			});
		},
		handleAssistantMessageBoundary() {
			if (discordStreamMode === "progress") return;
			forceNewMessageIfNeeded();
		},
		async flush() {
			if (!draftStream) return;
			if (draftChunker?.hasBuffered()) {
				draftChunker.drain({
					force: true,
					emit: (chunk) => {
						draftText += chunk;
					}
				});
				draftChunker.reset();
				if (draftText) draftStream.update(draftText);
			}
			await draftStream.flush();
		},
		async cleanup() {
			try {
				progressDraftGate.cancel();
				if (!finalReplyDelivered) await draftStream?.discardPending();
				if (!finalReplyDelivered && !finalizedViaPreviewMessage && draftStream?.messageId()) await draftStream.clear();
			} catch (err) {
				params.log(`discord: draft cleanup failed: ${String(err)}`);
			}
		}
	};
}
function normalizeReasoningProgressLine(text) {
	return text.replace(/^\s*(?:>\s*)?(?:Reasoning:|Thinking\.{0,3})\s*/i, "").replace(/\s+/g, " ").trim();
}
function mergeReasoningProgressText(current, incoming) {
	if (!current) return incoming;
	const normalizedCurrent = normalizeReasoningProgressLine(current);
	const normalizedIncoming = normalizeReasoningProgressLine(incoming);
	if (!normalizedIncoming || normalizedIncoming === normalizedCurrent) return current;
	if (isReasoningSnapshotText(incoming) || normalizedIncoming.startsWith(normalizedCurrent)) return incoming;
	return `${current}${incoming}`;
}
function isReasoningSnapshotText(text) {
	return /^\s*(?:>\s*)?(?:Reasoning:|Thinking\.{0,3})\s*/i.test(text);
}
function isEmptyDiscordProgressLine(line) {
	if (!line || typeof line === "string") return false;
	return line.toolName === "apply_patch" && !line.detail && !line.status;
}
function shouldStartDiscordProgressDraftNow(line) {
	return typeof line === "object" && line?.kind === "patch" && Boolean(line.detail);
}
//#endregion
//#region extensions/discord/src/monitor/message-handler.process.ts
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
const DISCORD_TYPING_MAX_DURATION_MS = 20 * 6e4;
let replyRuntimePromise;
async function loadReplyRuntime() {
	replyRuntimePromise ??= import("./plugin-sdk/reply-runtime.js");
	return await replyRuntimePromise;
}
function isProcessAborted(abortSignal) {
	return Boolean(abortSignal?.aborted);
}
function formatDiscordReplyDeliveryFailure(params) {
	const context = [`target=${params.target}`, params.sessionKey ? `session=${params.sessionKey}` : void 0].filter(Boolean).join(" ");
	return `discord ${params.kind} reply failed (${context}): ${String(params.err)}`;
}
function readToolStringArg(args, key) {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readToolBooleanArg(args, key) {
	return args[key] === true;
}
async function processDiscordMessage(ctx, observer) {
	const dispatchStartedAt = Date.now();
	const { cfg, discordConfig, accountId, token, runtime, guildHistories, historyLimit, mediaMaxBytes, textLimit, replyToMode, ackReactionScope, message, messageChannelId, isGuildMessage, isDirectMessage, isGroupDm, messageText, shouldRequireMention, canDetectMention, effectiveWasMentioned, shouldBypassMention, channelConfig, threadBindings, route, discordRestFetch, abortSignal, botLoopProtection } = ctx;
	if (isProcessAborted(abortSignal)) return;
	if (botLoopProtection) {
		const botLoopResult = recordChannelBotPairLoopAndCheckSuppression(botLoopProtection);
		if (botLoopResult.suppressed) {
			logVerbose(`discord: bot-to-bot loop detected before dispatch setup, suppressing for ${Math.max(0, Math.ceil((botLoopResult.cooldownUntilMs - Date.now()) / 1e3))}s`);
			return;
		}
	}
	const mediaResolveOptions = {
		fetchImpl: discordRestFetch,
		ssrfPolicy: cfg.browser?.ssrfPolicy,
		readIdleTimeoutMs: DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
		totalTimeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
		abortSignal
	};
	const mediaList = await resolveMediaList(message, mediaMaxBytes, mediaResolveOptions);
	if (isProcessAborted(abortSignal)) return;
	const forwardedMediaList = await resolveForwardedMediaList(message, mediaMaxBytes, mediaResolveOptions);
	if (isProcessAborted(abortSignal)) return;
	mediaList.push(...forwardedMediaList);
	const text = messageText;
	if (!text) {
		logVerbose("discord: drop message " + message.id + " (empty content)");
		return;
	}
	const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
	if (boundThreadId && typeof threadBindings.touchThread === "function") threadBindings.touchThread({ threadId: boundThreadId });
	const { createReplyDispatcherWithTyping, dispatchInboundMessage, settleReplyDispatcher } = await loadReplyRuntime();
	const sourceReplyDeliveryMode = resolveChannelSourceReplyDeliveryMode({
		cfg,
		ctx: {
			ChatType: isDirectMessage ? "direct" : isGroupDm ? "group" : isGuildMessage ? "channel" : void 0,
			InboundEventKind: ctx.inboundEventKind
		}
	});
	const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "discord",
		accountId
	});
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
	const isRoomEvent = ctx.inboundEventKind === "room_event";
	const shouldAckReaction$1 = () => Boolean(!isRoomEvent && ackReaction && shouldAckReaction({
		scope: ackReactionScope,
		isDirect: isDirectMessage,
		isGroup: isGuildMessage || isGroupDm,
		isMentionableGroup: isGuildMessage,
		requireMention: shouldRequireMention,
		canDetectMention,
		effectiveWasMentioned,
		shouldBypassMention
	}));
	const shouldSendAckReaction = shouldAckReaction$1();
	const statusReactionsExplicitlyEnabled = cfg.messages?.statusReactions?.enabled === true;
	const statusReactionsEnabled = !isRoomEvent && shouldSendAckReaction && cfg.messages?.statusReactions?.enabled !== false && (!sourceRepliesAreToolOnly || statusReactionsExplicitlyEnabled);
	const feedbackRest = createDiscordRestClient({
		cfg,
		token,
		accountId
	}).rest;
	const deliveryRest = createDiscordRestClient({
		cfg,
		token,
		accountId
	}).rest;
	const ackReactionContext = createDiscordAckReactionContext({
		rest: feedbackRest,
		cfg,
		accountId
	});
	const discordAdapter = createDiscordAckReactionAdapter({
		channelId: messageChannelId,
		messageId: message.id,
		reactionContext: ackReactionContext
	});
	let statusReactionTarget = `${messageChannelId}/${message.id}`;
	let statusReactionsActive = statusReactionsEnabled;
	let statusReactions = createStatusReactionController({
		enabled: statusReactionsEnabled,
		adapter: discordAdapter,
		initialEmoji: ackReaction,
		emojis: cfg.messages?.statusReactions?.emojis,
		timing: cfg.messages?.statusReactions?.timing,
		onError: (err) => {
			logAckFailure({
				log: logVerbose,
				channel: "discord",
				target: statusReactionTarget,
				error: err
			});
		}
	});
	const resolveTrackedReactionChannelId = async (args) => {
		const target = readToolStringArg(args, "channelId") ?? readToolStringArg(args, "channel_id") ?? readToolStringArg(args, "to");
		if (!target) return messageChannelId;
		try {
			return resolveDiscordChannelId(target);
		} catch {
			return (await resolveDiscordTargetChannelId(target, {
				cfg,
				token,
				accountId
			})).channelId;
		}
	};
	const maybeBindStatusReactionsToToolReaction = async (payload) => {
		if (sourceRepliesAreToolOnly || cfg.messages?.statusReactions?.enabled === false || payload.phase !== "start" || payload.name !== "message" || !payload.args) return;
		const args = payload.args;
		if (readToolStringArg(args, "action")?.toLowerCase() !== "react") return;
		if (!(readToolBooleanArg(args, "trackToolCalls") || readToolBooleanArg(args, "track_tool_calls"))) return;
		const emoji = readToolStringArg(args, "emoji");
		const remove = readToolBooleanArg(args, "remove");
		if (!emoji || remove) return;
		const trackedMessageId = readToolStringArg(args, "messageId") ?? readToolStringArg(args, "message_id") ?? message.id;
		let trackedChannelId;
		try {
			trackedChannelId = await resolveTrackedReactionChannelId(args);
		} catch (err) {
			logAckFailure({
				log: logVerbose,
				channel: "discord",
				target: `${readToolStringArg(args, "to") ?? readToolStringArg(args, "channelId") ?? messageChannelId}/${trackedMessageId}`,
				error: err
			});
			return;
		}
		statusReactionTarget = `${trackedChannelId}/${trackedMessageId}`;
		if (statusReactionsActive) statusReactions.clear();
		statusReactions = createStatusReactionController({
			enabled: true,
			adapter: createDiscordAckReactionAdapter({
				channelId: trackedChannelId,
				messageId: trackedMessageId,
				reactionContext: ackReactionContext
			}),
			initialEmoji: emoji,
			emojis: cfg.messages?.statusReactions?.emojis,
			timing: cfg.messages?.statusReactions?.timing,
			onError: (err) => {
				logAckFailure({
					log: logVerbose,
					channel: "discord",
					target: statusReactionTarget,
					error: err
				});
			}
		});
		statusReactionsActive = true;
		statusReactions.setQueued();
	};
	queueInitialDiscordAckReaction({
		enabled: statusReactionsEnabled,
		shouldSendAckReaction,
		ackReaction,
		statusReactions,
		reactionAdapter: discordAdapter,
		target: `${messageChannelId}/${message.id}`
	});
	const processContext = await buildDiscordMessageProcessContext({
		ctx,
		text,
		mediaList
	});
	if (!processContext) return;
	const { ctxPayload, persistedSessionKey, turn, replyPlan, deliverTarget, replyTarget, replyReference } = processContext;
	observer?.onReplyPlanResolved?.({
		createdThreadId: replyPlan.createdThreadId,
		sessionKey: persistedSessionKey
	});
	const typingChannelId = deliverTarget.startsWith("channel:") ? deliverTarget.slice(8) : messageChannelId;
	const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
		cfg,
		agentId: route.agentId,
		channel: "discord",
		accountId: route.accountId,
		typing: {
			start: () => sendTyping({
				rest: feedbackRest,
				channelId: typingChannelId
			}),
			onStartError: (err) => {
				logTypingFailure({
					log: logVerbose,
					channel: "discord",
					target: typingChannelId,
					error: err
				});
			},
			maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS
		}
	});
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "discord",
		accountId
	});
	const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
		cfg,
		discordConfig,
		accountId
	});
	const chunkMode = resolveChunkMode(cfg, "discord", accountId);
	const clearGroupHistory = () => {
		if (isDirectMessage) return;
		createChannelHistoryWindow({ historyMap: guildHistories }).clear({
			historyKey: messageChannelId,
			limit: historyLimit
		});
	};
	const beginDeliveryCorrelation = () => isRoomEvent ? beginDiscordInboundEventDeliveryCorrelation(ctxPayload.SessionKey, {
		outboundTo: messageChannelId,
		outboundAccountId: route.accountId,
		markInboundEventDelivered: clearGroupHistory
	}, { inboundEventKind: ctxPayload.InboundEventKind }) : () => {};
	const endDiscordInboundEventDeliveryCorrelation = beginDeliveryCorrelation();
	const resolveCurrentTurnTranscriptFinalText = async () => {
		const sessionKey = ctxPayload.SessionKey;
		if (!sessionKey) return;
		try {
			const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
			const store = loadSessionStore(storePath, { clone: false });
			const sessionEntry = resolveSessionStoreEntry({
				store,
				sessionKey
			}).existing;
			if (!sessionEntry?.sessionId) return;
			const { sessionFile } = await resolveAndPersistSessionFile({
				sessionId: sessionEntry.sessionId,
				sessionKey,
				sessionStore: store,
				storePath,
				sessionEntry,
				agentId: route.agentId,
				sessionsDir: path.dirname(storePath)
			});
			const latest = await readLatestAssistantTextFromSessionTranscript(sessionFile);
			if (!latest?.timestamp || latest.timestamp < dispatchStartedAt) return;
			return latest.text;
		} catch (err) {
			logVerbose(`discord transcript final candidate lookup failed: ${String(err)}`);
			return;
		}
	};
	const deliverChannelId = deliverTarget.startsWith("channel:") ? deliverTarget.slice(8) : messageChannelId;
	const draftPreview = createDiscordDraftPreviewController({
		cfg,
		discordConfig,
		accountId,
		sourceRepliesAreToolOnly,
		textLimit,
		deliveryRest,
		deliverChannelId,
		replyReference,
		tableMode,
		maxLinesPerMessage,
		chunkMode,
		log: logVerbose
	});
	const finalPreviewFlags = discordConfig?.suppressEmbeds ?? true ? MessageFlags.SuppressEmbeds : void 0;
	let finalReplyStartNotified = false;
	const notifyFinalReplyStart = () => {
		if (finalReplyStartNotified) return;
		finalReplyStartNotified = true;
		draftPreview.markFinalReplyStarted();
		observer?.onFinalReplyStart?.();
	};
	const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = createReplyDispatcherWithTyping({
		...replyPipeline,
		humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
		deliver: async (payload, info) => {
			if (isProcessAborted(abortSignal)) return;
			const isFinal = info.kind === "final";
			if (payload.isReasoning) return;
			if (isFinal) draftPreview.markFinalReplyStarted();
			const finalText = isFinal && typeof payload.text === "string" ? await resolveTranscriptBackedChannelFinalText({
				finalText: payload.text,
				resolveCandidateText: resolveCurrentTurnTranscriptFinalText
			}) : payload.text;
			const effectivePayload = finalText !== payload.text ? {
				...payload,
				text: finalText
			} : payload;
			const draftStream = draftPreview.draftStream;
			if (draftStream && draftPreview.isProgressMode && info.kind === "block") {
				if (!resolveSendableOutboundReplyParts(effectivePayload).hasMedia && !payload.isError) return;
			}
			if (draftStream && isFinal && (!draftPreview.isProgressMode || draftPreview.hasProgressDraftStarted) && !payload.isError) {
				const hasMedia = resolveSendableOutboundReplyParts(effectivePayload).hasMedia;
				const ttsSupplement = getReplyPayloadTtsSupplement(effectivePayload);
				const previewSourceText = finalText ?? ttsSupplement?.spokenText;
				const previewFinalText = draftPreview.resolvePreviewFinalText(previewSourceText);
				const previewReplyToId = replyReference.peek();
				const hasExplicitReplyDirective = Boolean(effectivePayload.replyToTag || effectivePayload.replyToCurrent) || typeof previewSourceText === "string" && /\[\[\s*reply_to(?:_current|\s*:)/i.test(previewSourceText);
				if ((await deliverWithFinalizableLivePreviewAdapter({
					kind: info.kind,
					payload: effectivePayload,
					adapter: defineFinalizableLivePreviewAdapter({
						draft: {
							flush: () => draftPreview.flush(),
							clear: () => draftStream.clear(),
							discardPending: () => draftStream.discardPending(),
							seal: () => draftStream.seal(),
							id: draftStream.messageId
						},
						buildFinalEdit: () => {
							if (draftPreview.finalizedViaPreviewMessage || hasMedia && !ttsSupplement || typeof previewFinalText !== "string" || hasExplicitReplyDirective || payload.isError) return;
							return {
								content: previewFinalText,
								...finalPreviewFlags ? { flags: finalPreviewFlags } : {}
							};
						},
						editFinal: async (previewMessageId, edit) => {
							if (isProcessAborted(abortSignal)) throw new Error("process aborted");
							notifyFinalReplyStart();
							await editMessageDiscord(deliverChannelId, previewMessageId, edit, {
								cfg,
								accountId,
								rest: deliveryRest
							});
						},
						onPreviewFinalized: () => {
							draftPreview.markFinalReplyDelivered();
							draftPreview.markPreviewFinalized();
							replyReference.markSent();
							observer?.onFinalReplyDelivered?.();
						},
						buildSupplementalPayload: () => ttsSupplement ? buildTtsSupplementMediaPayload(effectivePayload) : void 0,
						deliverSupplemental: async (supplementalPayload) => {
							if (isProcessAborted(abortSignal)) return false;
							const supplementalReplyToId = previewReplyToId ?? replyReference.peek() ?? (replyToMode === "all" ? typeof message.id === "string" && message.id ? message.id : ctxPayload.MessageSid : void 0);
							await deliverDiscordReply({
								cfg,
								replies: [supplementalPayload],
								target: deliverTarget,
								token,
								accountId,
								rest: deliveryRest,
								runtime,
								replyToId: supplementalReplyToId,
								replyToMode,
								textLimit,
								maxLinesPerMessage,
								tableMode,
								chunkMode,
								sessionKey: ctxPayload.SessionKey,
								threadBindings,
								mediaLocalRoots,
								kind: info.kind
							});
							return true;
						},
						logPreviewEditFailure: (err) => {
							logVerbose(`discord: preview final edit failed; falling back to standard send (${String(err)})`);
						}
					}),
					deliverNormally: async () => {
						if (isProcessAborted(abortSignal)) return false;
						const fallbackPayload = ttsSupplement && ttsSupplement.visibleTextAlreadyDelivered !== true && !effectivePayload.text?.trim() ? {
							...effectivePayload,
							text: ttsSupplement.spokenText
						} : effectivePayload;
						const replyToId = replyReference.use();
						notifyFinalReplyStart();
						await deliverDiscordReply({
							cfg,
							replies: [fallbackPayload],
							target: deliverTarget,
							token,
							accountId,
							rest: deliveryRest,
							runtime,
							replyToId,
							replyToMode,
							textLimit,
							maxLinesPerMessage,
							tableMode,
							chunkMode,
							sessionKey: ctxPayload.SessionKey,
							threadBindings,
							mediaLocalRoots,
							kind: info.kind
						});
						return true;
					},
					onNormalDelivered: () => {
						draftPreview.markFinalReplyDelivered();
						replyReference.markSent();
						observer?.onFinalReplyDelivered?.();
					}
				})).kind !== "normal-skipped") return;
			}
			if (isProcessAborted(abortSignal)) return;
			const replyToId = replyReference.use();
			if (isFinal) notifyFinalReplyStart();
			await deliverDiscordReply({
				cfg,
				replies: [effectivePayload],
				target: deliverTarget,
				token,
				accountId,
				rest: deliveryRest,
				runtime,
				replyToId,
				replyToMode,
				textLimit,
				maxLinesPerMessage,
				tableMode,
				chunkMode,
				sessionKey: ctxPayload.SessionKey,
				threadBindings,
				mediaLocalRoots,
				kind: info.kind
			});
			replyReference.markSent();
			if (isFinal && payload.isError !== true) {
				draftPreview.markFinalReplyDelivered();
				observer?.onFinalReplyDelivered?.();
			}
		},
		onError: (err, info) => {
			runtime.error?.(danger(formatDiscordReplyDeliveryFailure({
				kind: info.kind,
				err,
				target: deliverTarget,
				sessionKey: ctxPayload.SessionKey
			})));
		},
		onReplyStart: async () => {
			if (isProcessAborted(abortSignal)) return;
			await replyPipeline.typingCallbacks?.onReplyStart();
			await statusReactions.setThinking();
		}
	});
	const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);
	let dispatchResult = null;
	let dispatchError = false;
	let dispatchAborted = false;
	let dispatchSettledBeforeStart = false;
	const settleDispatchBeforeStart = async () => {
		dispatchSettledBeforeStart = true;
		await settleReplyDispatcher({
			dispatcher,
			onSettled: () => {
				markRunComplete();
				markDispatchIdle();
			}
		});
	};
	try {
		if (isProcessAborted(abortSignal)) {
			dispatchAborted = true;
			await settleDispatchBeforeStart();
			return;
		}
		const preparedResult = await runPreparedInboundReplyTurn({
			channel: "discord",
			accountId: route.accountId,
			routeSessionKey: persistedSessionKey,
			storePath: turn.storePath,
			ctxPayload,
			recordInboundSession,
			record: turn.record,
			history: isRoomEvent ? void 0 : {
				isGroup: isGuildMessage,
				historyKey: messageChannelId,
				historyMap: guildHistories,
				limit: historyLimit
			},
			onPreDispatchFailure: settleDispatchBeforeStart,
			runDispatch: async () => await dispatchInboundMessage({
				ctx: ctxPayload,
				cfg,
				dispatcher,
				replyOptions: {
					...replyOptions,
					abortSignal,
					skillFilter: channelConfig?.skills,
					sourceReplyDeliveryMode,
					queuedDeliveryCorrelations: isRoomEvent ? [{ begin: beginDeliveryCorrelation }] : void 0,
					suppressTyping: isRoomEvent ? true : void 0,
					allowProgressCallbacksWhenSourceDeliverySuppressed: sourceRepliesAreToolOnly && draftPreview.draftStream && draftPreview.isProgressMode ? true : void 0,
					disableBlockStreaming: sourceRepliesAreToolOnly ? true : draftPreview.disableBlockStreamingForDraft ?? (typeof resolvedBlockStreamingEnabled === "boolean" ? !resolvedBlockStreamingEnabled : void 0),
					onPartialReply: draftPreview.draftStream && !draftPreview.isProgressMode ? (payload) => draftPreview.updateFromPartial(payload.text) : void 0,
					onAssistantMessageStart: draftPreview.draftStream ? () => draftPreview.handleAssistantMessageBoundary() : void 0,
					onReasoningEnd: draftPreview.draftStream ? () => draftPreview.handleAssistantMessageBoundary() : void 0,
					onModelSelected,
					suppressDefaultToolProgressMessages: draftPreview.suppressDefaultToolProgressMessages ? true : void 0,
					onReasoningStream: async (payload) => {
						await statusReactions.setThinking();
						const formattedText = payload?.text ? formatReasoningMessage(payload.text) : void 0;
						await draftPreview.pushReasoningProgress(formattedText);
					},
					onToolStart: async (payload) => {
						if (isProcessAborted(abortSignal)) return;
						await maybeBindStatusReactionsToToolReaction(payload);
						await statusReactions.setTool(payload.name);
						await draftPreview.pushToolProgress(buildChannelProgressDraftLineForEntry(discordConfig, {
							event: "tool",
							name: payload.name,
							phase: payload.phase,
							args: payload.args
						}, payload.detailMode ? { detailMode: payload.detailMode } : void 0), { toolName: payload.name });
					},
					onItemEvent: async (payload) => {
						await draftPreview.pushToolProgress(buildChannelProgressDraftLineForEntry(discordConfig, {
							event: "item",
							itemId: payload.itemId,
							itemKind: payload.kind,
							title: payload.title,
							name: payload.name,
							phase: payload.phase,
							status: payload.status,
							summary: payload.summary,
							progressText: payload.progressText,
							meta: payload.meta
						}));
					},
					onPlanUpdate: async (payload) => {
						if (payload.phase !== "update") return;
						await draftPreview.pushToolProgress(buildChannelProgressDraftLine({
							event: "plan",
							phase: payload.phase,
							title: payload.title,
							explanation: payload.explanation,
							steps: payload.steps
						}));
					},
					onApprovalEvent: async (payload) => {
						if (payload.phase !== "requested") return;
						await draftPreview.pushToolProgress(buildChannelProgressDraftLine({
							event: "approval",
							phase: payload.phase,
							title: payload.title,
							command: payload.command,
							reason: payload.reason,
							message: payload.message
						}));
					},
					onCommandOutput: async (payload) => {
						if (payload.phase !== "end") return;
						await draftPreview.pushToolProgress(buildChannelProgressDraftLine({
							event: "command-output",
							phase: payload.phase,
							title: payload.title,
							name: payload.name,
							status: payload.status,
							exitCode: payload.exitCode
						}));
					},
					onPatchSummary: async (payload) => {
						if (payload.phase !== "end") return;
						await draftPreview.pushToolProgress(buildChannelProgressDraftLine({
							event: "patch",
							phase: payload.phase,
							title: payload.title,
							name: payload.name,
							added: payload.added,
							modified: payload.modified,
							deleted: payload.deleted,
							summary: payload.summary
						}));
					},
					onCompactionStart: async () => {
						if (isProcessAborted(abortSignal)) return;
						await statusReactions.setCompacting();
					},
					onCompactionEnd: async () => {
						if (isProcessAborted(abortSignal)) return;
						statusReactions.cancelPending();
						await statusReactions.setThinking();
					}
				}
			})
		});
		if (!preparedResult.dispatched) return;
		dispatchResult = preparedResult.dispatchResult;
		if (isProcessAborted(abortSignal)) {
			dispatchAborted = true;
			return;
		}
	} catch (err) {
		if (isProcessAborted(abortSignal)) {
			dispatchAborted = true;
			return;
		}
		dispatchError = true;
		throw err;
	} finally {
		endDiscordInboundEventDeliveryCorrelation();
		try {
			await draftPreview.cleanup();
		} finally {
			if (!dispatchSettledBeforeStart) {
				markRunComplete();
				markDispatchIdle();
			}
		}
		const finalDeliveryFailed = (dispatchResult?.failedCounts?.final ?? 0) > 0;
		if (statusReactionsActive) if (dispatchAborted) if (removeAckAfterReply) statusReactions.clear();
		else statusReactions.restoreInitial();
		else {
			if (dispatchError || finalDeliveryFailed) await statusReactions.setError();
			else await statusReactions.setDone();
			if (removeAckAfterReply) (async () => {
				await sleep(dispatchError || finalDeliveryFailed ? DEFAULT_TIMING.errorHoldMs : DEFAULT_TIMING.doneHoldMs);
				await statusReactions.clear();
			})();
			else statusReactions.restoreInitial();
		}
		else if (shouldSendAckReaction && ackReaction && removeAckAfterReply) removeReactionDiscord(messageChannelId, message.id, ackReaction, ackReactionContext).catch((err) => {
			logAckFailure({
				log: logVerbose,
				channel: "discord",
				target: `${messageChannelId}/${message.id}`,
				error: err
			});
		});
	}
	if (dispatchAborted) return;
	const finalDispatchResult = dispatchResult;
	if (!finalDispatchResult || !hasFinalChannelTurnDispatch(finalDispatchResult)) return;
	if (shouldLogVerbose()) {
		const finalCount = finalDispatchResult.counts.final;
		logVerbose(`discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`);
	}
}
//#endregion
export { processDiscordMessage };
