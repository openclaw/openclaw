import { f as resolveDiscordMaxLinesPerMessage } from "./accounts-CaHGiVB4.js";
import { a as chunkDiscordTextWithMode, s as resolveDiscordChannelId } from "./normalize-B-ktw-T_.js";
import { $ as createChannelMessage, it as editChannelMessage, nt as deleteChannelMessage, t as discord_exports } from "./discord-eZlimVfW.js";
import { N as createDiscordRestClient, P as createDiscordRuntimeAccountContext, d as resolveDiscordTargetChannelId } from "./send.shared-e9Pd_Em0.js";
import { i as resolveTimestampMs } from "./format-D8TsaXxW.js";
import { a as normalizeDiscordSlug, r as normalizeDiscordAllowList } from "./allow-list-ek-1hMKN.js";
import { a as removeReactionDiscord, f as editMessageDiscord, r as reactMessageDiscord } from "./send-Dw6Da1m2.js";
import "./targets-B7OfGFt8.js";
import { t as resolveDiscordConversationIdentity } from "./conversation-identity-BN9wSmxJ.js";
import { t as DISCORD_TEXT_CHUNK_LIMIT } from "./outbound-adapter-B-mzejZP.js";
import { t as resolveDiscordPreviewStreamMode } from "./preview-streaming-BzkA67Qa.js";
import { n as DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS, t as DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS } from "./timeouts-C7jeTtGs.js";
import { a as resolveForwardedMediaList, i as buildDiscordMediaPayload, o as resolveMediaList, r as resolveDiscordMessageText } from "./message-utils-Dmgu-7fC.js";
import { a as resolveDiscordThreadStarter, n as resolveDiscordAutoThreadReplyPlan } from "./threading-Bi95Nz8h.js";
import { t as sendTyping } from "./typing-BSi1dUHm.js";
import { n as buildDiscordInboundAccessContext, r as createDiscordSupplementalContextAccessChecker } from "./inbound-context-e_oBBJtF.js";
import { i as resolveReplyContext, n as buildDirectLabel, r as buildGuildLabel, t as deliverDiscordReply } from "./reply-delivery-uCiWAyIt.js";
import { convertMarkdownTables, stripInlineDirectiveTagsForDelivery, stripReasoningTagsFromText, truncateUtf16Safe } from "openclaw/plugin-sdk/text-runtime";
import { buildAgentSessionKey, normalizeAccountId, resolveAccountEntry, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { createChannelProgressDraftGate, formatChannelProgressDraftLine, formatChannelProgressDraftText, isChannelProgressDraftWorkToolName, resolveChannelProgressDraftMaxLines, resolveChannelStreamingBlockEnabled, resolveChannelStreamingPreviewChunk, resolveChannelStreamingPreviewToolProgress, resolveChannelStreamingSuppressDefaultToolProgressMessages } from "openclaw/plugin-sdk/channel-streaming";
import { recordInboundSession, resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/conversation-runtime";
import { EmbeddedBlockChunker, resolveAckReaction, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { createFinalizableDraftLifecycle, deliverFinalizableDraftPreview } from "openclaw/plugin-sdk/channel-lifecycle";
import { createChannelReplyPipeline, resolveChannelSourceReplyDeliveryMode } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { hasFinalInboundReplyDispatch, runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { buildPendingHistoryContextFromMap } from "openclaw/plugin-sdk/reply-history";
import { DEFAULT_TIMING, createStatusReactionController, logAckFailure, logTypingFailure, shouldAckReaction } from "openclaw/plugin-sdk/channel-feedback";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
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
async function buildDiscordMessageProcessContext(params) {
	const { ctx, text, mediaList } = params;
	const { cfg, discordConfig, accountId, runtime, guildHistories, historyLimit, replyToMode, message, author, sender, canonicalMessageId, data, client, channelInfo, channelName, messageChannelId, isGuildMessage, isDirectMessage, baseText, preflightAudioTranscript, threadChannel, threadParentId, threadParentName, threadParentType, threadName, displayChannelSlug, guildInfo, guildSlug, memberRoleIds, channelConfig, baseSessionKey, boundSessionKey, route, commandAuthorized } = ctx;
	const fromLabel = isDirectMessage ? buildDirectLabel(author) : buildGuildLabel({
		guild: data.guild ?? void 0,
		channelName: channelName ?? messageChannelId,
		channelId: messageChannelId
	});
	const senderLabel = sender.label;
	const isForumParent = threadParentType === discord_exports.ChannelType.GuildForum || threadParentType === discord_exports.ChannelType.GuildMedia;
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
		channelTopic: channelInfo?.topic,
		messageBody: text
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
	const shouldIncludeChannelHistory = !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
	if (shouldIncludeChannelHistory) combinedBody = buildPendingHistoryContextFromMap({
		historyMap: guildHistories,
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
	const mediaPayload = buildDiscordMediaPayload(mediaList);
	const preflightAudioIndex = preflightAudioTranscript === void 0 ? -1 : mediaList.findIndex((media) => media.contentType?.startsWith("audio/"));
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
		channelConfig,
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
	const inboundHistory = shouldIncludeChannelHistory && historyLimit > 0 ? (guildHistories.get(messageChannelId) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	const originatingTo = autoThreadContext?.OriginatingTo ?? dmConversationTarget ?? replyTarget;
	const effectiveSessionKey = boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey;
	const effectivePreviousTimestamp = effectiveSessionKey === route.sessionKey ? previousTimestamp : readSessionUpdatedAt({
		storePath,
		sessionKey: effectiveSessionKey
	});
	const ctxPayload = finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: preflightAudioTranscript ?? baseText ?? text,
		InboundHistory: inboundHistory,
		RawBody: preflightAudioTranscript ?? baseText,
		CommandBody: preflightAudioTranscript ?? baseText,
		...preflightAudioTranscript !== void 0 ? { Transcript: preflightAudioTranscript } : {},
		From: effectiveFrom,
		To: effectiveTo,
		SessionKey: effectiveSessionKey,
		AccountId: route.accountId,
		ChatType: isDirectMessage ? "direct" : "channel",
		ConversationLabel: fromLabel,
		SenderName: senderName,
		SenderId: sender.id,
		SenderUsername: senderUsername,
		SenderTag: sender.tag,
		GroupSubject: groupSubject,
		GroupChannel: groupChannel,
		MemberRoleIds: memberRoleIds,
		UntrustedContext: untrustedContext,
		GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : void 0,
		GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || void 0 : void 0,
		OwnerAllowFrom: ownerAllowFrom,
		Provider: "discord",
		Surface: "discord",
		WasMentioned: ctx.effectiveWasMentioned,
		MessageSid: canonicalMessageId ?? message.id,
		...canonicalMessageId && canonicalMessageId !== message.id ? { MessageSidFull: message.id } : {},
		ReplyToId: filteredReplyContext?.id,
		ReplyToBody: filteredReplyContext?.body,
		ReplyToSender: filteredReplyContext?.sender,
		ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
		ModelParentSessionKey: autoThreadContext?.ModelParentSessionKey ?? modelParentSessionKey ?? void 0,
		MessageThreadId: threadChannel?.id ?? autoThreadContext?.createdThreadId ?? void 0,
		ThreadStarterBody: !effectivePreviousTimestamp ? threadStarterBody : void 0,
		ThreadLabel: threadLabel,
		Timestamp: resolveTimestampMs(message.timestamp),
		...mediaPayload,
		...preflightAudioIndex >= 0 ? { MediaTranscribedIndexes: [preflightAudioIndex] } : {},
		CommandAuthorized: commandAuthorized,
		CommandSource: "text",
		OriginatingChannel: "discord",
		OriginatingTo: originatingTo
	});
	const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;
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
					allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS
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
	const draftStream = !params.sourceRepliesAreToolOnly && discordStreamMode !== "off" && !accountBlockStreamingEnabled ? createDiscordDraftStream({
		rest: params.deliveryRest,
		channelId: params.deliverChannelId,
		maxChars: draftMaxChars,
		replyToMessageId: () => params.replyReference.peek(),
		minInitialChars: discordStreamMode === "progress" ? 0 : 30,
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
	let finalDeliveryHandled = false;
	const previewToolProgressEnabled = Boolean(draftStream) && resolveChannelStreamingPreviewToolProgress(params.discordConfig);
	const suppressDefaultToolProgressMessages = Boolean(draftStream) && resolveChannelStreamingSuppressDefaultToolProgressMessages(params.discordConfig, {
		draftStreamActive: true,
		previewToolProgressEnabled
	});
	let previewToolProgressSuppressed = false;
	let previewToolProgressLines = [];
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
		markFinalDeliveryHandled() {
			finalDeliveryHandled = true;
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
			if (options?.toolName !== void 0 && !isChannelProgressDraftWorkToolName(options.toolName)) return;
			const normalized = line?.replace(/\s+/g, " ").trim();
			if (discordStreamMode !== "progress") {
				if (!previewToolProgressEnabled || previewToolProgressSuppressed || !normalized) return;
				if (previewToolProgressLines.at(-1) === normalized) return;
				previewToolProgressLines = [...previewToolProgressLines, normalized].slice(-resolveChannelProgressDraftMaxLines(params.discordConfig));
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
			if (previewToolProgressEnabled && !previewToolProgressSuppressed && normalized) {
				if (previewToolProgressLines.at(-1) !== normalized) previewToolProgressLines = [...previewToolProgressLines, normalized].slice(-resolveChannelProgressDraftMaxLines(params.discordConfig));
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
				if (!finalDeliveryHandled) await draftStream?.discardPending();
				if (!finalDeliveryHandled && !finalizedViaPreviewMessage && draftStream?.messageId()) await draftStream.clear();
			} catch (err) {
				params.log(`discord: draft cleanup failed: ${String(err)}`);
			}
		}
	};
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
	replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
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
	const { cfg, discordConfig, accountId, token, runtime, guildHistories, historyLimit, mediaMaxBytes, textLimit, replyToMode, ackReactionScope, message, messageChannelId, isGuildMessage, isDirectMessage, isGroupDm, messageText, shouldRequireMention, canDetectMention, effectiveWasMentioned, shouldBypassMention, channelConfig, threadBindings, route, discordRestFetch, abortSignal } = ctx;
	if (isProcessAborted(abortSignal)) return;
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
		ctx: { ChatType: isGuildMessage ? "channel" : void 0 }
	});
	const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "discord",
		accountId
	});
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
	const shouldAckReaction$1 = () => Boolean(ackReaction && shouldAckReaction({
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
	const statusReactionsEnabled = shouldSendAckReaction && cfg.messages?.statusReactions?.enabled !== false && (!sourceRepliesAreToolOnly || statusReactionsExplicitlyEnabled);
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
	let finalReplyStartNotified = false;
	const notifyFinalReplyStart = () => {
		if (finalReplyStartNotified) return;
		finalReplyStartNotified = true;
		observer?.onFinalReplyStart?.();
	};
	const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = createReplyDispatcherWithTyping({
		...replyPipeline,
		humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
		deliver: async (payload, info) => {
			if (isProcessAborted(abortSignal)) return;
			const isFinal = info.kind === "final";
			if (payload.isReasoning) return;
			const draftStream = draftPreview.draftStream;
			if (draftStream && draftPreview.isProgressMode && info.kind === "block") {
				if (!resolveSendableOutboundReplyParts(payload).hasMedia && !payload.isError) return;
			}
			if (draftStream && isFinal && (!draftPreview.isProgressMode || draftPreview.hasProgressDraftStarted)) {
				draftPreview.markFinalDeliveryHandled();
				const hasMedia = resolveSendableOutboundReplyParts(payload).hasMedia;
				const finalText = payload.text;
				const previewFinalText = draftPreview.resolvePreviewFinalText(finalText);
				const hasExplicitReplyDirective = Boolean(payload.replyToTag || payload.replyToCurrent) || typeof finalText === "string" && /\[\[\s*reply_to(?:_current|\s*:)/i.test(finalText);
				if (await deliverFinalizableDraftPreview({
					kind: info.kind,
					payload,
					draft: {
						flush: () => draftPreview.flush(),
						clear: () => draftStream.clear(),
						discardPending: () => draftStream.discardPending(),
						seal: () => draftStream.seal(),
						id: draftStream.messageId
					},
					buildFinalEdit: () => {
						if (draftPreview.finalizedViaPreviewMessage || hasMedia || typeof previewFinalText !== "string" || hasExplicitReplyDirective || payload.isError) return;
						return { content: previewFinalText };
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
					deliverNormally: async () => {
						if (isProcessAborted(abortSignal)) return false;
						const replyToId = replyReference.use();
						notifyFinalReplyStart();
						await deliverDiscordReply({
							cfg,
							replies: [payload],
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
							mediaLocalRoots
						});
						replyReference.markSent();
						observer?.onFinalReplyDelivered?.();
						return true;
					},
					onPreviewFinalized: () => {
						draftPreview.markPreviewFinalized();
						replyReference.markSent();
						observer?.onFinalReplyDelivered?.();
					},
					logPreviewEditFailure: (err) => {
						logVerbose(`discord: preview final edit failed; falling back to standard send (${String(err)})`);
					}
				}) !== "normal-skipped") return;
			}
			if (isProcessAborted(abortSignal)) return;
			const replyToId = replyReference.use();
			if (isFinal) notifyFinalReplyStart();
			await deliverDiscordReply({
				cfg,
				replies: [payload],
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
				mediaLocalRoots
			});
			replyReference.markSent();
			if (isFinal) observer?.onFinalReplyDelivered?.();
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
		const preparedResult = await runInboundReplyTurn({
			channel: "discord",
			accountId: route.accountId,
			raw: ctx,
			adapter: {
				ingest: () => ({
					id: message.id,
					timestamp: message.timestamp ? Date.parse(message.timestamp) : void 0,
					rawText: text,
					textForAgent: ctxPayload.BodyForAgent,
					textForCommands: ctxPayload.CommandBody,
					raw: message
				}),
				resolveTurn: () => ({
					channel: "discord",
					accountId: route.accountId,
					routeSessionKey: persistedSessionKey,
					storePath: turn.storePath,
					ctxPayload,
					recordInboundSession,
					record: turn.record,
					history: {
						isGroup: isGuildMessage,
						historyKey: messageChannelId,
						historyMap: guildHistories,
						limit: historyLimit
					},
					onPreDispatchFailure: settleDispatchBeforeStart,
					runDispatch: async () => {
						return await dispatchInboundMessage({
							ctx: ctxPayload,
							cfg,
							dispatcher,
							replyOptions: {
								...replyOptions,
								abortSignal,
								skillFilter: channelConfig?.skills,
								sourceReplyDeliveryMode,
								disableBlockStreaming: sourceRepliesAreToolOnly ? true : draftPreview.disableBlockStreamingForDraft ?? (typeof resolvedBlockStreamingEnabled === "boolean" ? !resolvedBlockStreamingEnabled : void 0),
								onPartialReply: draftPreview.draftStream ? (payload) => draftPreview.updateFromPartial(payload.text) : void 0,
								onAssistantMessageStart: draftPreview.draftStream ? () => draftPreview.handleAssistantMessageBoundary() : void 0,
								onReasoningEnd: draftPreview.draftStream ? () => draftPreview.handleAssistantMessageBoundary() : void 0,
								onModelSelected,
								suppressDefaultToolProgressMessages: draftPreview.suppressDefaultToolProgressMessages ? true : void 0,
								onReasoningStream: async () => {
									await statusReactions.setThinking();
								},
								onToolStart: async (payload) => {
									if (isProcessAborted(abortSignal)) return;
									await maybeBindStatusReactionsToToolReaction(payload);
									await statusReactions.setTool(payload.name);
									await draftPreview.pushToolProgress(formatChannelProgressDraftLine({
										event: "tool",
										name: payload.name,
										phase: payload.phase,
										args: payload.args
									}, payload.detailMode ? { detailMode: payload.detailMode } : void 0), { toolName: payload.name });
								},
								onItemEvent: async (payload) => {
									await draftPreview.pushToolProgress(formatChannelProgressDraftLine({
										event: "item",
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
									await draftPreview.pushToolProgress(formatChannelProgressDraftLine({
										event: "plan",
										phase: payload.phase,
										title: payload.title,
										explanation: payload.explanation,
										steps: payload.steps
									}));
								},
								onApprovalEvent: async (payload) => {
									if (payload.phase !== "requested") return;
									await draftPreview.pushToolProgress(formatChannelProgressDraftLine({
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
									await draftPreview.pushToolProgress(formatChannelProgressDraftLine({
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
									await draftPreview.pushToolProgress(formatChannelProgressDraftLine({
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
						});
					}
				})
			}
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
		try {
			await draftPreview.cleanup();
		} finally {
			if (!dispatchSettledBeforeStart) {
				markRunComplete();
				markDispatchIdle();
			}
		}
		if (statusReactionsActive) if (dispatchAborted) if (removeAckAfterReply) statusReactions.clear();
		else statusReactions.restoreInitial();
		else {
			if (dispatchError) await statusReactions.setError();
			else await statusReactions.setDone();
			if (removeAckAfterReply) (async () => {
				await sleep(dispatchError ? DEFAULT_TIMING.errorHoldMs : DEFAULT_TIMING.doneHoldMs);
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
	if (!finalDispatchResult || !hasFinalInboundReplyDispatch(finalDispatchResult)) return;
	if (shouldLogVerbose()) {
		const finalCount = finalDispatchResult.counts.final;
		logVerbose(`discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`);
	}
}
//#endregion
export { processDiscordMessage };
