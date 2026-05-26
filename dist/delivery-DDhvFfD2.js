import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { o as root } from "./secure-temp-dir-aidxCRgA.js";
import { r as logVerbose, s as warn, t as danger } from "./globals-YU5FjfZK.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { t as getGlobalHookRunner, u as fireAndForgetHook } from "./hook-runner-global-BkXXy1ub.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { c as kindFromMime, s as isGifMedia } from "./mime-DppuT-pZ.js";
import { a as toInternalMessageSentContext, d as toPluginMessageSentEvent, l as toPluginMessageContext, t as buildCanonicalSentMessageHookContext } from "./message-hook-mappers-CNfn6PTM.js";
import { l as normalizeMessagePresentation } from "./payload-BDV15CYA.js";
import { n as probeVideoDimensions } from "./media-services-CLFjOJQs.js";
import { a as projectOutboundPayloadPlanForDelivery, t as createOutboundPayloadPlan } from "./payloads-BOM5t2O4.js";
import { u as saveMediaBuffer } from "./store-rQFzzX5P.js";
import { n as retryAsync } from "./retry-CryZAmlE.js";
import { a as saveRemoteMedia, n as MediaFetchError } from "./fetch-C0wRQZuz.js";
import { t as loadWebMedia } from "./web-media-GlH39bZn.js";
import { i as chunkMarkdownTextWithMode } from "./chunk-IIklKK4Y.js";
import { t as buildOutboundMediaLoadOptions } from "./load-options-LnfEFXDj.js";
import { i as shouldRetryTelegramTransportFallback, t as resolveTelegramApiBase } from "./fetch-Dy1LisTE.js";
import "./runtime-env-BtvWnLRh.js";
import { o as isSafeToRetrySendError, u as isTelegramRateLimitError } from "./request-timeouts-CnvnuqEE.js";
import "./reply-chunking-D-imiKW4.js";
import "./web-media-Q6WLwwDo.js";
import "./outbound-runtime-CGgaScW3.js";
import "./file-access-runtime-DRy4-k6e.js";
import { n as createChannelApiRetryRunner } from "./retry-policy-C4ndkoIo.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-runtime-BheBFFxc.js";
import "./plugin-runtime-DG_BosJY.js";
import "./hook-runtime-aHFg3hJ2.js";
import "./retry-runtime-BLxc3H40.js";
import { B as resolveTelegramMediaPlaceholder, D as resolveTelegramReplyId, a as renderTelegramHtmlText, c as wrapFileReferencesInHtml, n as markdownToTelegramChunks, r as markdownToTelegramHtml } from "./format-B4PA8GD8.js";
import { t as resolveTelegramInlineButtons } from "./button-types-C0Gyj4Tz.js";
import { t as resolveTelegramInteractiveTextFallback } from "./interactive-fallback-hkNKT0cd.js";
import { a as getCachedSticker, n as cacheSticker } from "./sticker-cache-qT7KSXbD.js";
import { D as splitTelegramCaption, O as withTelegramApiErrorLogging, b as removeTelegramNativeQuoteParam, h as resolveTelegramVoiceSend, v as buildTelegramSendParams, x as buildInlineKeyboard, y as getTelegramNativeQuoteReplyMessageId } from "./send-HzJbRmiM.js";
import path from "node:path";
import { GrammyError, InputFile } from "grammy";
//#region extensions/telegram/src/bot/delivery.send.ts
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const EMPTY_TEXT_ERR_RE = /message text is empty/i;
const QUOTE_PARAM_RE = /\bquote not found\b|\bQUOTE_TEXT_INVALID\b|\bquote text invalid\b/i;
const GrammyErrorCtor$2 = typeof GrammyError === "function" ? GrammyError : void 0;
function isTelegramQuoteParamError(err) {
	if (GrammyErrorCtor$2 && err instanceof GrammyErrorCtor$2) return QUOTE_PARAM_RE.test(err.description);
	return QUOTE_PARAM_RE.test(formatErrorMessage(err));
}
function createTelegramDeliverySendRetry() {
	return createChannelApiRetryRunner({
		shouldRetry: (err) => isSafeToRetrySendError(err) || isTelegramRateLimitError(err),
		strictShouldRetry: true
	});
}
async function sendTelegramWithThreadFallback(params) {
	const hasNativeQuote = getTelegramNativeQuoteReplyMessageId(params.requestParams) != null;
	const shouldSuppressFirstErrorLog = (err) => hasNativeQuote && isTelegramQuoteParamError(err);
	const mergedShouldLog = params.shouldLog ? (err) => params.shouldLog(err) && !shouldSuppressFirstErrorLog(err) : (err) => !shouldSuppressFirstErrorLog(err);
	const requestWithRetry = createTelegramDeliverySendRetry();
	const runLoggedSend = (operation, requestParams, shouldLog) => withTelegramApiErrorLogging({
		operation,
		runtime: params.runtime,
		...shouldLog ? { shouldLog } : {},
		fn: () => requestWithRetry(() => params.send(requestParams), operation)
	});
	try {
		return await runLoggedSend(params.operation, params.requestParams, mergedShouldLog);
	} catch (err) {
		if (hasNativeQuote && isTelegramQuoteParamError(err)) {
			params.runtime.log?.(`telegram ${params.operation}: native quote rejected; retrying with legacy reply_to_message_id`);
			return await sendTelegramWithThreadFallback({
				...params,
				operation: `${params.operation} (legacy reply retry)`,
				requestParams: removeTelegramNativeQuoteParam(params.requestParams)
			});
		}
		throw err;
	}
}
async function sendTelegramText(bot, chatId, text, runtime, opts) {
	const baseParams = buildTelegramSendParams({
		replyToMessageId: opts?.replyToMessageId,
		replyQuoteMessageId: opts?.replyQuoteMessageId,
		replyQuoteText: opts?.replyQuoteText,
		replyQuotePosition: opts?.replyQuotePosition,
		replyQuoteEntities: opts?.replyQuoteEntities,
		thread: opts?.thread,
		silent: opts?.silent
	});
	const linkPreviewOptions = opts?.linkPreview ?? true ? void 0 : { is_disabled: true };
	const htmlText = (opts?.textMode ?? "markdown") === "html" ? text : markdownToTelegramHtml(text);
	const fallbackText = opts?.plainText ?? text;
	const hasFallbackText = fallbackText.trim().length > 0;
	const sendPlainFallback = async () => {
		const res = await sendTelegramWithThreadFallback({
			operation: "sendMessage",
			runtime,
			thread: opts?.thread,
			requestParams: baseParams,
			send: (effectiveParams) => bot.api.sendMessage(chatId, fallbackText, {
				...linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {},
				...opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {},
				...effectiveParams
			})
		});
		runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id} (plain)`);
		return res.message_id;
	};
	if (!htmlText.trim()) {
		if (!hasFallbackText) throw new Error("telegram sendMessage failed: empty formatted text and empty plain fallback");
		return await sendPlainFallback();
	}
	try {
		const res = await sendTelegramWithThreadFallback({
			operation: "sendMessage",
			runtime,
			thread: opts?.thread,
			requestParams: baseParams,
			shouldLog: (err) => {
				const errText = formatErrorMessage(err);
				return !PARSE_ERR_RE.test(errText) && !EMPTY_TEXT_ERR_RE.test(errText);
			},
			send: (effectiveParams) => bot.api.sendMessage(chatId, htmlText, {
				parse_mode: "HTML",
				...linkPreviewOptions ? { link_preview_options: linkPreviewOptions } : {},
				...opts?.replyMarkup ? { reply_markup: opts.replyMarkup } : {},
				...effectiveParams
			})
		});
		runtime.log?.(`telegram sendMessage ok chat=${chatId} message=${res.message_id}`);
		return res.message_id;
	} catch (err) {
		const errText = formatErrorMessage(err);
		if (PARSE_ERR_RE.test(errText) || EMPTY_TEXT_ERR_RE.test(errText)) {
			if (!hasFallbackText) throw err;
			runtime.log?.(`telegram formatted send failed; retrying without formatting: ${errText}`);
			return await sendPlainFallback();
		}
		throw err;
	}
}
//#endregion
//#region extensions/telegram/src/bot/reply-threading.ts
function resolveReplyToForSend(params) {
	return params.replyToId && (params.replyToMode === "all" || !params.progress.hasReplied) ? params.replyToId : void 0;
}
function markReplyApplied(progress, replyToId) {
	if (replyToId && !progress.hasReplied) progress.hasReplied = true;
}
function markDelivered$1(progress) {
	progress.hasDelivered = true;
}
async function sendChunkedTelegramReplyText(params) {
	const applyDelivered = params.markDelivered ?? markDelivered$1;
	for (let i = 0; i < params.chunks.length; i += 1) {
		const chunk = params.chunks[i];
		if (!chunk) continue;
		const isFirstChunk = i === 0;
		const replyToMessageId = resolveReplyToForSend({
			replyToId: params.replyToId,
			replyToMode: params.replyToMode,
			progress: params.progress
		});
		const shouldAttachQuote = Boolean(replyToMessageId) && Boolean(params.replyQuoteText) && (params.quoteOnlyOnFirstChunk !== true || isFirstChunk);
		await params.sendChunk({
			chunk,
			isFirstChunk,
			replyToMessageId,
			replyMarkup: isFirstChunk ? params.replyMarkup : void 0,
			replyQuoteText: shouldAttachQuote ? params.replyQuoteText : void 0
		});
		markReplyApplied(params.progress, replyToMessageId);
		applyDelivered(params.progress);
	}
}
//#endregion
//#region extensions/telegram/src/bot/delivery.replies.ts
const VOICE_FORBIDDEN_MARKER = "VOICE_MESSAGES_FORBIDDEN";
const CAPTION_TOO_LONG_RE = /caption is too long/i;
const GrammyErrorCtor$1 = typeof GrammyError === "function" ? GrammyError : void 0;
const silentReplyLogger = createSubsystemLogger("telegram/silent-reply");
function buildChunkTextResolver(params) {
	return (markdown) => {
		const markdownChunks = params.chunkMode === "newline" ? chunkMarkdownTextWithMode(markdown, params.textLimit, params.chunkMode) : [markdown];
		const chunks = [];
		for (const chunk of markdownChunks) {
			const nested = markdownToTelegramChunks(chunk, params.textLimit, { tableMode: params.tableMode });
			if (!nested.length && chunk) {
				chunks.push({
					html: wrapFileReferencesInHtml(markdownToTelegramHtml(chunk, {
						tableMode: params.tableMode,
						wrapFileRefs: false
					})),
					text: chunk
				});
				continue;
			}
			chunks.push(...nested);
		}
		return chunks;
	};
}
function markDelivered(progress) {
	progress.hasDelivered = true;
	progress.deliveredCount += 1;
}
function filterEmptyTelegramTextChunks(chunks) {
	return chunks.filter((chunk) => chunk.text.trim().length > 0);
}
function resolveReplyQuoteForSend(params) {
	if (params.replyToId != null) {
		const mapped = params.replyQuoteByMessageId?.[String(params.replyToId)];
		if (mapped?.text) {
			const quote = {
				messageId: params.replyToId,
				text: mapped.text
			};
			if (typeof mapped.position === "number") quote.position = mapped.position;
			if (mapped.entities) quote.entities = mapped.entities;
			return quote;
		}
	}
	const quote = {};
	if (params.replyQuoteMessageId != null) quote.messageId = params.replyQuoteMessageId;
	if (params.replyQuoteText != null) quote.text = params.replyQuoteText;
	if (params.replyQuotePosition != null) quote.position = params.replyQuotePosition;
	if (params.replyQuoteEntities != null) quote.entities = params.replyQuoteEntities;
	return quote;
}
async function deliverTextReply(params) {
	let firstDeliveredMessageId;
	await sendChunkedTelegramReplyText({
		chunks: filterEmptyTelegramTextChunks(params.chunkText(params.replyText)),
		progress: params.progress,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		replyMarkup: params.replyMarkup,
		replyQuoteText: params.replyQuoteText,
		markDelivered,
		sendChunk: async ({ chunk, replyToMessageId, replyMarkup, replyQuoteText }) => {
			const messageId = await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
				replyToMessageId,
				replyQuoteMessageId: params.replyQuoteMessageId,
				replyQuoteText,
				replyQuotePosition: params.replyQuotePosition,
				replyQuoteEntities: params.replyQuoteEntities,
				thread: params.thread,
				textMode: "html",
				plainText: chunk.text,
				linkPreview: params.linkPreview,
				silent: params.silent,
				replyMarkup
			});
			if (firstDeliveredMessageId == null) firstDeliveredMessageId = messageId;
		}
	});
	return firstDeliveredMessageId;
}
async function sendPendingFollowUpText(params) {
	await sendChunkedTelegramReplyText({
		chunks: filterEmptyTelegramTextChunks(params.chunkText(params.text)),
		progress: params.progress,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		replyMarkup: params.replyMarkup,
		markDelivered,
		sendChunk: async ({ chunk, replyToMessageId, replyMarkup }) => {
			await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
				replyToMessageId,
				thread: params.thread,
				textMode: "html",
				plainText: chunk.text,
				linkPreview: params.linkPreview,
				silent: params.silent,
				replyMarkup
			});
		}
	});
}
function isVoiceMessagesForbidden(err) {
	if (GrammyErrorCtor$1 && err instanceof GrammyErrorCtor$1) return err.description.includes(VOICE_FORBIDDEN_MARKER);
	return formatErrorMessage(err).includes(VOICE_FORBIDDEN_MARKER);
}
function isCaptionTooLong(err) {
	if (GrammyErrorCtor$1 && err instanceof GrammyErrorCtor$1) return CAPTION_TOO_LONG_RE.test(err.description);
	return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
}
function resolveVoiceFallbackText(reply) {
	if (reply.text?.trim()) return reply.text;
	if (reply.spokenText?.trim()) return reply.spokenText;
}
async function sendTelegramVoiceFallbackText(opts) {
	let firstDeliveredMessageId;
	const chunks = filterEmptyTelegramTextChunks(opts.chunkText(opts.text));
	let appliedReplyTo = false;
	for (let i = 0; i < chunks.length; i += 1) {
		const chunk = chunks[i];
		const replyToForChunk = !appliedReplyTo ? opts.replyToId : void 0;
		const applyQuoteForChunk = !appliedReplyTo;
		const messageId = await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
			replyToMessageId: replyToForChunk,
			replyQuoteMessageId: applyQuoteForChunk ? opts.replyQuoteMessageId : void 0,
			replyQuoteText: applyQuoteForChunk ? opts.replyQuoteText : void 0,
			replyQuotePosition: applyQuoteForChunk ? opts.replyQuotePosition : void 0,
			replyQuoteEntities: applyQuoteForChunk ? opts.replyQuoteEntities : void 0,
			thread: opts.thread,
			textMode: "html",
			plainText: chunk.text,
			linkPreview: opts.linkPreview,
			silent: opts.silent,
			replyMarkup: !appliedReplyTo ? opts.replyMarkup : void 0
		});
		if (firstDeliveredMessageId == null) firstDeliveredMessageId = messageId;
		if (replyToForChunk) appliedReplyTo = true;
	}
	return firstDeliveredMessageId;
}
async function deliverMediaReply(params) {
	let firstDeliveredMessageId;
	let visibleFallbackText;
	let first = true;
	let pendingFollowUpText;
	for (const mediaUrl of params.mediaList) {
		const isFirstMedia = first;
		const media = await params.mediaLoader(mediaUrl, buildOutboundMediaLoadOptions({
			mediaLocalRoots: params.mediaLocalRoots,
			maxBytes: params.mediaMaxBytes
		}));
		const kind = kindFromMime(media.contentType ?? void 0);
		const isGif = isGifMedia({
			contentType: media.contentType,
			fileName: media.fileName
		});
		const fileName = media.fileName ?? (isGif ? "animation.gif" : "file");
		const file = new InputFile(media.buffer, fileName);
		const { caption, followUpText } = splitTelegramCaption(isFirstMedia ? params.reply.text ?? void 0 : void 0);
		const htmlCaption = caption ? renderTelegramHtmlText(caption, { tableMode: params.tableMode }) : void 0;
		if (followUpText) pendingFollowUpText = followUpText;
		first = false;
		const replyToMessageId = resolveReplyToForSend({
			replyToId: params.replyToId,
			replyToMode: params.replyToMode,
			progress: params.progress
		});
		const shouldAttachButtonsToMedia = isFirstMedia && params.replyMarkup && !followUpText;
		const videoDimensions = kind === "video" ? await probeVideoDimensions(media.buffer) : void 0;
		const mediaParams = {
			caption: htmlCaption,
			...htmlCaption ? { parse_mode: "HTML" } : {},
			...shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {},
			...videoDimensions ? {
				width: videoDimensions.width,
				height: videoDimensions.height
			} : {},
			...buildTelegramSendParams({
				replyToMessageId,
				replyQuoteMessageId: params.replyQuoteMessageId,
				replyQuoteText: params.replyQuoteText,
				replyQuotePosition: params.replyQuotePosition,
				replyQuoteEntities: params.replyQuoteEntities,
				thread: params.thread,
				silent: params.silent
			})
		};
		if (isGif) {
			const result = await sendTelegramWithThreadFallback({
				operation: "sendAnimation",
				runtime: params.runtime,
				thread: params.thread,
				requestParams: mediaParams,
				send: (effectiveParams) => params.bot.api.sendAnimation(params.chatId, file, { ...effectiveParams })
			});
			if (firstDeliveredMessageId == null) firstDeliveredMessageId = result.message_id;
			markDelivered(params.progress);
		} else if (kind === "image") {
			const result = await sendTelegramWithThreadFallback({
				operation: "sendPhoto",
				runtime: params.runtime,
				thread: params.thread,
				requestParams: mediaParams,
				send: (effectiveParams) => params.bot.api.sendPhoto(params.chatId, file, { ...effectiveParams })
			});
			if (firstDeliveredMessageId == null) firstDeliveredMessageId = result.message_id;
			markDelivered(params.progress);
		} else if (kind === "video") {
			const result = await sendTelegramWithThreadFallback({
				operation: "sendVideo",
				runtime: params.runtime,
				thread: params.thread,
				requestParams: mediaParams,
				send: (effectiveParams) => params.bot.api.sendVideo(params.chatId, file, { ...effectiveParams })
			});
			if (firstDeliveredMessageId == null) firstDeliveredMessageId = result.message_id;
			markDelivered(params.progress);
		} else if (kind === "audio") {
			const { useVoice } = resolveTelegramVoiceSend({
				wantsVoice: params.reply.audioAsVoice === true,
				contentType: media.contentType,
				fileName,
				logFallback: logVerbose
			});
			if (useVoice) {
				const sendVoiceMedia = async (requestParams, shouldLog) => {
					const result = await sendTelegramWithThreadFallback({
						operation: "sendVoice",
						runtime: params.runtime,
						thread: params.thread,
						requestParams,
						shouldLog,
						send: (effectiveParams) => params.bot.api.sendVoice(params.chatId, file, { ...effectiveParams })
					});
					if (firstDeliveredMessageId == null) firstDeliveredMessageId = result.message_id;
					markDelivered(params.progress);
				};
				await params.onVoiceRecording?.();
				try {
					await sendVoiceMedia(mediaParams, (err) => !isVoiceMessagesForbidden(err));
				} catch (voiceErr) {
					if (isVoiceMessagesForbidden(voiceErr)) {
						const fallbackText = resolveVoiceFallbackText(params.reply);
						if (!fallbackText || !fallbackText.trim()) throw voiceErr;
						logVerbose("telegram sendVoice forbidden (recipient has voice messages blocked in privacy settings); falling back to text");
						const voiceFallbackReplyTo = resolveReplyToForSend({
							replyToId: params.replyToId,
							replyToMode: params.replyToMode,
							progress: params.progress
						});
						const fallbackMessageId = await sendTelegramVoiceFallbackText({
							bot: params.bot,
							chatId: params.chatId,
							runtime: params.runtime,
							text: fallbackText,
							chunkText: params.chunkText,
							replyToId: voiceFallbackReplyTo,
							replyQuoteMessageId: params.replyQuoteMessageId,
							replyQuotePosition: params.replyQuotePosition,
							replyQuoteEntities: params.replyQuoteEntities,
							thread: params.thread,
							linkPreview: params.linkPreview,
							silent: params.silent,
							replyMarkup: params.replyMarkup,
							replyQuoteText: params.replyQuoteText
						});
						if (firstDeliveredMessageId == null) firstDeliveredMessageId = fallbackMessageId;
						visibleFallbackText = fallbackText;
						markReplyApplied(params.progress, voiceFallbackReplyTo);
						markDelivered(params.progress);
						continue;
					}
					if (isCaptionTooLong(voiceErr)) {
						logVerbose("telegram sendVoice caption too long; resending voice without caption + text separately");
						const noCaptionParams = { ...mediaParams };
						delete noCaptionParams.caption;
						delete noCaptionParams.parse_mode;
						await sendVoiceMedia(noCaptionParams);
						const fallbackText = resolveVoiceFallbackText(params.reply);
						if (fallbackText?.trim()) {
							await sendTelegramVoiceFallbackText({
								bot: params.bot,
								chatId: params.chatId,
								runtime: params.runtime,
								text: fallbackText,
								chunkText: params.chunkText,
								replyToId: void 0,
								thread: params.thread,
								linkPreview: params.linkPreview,
								silent: params.silent,
								replyMarkup: params.replyMarkup
							});
							visibleFallbackText = fallbackText;
						}
						markReplyApplied(params.progress, replyToMessageId);
						continue;
					}
					throw voiceErr;
				}
			} else {
				const result = await sendTelegramWithThreadFallback({
					operation: "sendAudio",
					runtime: params.runtime,
					thread: params.thread,
					requestParams: mediaParams,
					send: (effectiveParams) => params.bot.api.sendAudio(params.chatId, file, { ...effectiveParams })
				});
				if (firstDeliveredMessageId == null) firstDeliveredMessageId = result.message_id;
				markDelivered(params.progress);
			}
		} else {
			const result = await sendTelegramWithThreadFallback({
				operation: "sendDocument",
				runtime: params.runtime,
				thread: params.thread,
				requestParams: mediaParams,
				send: (effectiveParams) => params.bot.api.sendDocument(params.chatId, file, { ...effectiveParams })
			});
			if (firstDeliveredMessageId == null) firstDeliveredMessageId = result.message_id;
			markDelivered(params.progress);
		}
		markReplyApplied(params.progress, replyToMessageId);
		if (pendingFollowUpText && isFirstMedia) {
			await sendPendingFollowUpText({
				bot: params.bot,
				chatId: params.chatId,
				runtime: params.runtime,
				thread: params.thread,
				chunkText: params.chunkText,
				text: pendingFollowUpText,
				replyMarkup: params.replyMarkup,
				linkPreview: params.linkPreview,
				silent: params.silent,
				replyToId: params.replyToId,
				replyToMode: params.replyToMode,
				progress: params.progress
			});
			pendingFollowUpText = void 0;
		}
	}
	return {
		firstDeliveredMessageId,
		visibleFallbackText
	};
}
async function maybePinFirstDeliveredMessage(params) {
	if (!(params.pin === true || typeof params.pin === "object" && params.pin.enabled) || typeof params.firstDeliveredMessageId !== "number") return;
	const notify = typeof params.pin === "object" && params.pin.notify === true;
	try {
		await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, { disable_notification: !notify });
	} catch (err) {
		logVerbose(`telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(err)}`);
	}
}
function buildTelegramSentHookContext(params) {
	return buildCanonicalSentMessageHookContext({
		to: params.chatId,
		content: params.content,
		success: params.success,
		error: params.error,
		channelId: "telegram",
		accountId: params.accountId,
		conversationId: params.chatId,
		messageId: typeof params.messageId === "number" ? String(params.messageId) : void 0,
		isGroup: params.isGroup,
		groupId: params.groupId
	});
}
function emitInternalMessageSentHook(params) {
	if (!params.sessionKeyForInternalHooks) return;
	const canonical = buildTelegramSentHookContext(params);
	fireAndForgetHook(triggerInternalHook(createInternalHookEvent("message", "sent", params.sessionKeyForInternalHooks, toInternalMessageSentContext(canonical))), "telegram: message:sent internal hook failed");
}
function emitMessageSentHooks(params) {
	if (!params.enabled && !params.sessionKeyForInternalHooks) return;
	const canonical = buildTelegramSentHookContext(params);
	if (params.enabled) fireAndForgetHook(Promise.resolve(params.hookRunner.runMessageSent(toPluginMessageSentEvent(canonical), toPluginMessageContext(canonical))), "telegram: message_sent plugin hook failed");
	emitInternalMessageSentHook(params);
}
function emitTelegramMessageSentHooks(params) {
	const hookRunner = getGlobalHookRunner();
	emitMessageSentHooks({
		...params,
		hookRunner,
		enabled: hookRunner?.hasHooks("message_sent") ?? false
	});
}
async function deliverReplies(params) {
	const progress = {
		hasReplied: false,
		hasDelivered: false,
		deliveredCount: 0
	};
	const mediaLoader = params.mediaLoader ?? loadWebMedia;
	const transcriptMirror = params.transcriptMirror;
	const deliveredContents = [];
	const hookRunner = getGlobalHookRunner();
	const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
	const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
	const chunkText = buildChunkTextResolver({
		textLimit: params.textLimit,
		chunkMode: params.chunkMode ?? "length",
		tableMode: params.tableMode
	});
	const candidateReplies = [];
	for (const reply of params.replies) {
		if (!reply || typeof reply !== "object") {
			params.runtime.error?.(danger("reply missing text/media"));
			continue;
		}
		candidateReplies.push(reply);
	}
	const normalizedReplies = projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan(candidateReplies, {
		cfg: params.cfg,
		sessionKey: params.policySessionKey ?? params.sessionKeyForInternalHooks,
		surface: "telegram"
	}));
	const originalExactSilentCount = candidateReplies.filter((reply) => typeof reply.text === "string" && reply.text.trim().toUpperCase() === "NO_REPLY").length;
	if (originalExactSilentCount > 0) silentReplyLogger.debug("telegram delivery normalized NO_REPLY candidates", {
		hasSessionKey: Boolean(params.sessionKeyForInternalHooks),
		hasChatId: params.chatId.length > 0,
		originalCount: candidateReplies.length,
		normalizedCount: normalizedReplies.length,
		originalExactSilentCount
	});
	for (const originalReply of normalizedReplies) {
		let reply = originalReply;
		const mediaList = reply?.mediaUrls?.length ? reply.mediaUrls : reply?.mediaUrl ? [reply.mediaUrl] : [];
		const hasMedia = mediaList.length > 0;
		const presentation = normalizeMessagePresentation(reply?.presentation);
		const interactive = reply?.interactive;
		const resolvedReplyText = resolveTelegramInteractiveTextFallback({
			text: reply?.text,
			interactive,
			presentation
		}) ?? reply?.text ?? "";
		if (reply && resolvedReplyText !== (reply.text ?? "")) reply = {
			...reply,
			text: resolvedReplyText
		};
		if (!resolvedReplyText && !hasMedia) {
			if (reply?.audioAsVoice) {
				logVerbose("telegram reply has audioAsVoice without media/text; skipping");
				continue;
			}
			params.runtime.error?.(danger("reply missing text/media"));
			continue;
		}
		const rawContent = resolvedReplyText;
		const spokenHookContent = !rawContent && reply.audioAsVoice === true && reply.spokenText?.trim() ? reply.spokenText : void 0;
		const hookContent = spokenHookContent ?? rawContent;
		const replyToId = params.replyToMode === "off" ? void 0 : resolveTelegramReplyId(reply.replyToId);
		const replyQuote = resolveReplyQuoteForSend({
			replyToId,
			replyQuoteByMessageId: params.replyQuoteByMessageId,
			replyQuoteMessageId: params.replyQuoteMessageId,
			replyQuoteText: params.replyQuoteText,
			replyQuotePosition: params.replyQuotePosition,
			replyQuoteEntities: params.replyQuoteEntities
		});
		if (hasMessageSendingHooks) {
			const hookResult = await hookRunner?.runMessageSending({
				to: params.chatId,
				content: hookContent,
				replyToId,
				threadId: params.thread?.id,
				metadata: {
					channel: "telegram",
					mediaUrls: mediaList,
					threadId: params.thread?.id
				}
			}, {
				channelId: "telegram",
				accountId: params.accountId,
				conversationId: params.chatId
			});
			if (hookResult?.cancel) continue;
			if (typeof hookResult?.content === "string" && hookResult.content !== hookContent) reply = spokenHookContent ? {
				...reply,
				spokenText: hookResult.content
			} : {
				...reply,
				text: hookResult.content
			};
		}
		let contentForSentHook = reply.text || (reply.audioAsVoice === true ? resolveVoiceFallbackText(reply) : "") || "";
		try {
			const deliveredCountBeforeReply = progress.deliveredCount;
			const telegramData = reply.channelData?.telegram;
			const replyMarkup = buildInlineKeyboard(resolveTelegramInlineButtons({
				buttons: telegramData?.buttons,
				presentation,
				interactive
			}));
			let firstDeliveredMessageId;
			if (mediaList.length === 0) firstDeliveredMessageId = await deliverTextReply({
				bot: params.bot,
				chatId: params.chatId,
				runtime: params.runtime,
				thread: params.thread,
				chunkText,
				replyText: reply.text || "",
				replyMarkup,
				replyQuoteMessageId: replyQuote.messageId,
				replyQuoteText: replyQuote.text,
				replyQuotePosition: replyQuote.position,
				replyQuoteEntities: replyQuote.entities,
				linkPreview: params.linkPreview,
				silent: params.silent,
				replyToId,
				replyToMode: params.replyToMode,
				progress
			});
			else {
				const mediaDelivery = await deliverMediaReply({
					reply,
					mediaList,
					bot: params.bot,
					chatId: params.chatId,
					runtime: params.runtime,
					thread: params.thread,
					tableMode: params.tableMode,
					mediaLocalRoots: params.mediaLocalRoots,
					mediaMaxBytes: params.mediaMaxBytes,
					chunkText,
					mediaLoader,
					onVoiceRecording: params.onVoiceRecording,
					linkPreview: params.linkPreview,
					silent: params.silent,
					replyQuoteMessageId: replyQuote.messageId,
					replyQuoteText: replyQuote.text,
					replyQuotePosition: replyQuote.position,
					replyQuoteEntities: replyQuote.entities,
					replyMarkup,
					replyToId,
					replyToMode: params.replyToMode,
					progress
				});
				firstDeliveredMessageId = mediaDelivery.firstDeliveredMessageId;
				if (mediaDelivery.visibleFallbackText) contentForSentHook = mediaDelivery.visibleFallbackText;
			}
			await maybePinFirstDeliveredMessage({
				pin: reply.delivery?.pin,
				bot: params.bot,
				chatId: params.chatId,
				runtime: params.runtime,
				firstDeliveredMessageId
			});
			if (progress.deliveredCount > deliveredCountBeforeReply && transcriptMirror) deliveredContents.push({
				text: contentForSentHook,
				mediaUrls: mediaList
			});
			emitMessageSentHooks({
				hookRunner,
				enabled: hasMessageSentHooks,
				sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
				chatId: params.chatId,
				accountId: params.accountId,
				content: contentForSentHook,
				success: progress.deliveredCount > deliveredCountBeforeReply,
				messageId: firstDeliveredMessageId,
				isGroup: params.mirrorIsGroup,
				groupId: params.mirrorGroupId
			});
		} catch (error) {
			emitMessageSentHooks({
				hookRunner,
				enabled: hasMessageSentHooks,
				sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
				chatId: params.chatId,
				accountId: params.accountId,
				content: contentForSentHook,
				success: false,
				error: formatErrorMessage(error),
				isGroup: params.mirrorIsGroup,
				groupId: params.mirrorGroupId
			});
			throw error;
		}
	}
	if (progress.hasDelivered && transcriptMirror) {
		const text = deliveredContents.map((content) => content.text).filter(Boolean).join("\n\n");
		const mediaUrls = deliveredContents.flatMap((content) => content.mediaUrls);
		if (text || mediaUrls.length > 0) try {
			await transcriptMirror({
				text: text || void 0,
				mediaUrls: mediaUrls.length > 0 ? mediaUrls : void 0
			});
		} catch (mirrorErr) {
			logVerbose(`telegram transcriptMirror failed: ${formatErrorMessage(mirrorErr)}`);
		}
	}
	return { delivered: progress.hasDelivered };
}
//#endregion
//#region extensions/telegram/src/bot/delivery.resolve-media.ts
const FILE_TOO_BIG_RE = /file is too big/i;
const GrammyErrorCtor = typeof GrammyError === "function" ? GrammyError : void 0;
function buildTelegramMediaSsrfPolicy(apiRoot, dangerouslyAllowPrivateNetwork) {
	const hostnames = ["api.telegram.org"];
	let allowedHostnames;
	if (apiRoot) try {
		const customHost = new URL(apiRoot).hostname;
		if (customHost && !hostnames.includes(customHost)) {
			hostnames.push(customHost);
			allowedHostnames = [customHost];
		}
	} catch (err) {
		logVerbose(`telegram: invalid apiRoot URL "${apiRoot}": ${String(err)}`);
	}
	return {
		hostnameAllowlist: hostnames,
		...allowedHostnames ? { allowedHostnames } : {},
		...dangerouslyAllowPrivateNetwork ? { allowPrivateNetwork: true } : {},
		allowRfc2544BenchmarkRange: true
	};
}
/**
* Returns true if the error is Telegram's "file is too big" error.
* This happens when trying to download files >20MB via the Bot API.
* Unlike network errors, this is a permanent error and should not be retried.
*/
function isFileTooBigError(err) {
	if (GrammyErrorCtor && err instanceof GrammyErrorCtor) return FILE_TOO_BIG_RE.test(err.description);
	return FILE_TOO_BIG_RE.test(formatErrorMessage(err));
}
/**
* Returns true if the error is a transient network error that should be retried.
* Returns false for permanent errors like "file is too big" (400 Bad Request).
*/
function isRetryableGetFileError(err) {
	if (isFileTooBigError(err)) return false;
	return true;
}
function resolveMediaMetadata(msg) {
	return {
		fileRef: msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice,
		fileName: msg.document?.file_name ?? msg.audio?.file_name ?? msg.video?.file_name ?? msg.animation?.file_name,
		mimeType: msg.audio?.mime_type ?? msg.voice?.mime_type ?? msg.video?.mime_type ?? msg.document?.mime_type ?? msg.animation?.mime_type
	};
}
async function resolveTelegramFileWithRetry(ctx) {
	try {
		return await retryAsync(() => ctx.getFile(), {
			attempts: 3,
			minDelayMs: 1e3,
			maxDelayMs: 4e3,
			jitter: .2,
			label: "telegram:getFile",
			shouldRetry: isRetryableGetFileError,
			onRetry: ({ attempt, maxAttempts }) => logVerbose(`telegram: getFile retry ${attempt}/${maxAttempts}`)
		});
	} catch (err) {
		if (isFileTooBigError(err)) {
			logVerbose(warn("telegram: getFile failed - file exceeds Telegram Bot API 20MB limit; skipping attachment"));
			return null;
		}
		logVerbose(`telegram: getFile failed after retries: ${String(err)}`);
		return null;
	}
}
function resolveRequiredTelegramTransport(transport) {
	if (transport) return transport;
	const resolvedFetch = globalThis.fetch;
	if (!resolvedFetch) throw new Error("fetch is not available; set channels.telegram.proxy in config");
	return {
		fetch: resolvedFetch,
		sourceFetch: resolvedFetch,
		close: async () => {}
	};
}
/** Default idle timeout for Telegram media downloads (30 seconds). */
const TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 3e4;
function usesTrustedTelegramExplicitProxy(transport) {
	return transport.dispatcherAttempts?.some((attempt) => attempt.dispatcherPolicy?.mode === "explicit-proxy") ?? false;
}
function resolveTrustedLocalTelegramRoot(filePath, trustedLocalFileRoots) {
	if (!path.isAbsolute(filePath)) return null;
	for (const rootDir of trustedLocalFileRoots ?? []) {
		const relativePath = path.relative(rootDir, filePath);
		if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) continue;
		return {
			rootDir,
			relativePath
		};
	}
	return null;
}
async function downloadAndSaveTelegramFile(params) {
	const trustedLocalFile = resolveTrustedLocalTelegramRoot(params.filePath, params.trustedLocalFileRoots);
	if (trustedLocalFile) {
		let localFile;
		try {
			localFile = await (await root(trustedLocalFile.rootDir)).read(trustedLocalFile.relativePath, { maxBytes: params.maxBytes });
		} catch (err) {
			throw new MediaFetchError("fetch_failed", `Failed to read local Telegram Bot API media from ${params.filePath}: ${formatErrorMessage(err)}`, { cause: err });
		}
		return await saveMediaBuffer(localFile.buffer, params.mimeType, "inbound", params.maxBytes, params.telegramFileName ?? path.basename(localFile.realPath));
	}
	if (path.isAbsolute(params.filePath)) throw new MediaFetchError("fetch_failed", `Telegram Bot API returned absolute file path ${params.filePath} outside trustedLocalFileRoots`);
	const transport = resolveRequiredTelegramTransport(params.transport);
	return await saveRemoteMedia({
		url: `${resolveTelegramApiBase(params.apiRoot)}/file/bot${params.token}/${params.filePath}`,
		fetchImpl: transport.sourceFetch,
		dispatcherAttempts: transport.dispatcherAttempts,
		trustExplicitProxyDns: usesTrustedTelegramExplicitProxy(transport),
		shouldRetryFetchError: shouldRetryTelegramTransportFallback,
		retry: {
			attempts: 3,
			minDelayMs: 1e3,
			maxDelayMs: 4e3,
			jitter: .2,
			label: "telegram:media-download",
			onRetry: ({ attempt, maxAttempts }) => logVerbose(`telegram: media download retry ${attempt}/${maxAttempts}`)
		},
		filePathHint: params.filePath,
		maxBytes: params.maxBytes,
		readIdleTimeoutMs: TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS,
		ssrfPolicy: buildTelegramMediaSsrfPolicy(params.apiRoot, params.dangerouslyAllowPrivateNetwork),
		fallbackContentType: params.mimeType,
		originalFilename: params.telegramFileName
	});
}
async function resolveStickerMedia(params) {
	const { msg, ctx, maxBytes, token, transport } = params;
	if (!msg.sticker) return;
	const sticker = msg.sticker;
	if (sticker.is_animated || sticker.is_video) {
		logVerbose("telegram: skipping animated/video sticker (only static stickers supported)");
		return null;
	}
	if (!sticker.file_id) return null;
	try {
		const file = await resolveTelegramFileWithRetry(ctx);
		if (!file?.file_path) {
			logVerbose("telegram: getFile returned no file_path for sticker");
			return null;
		}
		const saved = await downloadAndSaveTelegramFile({
			filePath: file.file_path,
			token,
			transport,
			maxBytes,
			apiRoot: params.apiRoot,
			trustedLocalFileRoots: params.trustedLocalFileRoots,
			dangerouslyAllowPrivateNetwork: params.dangerouslyAllowPrivateNetwork
		});
		const cached = sticker.file_unique_id ? getCachedSticker(sticker.file_unique_id) : null;
		if (cached) {
			logVerbose(`telegram: sticker cache hit for ${sticker.file_unique_id}`);
			const fileId = sticker.file_id ?? cached.fileId;
			const emoji = sticker.emoji ?? cached.emoji;
			const setName = sticker.set_name ?? cached.setName;
			if (fileId !== cached.fileId || emoji !== cached.emoji || setName !== cached.setName) cacheSticker({
				...cached,
				fileId,
				emoji,
				setName
			});
			return {
				path: saved.path,
				contentType: saved.contentType,
				placeholder: "<media:sticker>",
				stickerMetadata: {
					emoji,
					setName,
					fileId,
					fileUniqueId: sticker.file_unique_id,
					cachedDescription: cached.description
				}
			};
		}
		return {
			path: saved.path,
			contentType: saved.contentType,
			placeholder: "<media:sticker>",
			stickerMetadata: {
				emoji: sticker.emoji ?? void 0,
				setName: sticker.set_name ?? void 0,
				fileId: sticker.file_id,
				fileUniqueId: sticker.file_unique_id
			}
		};
	} catch (err) {
		logVerbose(`telegram: failed to process sticker: ${String(err)}`);
		return null;
	}
}
async function resolveMedia(params) {
	const { ctx, maxBytes, token, transport, apiRoot, trustedLocalFileRoots, dangerouslyAllowPrivateNetwork } = params;
	const msg = ctx.message;
	const stickerResolved = await resolveStickerMedia({
		msg,
		ctx,
		maxBytes,
		token,
		transport,
		apiRoot,
		trustedLocalFileRoots,
		dangerouslyAllowPrivateNetwork
	});
	if (stickerResolved !== void 0) return stickerResolved;
	const metadata = resolveMediaMetadata(msg);
	if (!metadata.fileRef?.file_id) return null;
	const file = await resolveTelegramFileWithRetry(ctx);
	if (!file) return null;
	if (!file.file_path) throw new Error("Telegram getFile returned no file_path");
	const saved = await downloadAndSaveTelegramFile({
		filePath: file.file_path,
		token,
		transport,
		maxBytes,
		telegramFileName: metadata.fileName,
		mimeType: metadata.mimeType,
		apiRoot,
		trustedLocalFileRoots,
		dangerouslyAllowPrivateNetwork
	});
	const placeholder = resolveTelegramMediaPlaceholder(msg) ?? "<media:document>";
	return {
		path: saved.path,
		contentType: saved.contentType,
		placeholder
	};
}
//#endregion
export { emitTelegramMessageSentHooks as i, deliverReplies as n, emitInternalMessageSentHook as r, resolveMedia as t };
