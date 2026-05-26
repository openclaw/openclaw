import { c as normalizeOptionalString, f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { r as logVerbose } from "./globals-CouSpJO4.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import { u as resolveStorePath } from "./paths-kGAxo7MN.js";
import { t as loadSessionStore } from "./store-load-cmAGD4uk.js";
import { a as enqueueSystemEvent } from "./system-events-D_-_Inav.js";
import { t as loadWebMedia } from "./web-media-CqsT0huS.js";
import "./error-runtime-BnVeBNYa.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { n as isSafeToRetrySendError, r as isTelegramClientRejection } from "./network-errors-eWehYGa6.js";
import { t as createChannelReplyPipeline } from "./reply-pipeline-B0RIiqGl.js";
import { a as readChannelAllowFromStore, d as upsertChannelPairingRequest } from "./pairing-store-DKcswb9w.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-runtime-C33N9zkP.js";
import { t as dispatchReplyWithBufferedBlockDispatcher } from "./reply-dispatch-runtime-s-cxPvmJ.js";
import "./web-media-ILLOBuyi.js";
import "./system-event-runtime-L5JTiCmm.js";
import "./runtime-config-snapshot-pRc6W_Li.js";
import "./conversation-runtime-BzsYFdpF.js";
import { t as listSkillCommandsForAgents } from "./skill-commands-D7lNGMWZ.js";
import { t as buildModelsProviderData } from "./commands-models-DXsv2Mp0.js";
import { a as createFinalizableDraftStreamControlsForState, o as takeMessageIdAfterStop } from "./channel-lifecycle-BrKB268B.js";
import { a as deliverInboundReplyWithMessageSendContext } from "./channel-message-CmG6T1ry.js";
import "./session-store-runtime-DIobQazh.js";
import "./models-provider-runtime-CjOslYG5.js";
import "./skill-commands-runtime-D2skI6LH.js";
import { G as normalizeTelegramReplyToMessageId, p as buildTelegramThreadParams } from "./format-CvqDHZhF.js";
import { r as normalizeTelegramCommandName, t as TELEGRAM_COMMAND_NAME_PATTERN } from "./command-config-C7_M9A31.js";
import { C as withTelegramApiErrorLogging, _ as wasSentByBot, a as editMessageTelegram } from "./send-CHZ5FlJJ.js";
import { n as deliverReplies, r as emitInternalMessageSentHook } from "./delivery-DX9I4VBH.js";
import { createHash } from "node:crypto";
//#region extensions/telegram/src/bot-native-command-menu.ts
const TELEGRAM_MAX_COMMANDS = 100;
const TELEGRAM_COMMAND_RETRY_RATIO = .8;
const TELEGRAM_MIN_COMMAND_DESCRIPTION_LENGTH = 1;
const TELEGRAM_MENU_RESULT_CACHE_MAX = 128;
const TELEGRAM_COMMAND_MENU_SCOPES = [{ label: "default" }, {
	label: "all_group_chats",
	options: { scope: { type: "all_group_chats" } }
}];
const cappedTelegramMenuCache = /* @__PURE__ */ new Map();
function countTelegramCommandText(value) {
	let count = 0;
	for (let index = 0; index < value.length;) {
		const codePoint = value.codePointAt(index);
		index += codePoint && codePoint > 65535 ? 2 : 1;
		count += 1;
	}
	return count;
}
function truncateTelegramCommandText(value, maxLength) {
	if (maxLength <= 0) return "";
	const suffix = maxLength > 1 ? "…" : "";
	const prefixLimit = maxLength - countTelegramCommandText(suffix);
	let count = 0;
	let prefixEnd = 0;
	for (const char of value) {
		count += 1;
		if (count <= prefixLimit) prefixEnd += char.length;
		if (count > maxLength) return `${value.slice(0, prefixEnd)}${suffix}`;
	}
	return value;
}
function fitTelegramCommandsWithinTextBudget(commands, maxTotalChars) {
	let candidateCommands = [...commands];
	while (candidateCommands.length > 0) {
		const descriptionBudget = maxTotalChars - candidateCommands.reduce((total, command) => total + countTelegramCommandText(command.command), 0);
		if (descriptionBudget < candidateCommands.length * TELEGRAM_MIN_COMMAND_DESCRIPTION_LENGTH) {
			candidateCommands = candidateCommands.slice(0, -1);
			continue;
		}
		const descriptionCap = Math.max(TELEGRAM_MIN_COMMAND_DESCRIPTION_LENGTH, Math.floor(descriptionBudget / candidateCommands.length));
		let descriptionTrimmed = false;
		const fittedCommands = candidateCommands.map((command) => {
			const description = truncateTelegramCommandText(command.description, descriptionCap);
			if (description !== command.description) {
				descriptionTrimmed = true;
				return Object.assign({}, command, { description });
			}
			return command;
		});
		return {
			commands: fittedCommands,
			descriptionTrimmed,
			textBudgetDropCount: commands.length - fittedCommands.length
		};
	}
	return {
		commands: [],
		descriptionTrimmed: false,
		textBudgetDropCount: commands.length
	};
}
function readErrorTextField(value, key) {
	if (!value || typeof value !== "object" || !(key in value)) return;
	return readStringValue(value[key]);
}
function isBotCommandsTooMuchError(err) {
	if (!err) return false;
	const pattern = /\bBOT_COMMANDS_TOO_MUCH\b/i;
	if (typeof err === "string") return pattern.test(err);
	if (err instanceof Error) {
		if (pattern.test(err.message)) return true;
	}
	const description = readErrorTextField(err, "description");
	if (description && pattern.test(description)) return true;
	const message = readErrorTextField(err, "message");
	if (message && pattern.test(message)) return true;
	return false;
}
function formatTelegramCommandRetrySuccessLog(params) {
	const omittedCount = Math.max(0, params.initialCount - params.acceptedCount);
	return `Telegram accepted ${params.acceptedCount} commands after BOT_COMMANDS_TOO_MUCH (started with ${params.initialCount}; omitted ${omittedCount}). Reduce plugin/skill/custom commands to expose more menu entries.`;
}
function buildPluginTelegramMenuCommands(params) {
	const { specs, existingCommands } = params;
	const commands = [];
	const issues = [];
	const pluginCommandNames = /* @__PURE__ */ new Set();
	for (const spec of specs) {
		const rawName = typeof spec.name === "string" ? spec.name : "";
		const normalized = normalizeTelegramCommandName(rawName);
		if (!normalized || !TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
			const invalidName = rawName.trim() ? rawName : "<unknown>";
			issues.push(`Plugin command "/${invalidName}" is invalid for Telegram (use a-z, 0-9, underscore; max 32 chars).`);
			continue;
		}
		const description = normalizeOptionalString(spec.description) ?? "";
		if (!description) {
			issues.push(`Plugin command "/${normalized}" is missing a description.`);
			continue;
		}
		if (existingCommands.has(normalized)) {
			if (pluginCommandNames.has(normalized)) issues.push(`Plugin command "/${normalized}" is duplicated.`);
			else issues.push(`Plugin command "/${normalized}" conflicts with an existing Telegram command.`);
			continue;
		}
		pluginCommandNames.add(normalized);
		existingCommands.add(normalized);
		commands.push({
			command: normalized,
			description
		});
	}
	return {
		commands,
		issues
	};
}
function buildCappedTelegramMenuCommands(params) {
	const maxCommands = params.maxCommands ?? TELEGRAM_MAX_COMMANDS;
	const maxTotalChars = params.maxTotalChars ?? 5700;
	const cacheKey = buildTelegramMenuResultCacheKey({
		allCommands: params.allCommands,
		maxCommands,
		maxTotalChars
	});
	const cached = cappedTelegramMenuCache.get(cacheKey);
	if (cached) return cached;
	const result = buildUncachedCappedTelegramMenuCommands({
		allCommands: params.allCommands,
		maxCommands,
		maxTotalChars
	});
	rememberCappedTelegramMenuResult(cacheKey, result);
	return result;
}
function buildUncachedCappedTelegramMenuCommands(params) {
	const { allCommands } = params;
	const { maxCommands, maxTotalChars } = params;
	const totalCommands = allCommands.length;
	const overflowCount = Math.max(0, totalCommands - maxCommands);
	const { commands: commandsToRegister, descriptionTrimmed, textBudgetDropCount } = fitTelegramCommandsWithinTextBudget(allCommands.slice(0, maxCommands), maxTotalChars);
	return {
		commandsToRegister,
		totalCommands,
		maxCommands,
		overflowCount,
		maxTotalChars,
		descriptionTrimmed,
		textBudgetDropCount
	};
}
function buildTelegramMenuResultCacheKey(params) {
	const digest = createHash("sha256");
	updateTelegramCommandDigestField(digest, String(params.maxCommands));
	updateTelegramCommandDigestField(digest, String(params.maxTotalChars));
	for (const command of params.allCommands) {
		updateTelegramCommandDigestField(digest, command.command);
		updateTelegramCommandDigestField(digest, command.description);
	}
	return digest.digest("hex").slice(0, 16);
}
function updateTelegramCommandDigestField(digest, value) {
	digest.update(String(value.length));
	digest.update(":");
	digest.update(value);
}
function rememberCappedTelegramMenuResult(key, result) {
	cappedTelegramMenuCache.set(key, result);
	if (cappedTelegramMenuCache.size <= TELEGRAM_MENU_RESULT_CACHE_MAX) return;
	const oldestKey = cappedTelegramMenuCache.keys().next().value;
	if (oldestKey) cappedTelegramMenuCache.delete(oldestKey);
}
function hashCommandList(commands) {
	const sorted = [...commands].toSorted((a, b) => a.command.localeCompare(b.command));
	return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}
const syncedCommandHashes = /* @__PURE__ */ new Map();
function getCommandHashKey(accountId, botIdentity) {
	return `${accountId ?? "default"}:${botIdentity ?? ""}`;
}
function readCachedCommandHash(accountId, botIdentity) {
	const key = getCommandHashKey(accountId, botIdentity);
	return syncedCommandHashes.get(key) ?? null;
}
function writeCachedCommandHash(accountId, botIdentity, hash) {
	const key = getCommandHashKey(accountId, botIdentity);
	syncedCommandHashes.set(key, hash);
}
function formatTelegramCommandScopeOperation(operation, scope) {
	return scope.label === "default" ? operation : `${operation}(${scope.label})`;
}
async function deleteTelegramMenuCommandsForScopes(params) {
	const { bot, runtime } = params;
	if (typeof bot.api.deleteMyCommands !== "function") return true;
	let allDeleted = true;
	for (const scope of TELEGRAM_COMMAND_MENU_SCOPES) {
		const deleted = await withTelegramApiErrorLogging({
			operation: formatTelegramCommandScopeOperation("deleteMyCommands", scope),
			runtime,
			fn: () => scope.options ? bot.api.deleteMyCommands(scope.options) : bot.api.deleteMyCommands()
		}).then(() => true).catch(() => false);
		allDeleted &&= deleted;
	}
	return allDeleted;
}
async function setTelegramMenuCommandsForScopes(params) {
	const { bot, runtime, commands, shouldLog } = params;
	for (const scope of TELEGRAM_COMMAND_MENU_SCOPES) await withTelegramApiErrorLogging({
		operation: formatTelegramCommandScopeOperation("setMyCommands", scope),
		runtime,
		shouldLog,
		fn: () => scope.options ? bot.api.setMyCommands(commands, scope.options) : bot.api.setMyCommands(commands)
	});
}
function syncTelegramMenuCommands(params) {
	const { bot, runtime, commandsToRegister, accountId, botIdentity } = params;
	const sync = async () => {
		const currentHash = hashCommandList(commandsToRegister);
		if (readCachedCommandHash(accountId, botIdentity) === currentHash) {
			logVerbose("telegram: command menu unchanged; skipping sync");
			return;
		}
		const deleteSucceeded = await deleteTelegramMenuCommandsForScopes({
			bot,
			runtime
		});
		if (commandsToRegister.length === 0) {
			if (!deleteSucceeded) {
				runtime.log?.("telegram: deleteMyCommands failed; skipping empty-menu hash cache write");
				return;
			}
			if (typeof bot.api.deleteMyCommands !== "function") await setTelegramMenuCommandsForScopes({
				bot,
				runtime,
				commands: []
			});
			writeCachedCommandHash(accountId, botIdentity, currentHash);
			return;
		}
		let retryCommands = commandsToRegister;
		const initialCommandCount = commandsToRegister.length;
		while (retryCommands.length > 0) try {
			await setTelegramMenuCommandsForScopes({
				bot,
				runtime,
				commands: retryCommands,
				shouldLog: (err) => !isBotCommandsTooMuchError(err)
			});
			if (retryCommands.length < initialCommandCount) runtime.log?.(formatTelegramCommandRetrySuccessLog({
				initialCount: initialCommandCount,
				acceptedCount: retryCommands.length
			}));
			writeCachedCommandHash(accountId, botIdentity, currentHash);
			return;
		} catch (err) {
			if (!isBotCommandsTooMuchError(err)) throw err;
			const nextCount = Math.floor(retryCommands.length * TELEGRAM_COMMAND_RETRY_RATIO);
			const reducedCount = nextCount < retryCommands.length ? nextCount : retryCommands.length - 1;
			if (reducedCount <= 0) {
				runtime.error?.("Telegram rejected native command registration (BOT_COMMANDS_TOO_MUCH); leaving menu empty. Reduce commands or disable channels.telegram.commands.native.");
				return;
			}
			runtime.log?.(`Telegram rejected ${retryCommands.length} commands (BOT_COMMANDS_TOO_MUCH); retrying with ${reducedCount}.`);
			retryCommands = retryCommands.slice(0, reducedCount);
		}
	};
	sync().catch((err) => {
		runtime.error?.(`Telegram command sync failed: ${String(err)}`);
	});
}
//#endregion
//#region extensions/telegram/src/draft-stream.ts
const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1e3;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
function hasNumericMessageThreadId(params) {
	return typeof params === "object" && params !== null && typeof params.message_thread_id === "number";
}
function renderTelegramDraftPreview(text, renderText) {
	const trimmed = text.trimEnd();
	return renderText?.(trimmed) ?? { text: trimmed };
}
function findTelegramDraftChunkLength(text, maxChars, renderText) {
	let best = 0;
	let low = 1;
	let high = text.length;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const renderedText = renderTelegramDraftPreview(text.slice(0, mid), renderText).text.trimEnd();
		if (renderedText && renderedText.length <= maxChars) {
			best = mid;
			low = mid + 1;
		} else high = mid - 1;
	}
	return best;
}
function createTelegramDraftStream(params) {
	const maxChars = Math.min(params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS, TELEGRAM_STREAM_MAX_CHARS);
	const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const minInitialChars = params.minInitialChars;
	const chatId = params.chatId;
	const threadParams = buildTelegramThreadParams(params.thread);
	const allowThreadlessRetry = params.thread?.scope !== "dm";
	const replyToMessageId = normalizeTelegramReplyToMessageId(params.replyToMessageId);
	const replyParams = replyToMessageId != null ? {
		...threadParams,
		reply_to_message_id: replyToMessageId,
		allow_sending_without_reply: true
	} : threadParams;
	const streamState = {
		stopped: false,
		final: false
	};
	let messageSendAttempted = false;
	let streamMessageId;
	let streamVisibleSinceMs;
	let lastSentText = "";
	let lastDeliveredText = "";
	let lastSentParseMode;
	let previewRevision = 0;
	let generation = 0;
	let deliveredTextOffset = 0;
	let resetStreamToNewMessage;
	const sendRenderedMessageWithThreadFallback = async (sendArgs) => {
		const sendParams = sendArgs.renderedParseMode ? {
			...replyParams,
			parse_mode: sendArgs.renderedParseMode
		} : replyParams;
		const usedThreadParams = hasNumericMessageThreadId(sendParams);
		try {
			return {
				sent: await params.api.sendMessage(chatId, sendArgs.renderedText, sendParams),
				usedThreadParams
			};
		} catch (err) {
			if (!allowThreadlessRetry || !usedThreadParams || !THREAD_NOT_FOUND_RE.test(String(err))) throw err;
			const threadlessParams = { ...sendParams };
			delete threadlessParams.message_thread_id;
			params.warn?.(sendArgs.fallbackWarnMessage);
			return {
				sent: await params.api.sendMessage(chatId, sendArgs.renderedText, Object.keys(threadlessParams).length > 0 ? threadlessParams : void 0),
				usedThreadParams: false
			};
		}
	};
	const sendMessageTransportPreview = async ({ renderedText, renderedParseMode, sendGeneration }) => {
		if (typeof streamMessageId === "number") {
			streamVisibleSinceMs ??= Date.now();
			if (renderedParseMode) await params.api.editMessageText(chatId, streamMessageId, renderedText, { parse_mode: renderedParseMode });
			else await params.api.editMessageText(chatId, streamMessageId, renderedText);
			return true;
		}
		messageSendAttempted = true;
		let sent;
		try {
			({sent} = await sendRenderedMessageWithThreadFallback({
				renderedText,
				renderedParseMode,
				fallbackWarnMessage: "telegram stream preview send failed with message_thread_id, retrying without thread"
			}));
		} catch (err) {
			if (isSafeToRetrySendError(err) || isTelegramClientRejection(err)) messageSendAttempted = false;
			throw err;
		}
		const sentMessageId = sent?.message_id;
		if (typeof sentMessageId !== "number" || !Number.isFinite(sentMessageId)) {
			streamState.stopped = true;
			params.warn?.("telegram stream preview stopped (missing message id from sendMessage)");
			return false;
		}
		const normalizedMessageId = Math.trunc(sentMessageId);
		const visibleSinceMs = Date.now();
		if (sendGeneration !== generation) {
			params.onSupersededPreview?.({
				messageId: normalizedMessageId,
				textSnapshot: renderedText,
				parseMode: renderedParseMode,
				visibleSinceMs
			});
			return true;
		}
		streamMessageId = normalizedMessageId;
		streamVisibleSinceMs = visibleSinceMs;
		return true;
	};
	const sendOrEditStreamMessage = async (text) => {
		if (streamState.stopped && !streamState.final) return false;
		const trimmed = text.trimEnd();
		if (!trimmed) return false;
		const currentText = trimmed.slice(deliveredTextOffset).trimStart();
		if (!currentText) return false;
		const rendered = renderTelegramDraftPreview(currentText, params.renderText);
		const renderedText = rendered.text.trimEnd();
		const renderedParseMode = rendered.parseMode;
		if (!renderedText) return false;
		if (renderedText.length > maxChars) {
			if (lastDeliveredText.length > deliveredTextOffset) {
				const supersededMessageId = streamMessageId;
				const supersededTextSnapshot = lastSentText;
				const supersededParseMode = lastSentParseMode;
				const supersededVisibleSinceMs = streamVisibleSinceMs;
				deliveredTextOffset = lastDeliveredText.length;
				resetStreamToNewMessage({
					keepPending: true,
					resetOffset: false
				});
				if (typeof supersededMessageId === "number") params.onSupersededPreview?.({
					messageId: supersededMessageId,
					textSnapshot: supersededTextSnapshot,
					parseMode: supersededParseMode,
					visibleSinceMs: supersededVisibleSinceMs,
					retain: true
				});
				return await sendOrEditStreamMessage(trimmed);
			}
			const chunkLength = findTelegramDraftChunkLength(currentText, maxChars, params.renderText);
			if (chunkLength > 0) {
				if (!await sendOrEditStreamMessage(trimmed.slice(0, deliveredTextOffset) + currentText.slice(0, chunkLength))) return false;
				return await sendOrEditStreamMessage(trimmed);
			}
			streamState.stopped = true;
			params.warn?.(`telegram stream preview stopped (text length ${renderedText.length} > ${maxChars})`);
			return false;
		}
		if (renderedText === lastSentText && renderedParseMode === lastSentParseMode) return true;
		const sendGeneration = generation;
		if (typeof streamMessageId !== "number" && minInitialChars != null && !streamState.final) {
			if (renderedText.length < minInitialChars) return false;
		}
		lastSentText = renderedText;
		lastSentParseMode = renderedParseMode;
		try {
			const sent = await sendMessageTransportPreview({
				renderedText,
				renderedParseMode,
				sendGeneration
			});
			if (sent) {
				previewRevision += 1;
				lastDeliveredText = trimmed;
			}
			return sent;
		} catch (err) {
			streamState.stopped = true;
			params.warn?.(`telegram stream preview failed: ${formatErrorMessage(err)}`);
			return false;
		}
	};
	const { loop, update, stop, stopForClear } = createFinalizableDraftStreamControlsForState({
		throttleMs,
		state: streamState,
		sendOrEditStreamMessage
	});
	resetStreamToNewMessage = (options) => {
		streamState.stopped = false;
		streamState.final = false;
		generation += 1;
		messageSendAttempted = false;
		streamMessageId = void 0;
		streamVisibleSinceMs = void 0;
		lastSentText = "";
		lastSentParseMode = void 0;
		if (options?.resetOffset !== false) deliveredTextOffset = 0;
		if (!options?.keepPending) loop.resetPending();
		loop.resetThrottleWindow();
	};
	const clear = async () => {
		const messageId = await takeMessageIdAfterStop({
			stopForClear,
			readMessageId: () => streamMessageId,
			clearMessageId: () => {
				streamMessageId = void 0;
			}
		});
		if (typeof messageId === "number" && Number.isFinite(messageId)) {
			try {
				await params.api.deleteMessage(chatId, messageId);
				params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
			} catch (err) {
				params.warn?.(`telegram stream preview cleanup failed: ${formatErrorMessage(err)}`);
			}
			return;
		}
	};
	const discard = async () => {
		await stopForClear();
	};
	const forceNewMessage = () => {
		resetStreamToNewMessage();
	};
	const materialize = async () => {
		await stop();
		return streamMessageId;
	};
	params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
	return {
		update,
		flush: loop.flush,
		messageId: () => streamMessageId,
		visibleSinceMs: () => streamVisibleSinceMs,
		previewRevision: () => previewRevision,
		lastDeliveredText: () => lastDeliveredText,
		clear,
		stop,
		discard,
		materialize,
		forceNewMessage,
		sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number"
	};
}
//#endregion
//#region extensions/telegram/src/exec-approval-resolver.ts
async function resolveTelegramExecApproval(params) {
	await resolveApprovalOverGateway({
		cfg: params.cfg,
		approvalId: params.approvalId,
		decision: params.decision,
		senderId: params.senderId,
		gatewayUrl: params.gatewayUrl,
		allowPluginFallback: params.allowPluginFallback,
		clientDisplayName: `Telegram approval (${params.senderId?.trim() || "unknown"})`
	});
}
//#endregion
//#region extensions/telegram/src/bot-deps.ts
const defaultTelegramBotDeps = {
	get getRuntimeConfig() {
		return getRuntimeConfig;
	},
	get resolveStorePath() {
		return resolveStorePath;
	},
	get readChannelAllowFromStore() {
		return readChannelAllowFromStore;
	},
	get loadSessionStore() {
		return loadSessionStore;
	},
	get upsertChannelPairingRequest() {
		return upsertChannelPairingRequest;
	},
	get enqueueSystemEvent() {
		return enqueueSystemEvent;
	},
	get dispatchReplyWithBufferedBlockDispatcher() {
		return dispatchReplyWithBufferedBlockDispatcher;
	},
	get loadWebMedia() {
		return loadWebMedia;
	},
	get buildModelsProviderData() {
		return buildModelsProviderData;
	},
	get listSkillCommandsForAgents() {
		return listSkillCommandsForAgents;
	},
	get syncTelegramMenuCommands() {
		return syncTelegramMenuCommands;
	},
	get wasSentByBot() {
		return wasSentByBot;
	},
	get resolveExecApproval() {
		return resolveTelegramExecApproval;
	},
	get createTelegramDraftStream() {
		return createTelegramDraftStream;
	},
	get deliverReplies() {
		return deliverReplies;
	},
	get deliverInboundReplyWithMessageSendContext() {
		return deliverInboundReplyWithMessageSendContext;
	},
	get emitInternalMessageSentHook() {
		return emitInternalMessageSentHook;
	},
	get editMessageTelegram() {
		return editMessageTelegram;
	},
	get createChannelMessageReplyPipeline() {
		return createChannelReplyPipeline;
	}
};
//#endregion
export { buildPluginTelegramMenuCommands as a, buildCappedTelegramMenuCommands as i, resolveTelegramExecApproval as n, syncTelegramMenuCommands as o, createTelegramDraftStream as r, defaultTelegramBotDeps as t };
