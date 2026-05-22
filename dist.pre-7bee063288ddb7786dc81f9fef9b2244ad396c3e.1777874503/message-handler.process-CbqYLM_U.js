import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { y as truncateUtf16Safe } from "./utils-CCskKJVV.js";
import { a as shouldLogVerbose, r as logVerbose, t as danger } from "./globals-C7I_COwU.js";
import { n as normalizeAccountId } from "./account-id-DUpVOe8L.js";
import { d as resolveThreadSessionKeys } from "./session-key-BSgfYlBK.js";
import { t as resolveAccountEntry } from "./account-lookup-IHwT3A43.js";
import { u as resolveStorePath } from "./paths-Dl79wsM6.js";
import { n as readSessionUpdatedAt } from "./store-IyLBOjUO.js";
import { r as stripInlineDirectiveTagsForDelivery } from "./directive-tags-B1b9dtWF.js";
import { u as stripReasoningTagsFromText } from "./assistant-visible-text-BbjDz5HF.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-B61Gbdzt.js";
import { t as EmbeddedBlockChunker } from "./pi-embedded-block-chunker-CIwnXy2g.js";
import { r as getAgentScopedMediaLocalRoots } from "./local-roots-CUkWYVtg.js";
import { c as resolveChannelStreamingPreviewToolProgress, i as resolveChannelStreamingBlockEnabled, s as resolveChannelStreamingPreviewChunk } from "./channel-streaming-BFQKL9hJ.js";
import { c as resolveTextChunkLimit, s as resolveChunkMode } from "./chunk-D2H_19Xb.js";
import { t as buildAgentSessionKey } from "./resolve-route-CgJzhPkB.js";
import { i as resolveHumanDelayConfig, t as resolveAckReaction } from "./identity-Be40H-5J.js";
import { t as finalizeInboundContext } from "./inbound-context-7ossg2z_.js";
import { t as convertMarkdownTables } from "./tables-Da_CoTmG.js";
import "./text-runtime-icMZVCaq.js";
import "./routing-CvMyJlKL.js";
import "./error-runtime-B9i9dR6-.js";
import { a as resolveEnvelopeFormatOptions, r as formatInboundEnvelope } from "./envelope-D8z1xEXs.js";
import { i as shouldAckReaction } from "./ack-reactions-C-NmIsUB.js";
import { t as recordInboundSession } from "./session-DsuzeLfr.js";
import { o as buildPendingHistoryContextFromMap } from "./history-BNSb9V71.js";
import { n as hasFinalChannelTurnDispatch } from "./dispatch-result-vD_r1T2i.js";
import { t as evaluateSupplementalContextVisibility } from "./context-visibility-CPmLQtEe.js";
import { t as resolveMarkdownTableMode } from "./markdown-tables-DOmSgsqv.js";
import { n as resolveChannelSourceReplyDeliveryMode, t as createChannelReplyPipeline } from "./channel-reply-pipeline-o-LATR-A.js";
import { n as isDangerousNameMatchingEnabled } from "./dangerous-name-matching-B5hD9Rz4.js";
import { l as resolvePinnedMainDmOwnerFromAllowlist } from "./dm-policy-shared-DAgHnxNz.js";
import "./reply-history-DcELOn43.js";
import { r as logTypingFailure, t as logAckFailure } from "./logging-C5DdZpTX.js";
import "./runtime-env-BBcuHj0d.js";
import { t as resolveChannelContextVisibilityMode } from "./context-visibility-C-GvM6x1.js";
import "./reply-dispatch-runtime-X15FNsXA.js";
import "./reply-chunking-CRxdpUGk.js";
import { a as runInboundReplyTurn } from "./inbound-reply-dispatch-BNcsRuO0.js";
import "./media-runtime-5rxXL-Os.js";
import "./conversation-runtime-BlWZn7q0.js";
import "./agent-runtime-_7ygFxxf.js";
import "./security-runtime-UeJYXWvz.js";
import "./markdown-table-runtime-BCQyeDEk.js";
import { a as createStatusReactionController, r as DEFAULT_TIMING } from "./channel-feedback-BC9FQHoQ.js";
import "./channel-inbound-VYaKf4i3.js";
import { c as deliverFinalizableDraftPreview, r as createFinalizableDraftLifecycle } from "./channel-lifecycle-ky0xWT7L.js";
import "./session-store-runtime-kmcykxzs.js";
import { f as resolveDiscordMaxLinesPerMessage } from "./accounts-lkwKOGNX.js";
import { a as chunkDiscordTextWithMode } from "./normalize-CXn44Q3y.js";
import { It as ChannelType, Q as createChannelMessage, rt as editChannelMessage, tt as deleteChannelMessage } from "./discord-COXSKWSt.js";
import { N as createDiscordRestClient, P as createDiscordRuntimeAccountContext } from "./send.shared-BgtjIk0s.js";
import { i as resolveTimestampMs } from "./format-GVI6xk1U.js";
import { a as normalizeDiscordSlug, r as normalizeDiscordAllowList } from "./allow-list-V4K1OMN4.js";
import { d as editMessageDiscord, i as removeReactionDiscord, n as reactMessageDiscord } from "./send-pG2sCBOD.js";
import { t as resolveDiscordConversationIdentity } from "./conversation-identity-CjyjGwIe.js";
import { t as DISCORD_TEXT_CHUNK_LIMIT } from "./outbound-adapter-D7X2AgQx.js";
import { t as resolveDiscordPreviewStreamMode } from "./preview-streaming-CFDP_7rI.js";
import { n as DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS, t as DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS } from "./timeouts-DSWCWqcp.js";
import { a as resolveForwardedMediaList, i as buildDiscordMediaPayload, o as resolveMediaList, r as resolveDiscordMessageText } from "./message-utils-BmS0jxXy.js";
import { c as resolveDiscordThreadStarter, r as resolveDiscordAutoThreadReplyPlan } from "./threading-DiQdNjvw.js";
import { n as buildDiscordInboundAccessContext, r as createDiscordSupplementalContextAccessChecker } from "./inbound-context-_JZbHeZI.js";
import { i as resolveReplyContext, n as buildDirectLabel, r as buildGuildLabel, t as deliverDiscordReply } from "./reply-delivery-DHyn-l6h.js";
import { t as sendTyping } from "./typing-DCrQq_-a.js";
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
		minInitialChars: 30,
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
	let previewToolProgressSuppressed = false;
	let previewToolProgressLines = [];
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
		pushToolProgress(line) {
			if (!draftStream || !previewToolProgressEnabled || previewToolProgressSuppressed) return;
			const normalized = line?.replace(/\s+/g, " ").trim();
			if (!normalized) return;
			if (previewToolProgressLines.at(-1) === normalized) return;
			previewToolProgressLines = [...previewToolProgressLines, normalized].slice(-8);
			const previewText = ["Working…", ...previewToolProgressLines.map((entry) => `• ${entry}`)].join("\n");
			lastPartialText = previewText;
			draftText = previewText;
			hasStreamedMessage = true;
			draftChunker?.reset();
			draftStream.update(previewText);
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
		handleAssistantMessageBoundary: forceNewMessageIfNeeded,
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
	const statusReactionsEnabled = !sourceRepliesAreToolOnly && shouldSendAckReaction && cfg.messages?.statusReactions?.enabled !== false;
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
	const statusReactions = createStatusReactionController({
		enabled: statusReactionsEnabled,
		adapter: discordAdapter,
		initialEmoji: ackReaction,
		emojis: cfg.messages?.statusReactions?.emojis,
		timing: cfg.messages?.statusReactions?.timing,
		onError: (err) => {
			logAckFailure({
				log: logVerbose,
				channel: "discord",
				target: `${messageChannelId}/${message.id}`,
				error: err
			});
		}
	});
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
			if (draftStream && isFinal) {
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
					runDispatch: () => dispatchInboundMessage({
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
							onAssistantMessageStart: draftPreview.draftStream ? draftPreview.handleAssistantMessageBoundary : void 0,
							onReasoningEnd: draftPreview.draftStream ? draftPreview.handleAssistantMessageBoundary : void 0,
							onModelSelected,
							suppressDefaultToolProgressMessages: draftPreview.previewToolProgressEnabled ? true : void 0,
							onReasoningStream: async () => {
								await statusReactions.setThinking();
							},
							onToolStart: async (payload) => {
								if (isProcessAborted(abortSignal)) return;
								await statusReactions.setTool(payload.name);
								draftPreview.pushToolProgress(payload.name ? `tool: ${payload.name}` : "tool running");
							},
							onItemEvent: async (payload) => {
								draftPreview.pushToolProgress(payload.progressText ?? payload.summary ?? payload.title ?? payload.name);
							},
							onPlanUpdate: async (payload) => {
								if (payload.phase !== "update") return;
								draftPreview.pushToolProgress(payload.explanation ?? payload.steps?.[0] ?? "planning");
							},
							onApprovalEvent: async (payload) => {
								if (payload.phase !== "requested") return;
								draftPreview.pushToolProgress(payload.command ? `approval: ${payload.command}` : "approval requested");
							},
							onCommandOutput: async (payload) => {
								if (payload.phase !== "end") return;
								draftPreview.pushToolProgress(payload.name ? `${payload.name}${payload.exitCode === 0 ? " ✓" : payload.exitCode != null ? ` (exit ${payload.exitCode})` : ""}` : payload.title);
							},
							onPatchSummary: async (payload) => {
								if (payload.phase !== "end") return;
								draftPreview.pushToolProgress(payload.summary ?? payload.title ?? "patch applied");
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
		if (statusReactionsEnabled) if (dispatchAborted) if (removeAckAfterReply) statusReactions.clear();
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
	if (!finalDispatchResult || !hasFinalChannelTurnDispatch(finalDispatchResult)) return;
	if (shouldLogVerbose()) {
		const finalCount = finalDispatchResult.counts.final;
		logVerbose(`discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`);
	}
}
//#endregion
export { processDiscordMessage };
