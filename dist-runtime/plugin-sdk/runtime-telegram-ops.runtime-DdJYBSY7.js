import { O as parseAgentSessionKey, d as resolveAgentIdFromSessionKey, f as resolveThreadSessionKeys, p as sanitizeAgentId, r as buildAgentMainSessionKey, s as init_session_key, v as normalizeAccountId$1 } from "./session-key-BwICpQs5.js";
import { A as parsePluginBindingApprovalCustomId, An as createInternalHookEvent, D as init_conversation_binding, Mn as triggerInternalHook, N as getSessionBindingService, O as isPluginOwnedSessionBindingRecord, Ot as evaluateMatchedGroupAccessForPolicy, P as init_session_binding_service, Pt as init_runtime_group_policy, Rt as resolveOpenProviderRuntimeGroupPolicy, _ as executePluginCommand, d as init_interactive, f as createDedupeCache, j as resolvePluginConversationBindingApproval, jn as init_internal_hooks, jt as init_group_access, p as init_dedupe, u as dispatchPluginInteractiveHandler, v as getPluginCommandSpecs, w as buildPluginBindingResolvedText, x as matchPluginCommand, y as init_commands } from "./runtime-CDMAx_h4.js";
import { $i as wrapFileReferencesInHtml, $o as listNativeCommandSpecsForConfig, $r as startDiagnosticHeartbeat, Aa as toLocationContext, Bu as resolveChunkMode, Ca as normalizeAllowFrom, D as resolveDefaultModelForAgent, Da as readChannelAllowFromStore, Df as writeConfigFile, Di as getCachedSticker, Dn as listSkillCommandsForAgents, Ea as firstDefined, En as buildCommandsPaginationKeyboard, Eo as issuePairingChallenge, Fi as pinMessageTelegram, Fn as resolveChannelConfigWrites, Fu as getAgentScopedMediaLocalRoots, Ga as resolveTelegramAccount, Gi as isRecoverableTelegramNetworkError, Hd as saveMediaBuffer, Hi as unpinMessageTelegram, Ht as shouldDebounceTextInbound, Io as createTypingCallbacks, Is as updateSessionStore, Iu as MediaFetchError, Ji as isTelegramPollingNetworkError, Jo as matchesMentionWithExplicit, Ki as isSafeToRetrySendError, Ko as recordPendingHistoryEntryIfEnabled, Li as renameForumTopicTelegram, Lo as logAckFailure, Lu as fetchRemoteMedia, Ml as buildOutboundMediaLoadOptions, Ms as readSessionUpdatedAt, Mu as loadWebMedia, Na as resolveTelegramInlineButtonsScope, Ni as editMessageReplyMarkupTelegram, Nn as isBtwRequestText, Nr as enqueueSystemEvent, Oa as upsertChannelPairingRequest, Os as formatReasoningMessage, Pi as editMessageTelegram, Ps as resolveSessionStoreEntry, Qi as renderTelegramHtmlText, Qo as listNativeCommandSpecs, Qr as logWebhookReceived, Ri as sendMessageTelegram, Ro as logInboundDrop, Ru as resolveMarkdownTableMode, Sa as isSenderAllowed, Sf as finalizeInboundContext, Sn as isAbortRequestText, Sp as readJsonBodyWithLimit, Ss as modelSupportsVision, St as collectTelegramUnmentionedGroupIds, Ta as resolveSenderAllowMatch, Ti as describeStickerImage, Tn as formatModelsAvailableHeader, Ts as registerUnhandledRejectionHandler, Ui as resolveTelegramVoiceSend, Uo as clearHistoryEntriesIfEnabled, Vi as sendTypingTelegram, Vo as buildPendingHistoryContextFromMap, Vu as resolveTextChunkLimit, Wi as wasSentByBot, Xi as markdownToTelegramChunks, Xo as findCommandByNativeName, Xr as logWebhookError, Yi as tagTelegramNetworkError, Yo as buildCommandTextFromArgs, Zi as markdownToTelegramHtml, Zr as logWebhookProcessed, Zt as resolvePinnedMainDmOwnerFromAllowlist, _a as resolveTelegramGroupAllowFromContext, _i as getModelsPageSize, _r as buildCanonicalSentMessageHookContext, aa as buildTelegramGroupPeerId, ai as isTelegramExecApprovalApprover, ba as resolveTelegramStreamMode, bf as findCodeRegions, br as toPluginMessageSentEvent, bs as findModelInCatalog, bt as createTelegramThreadBindingManager, ca as buildTypingThreadParams, ci as resolveTelegramExecApprovalTarget, cn as resolveControlCommandGate, cr as computeBackoff, cs as resolveNativeSkillsEnabled, da as extractTelegramLocation, di as buildExecApprovalPendingReplyPayload, dr as resolveSessionDeliveryTarget, ea as splitTelegramCaption, ei as stopDiagnosticHeartbeat, en as resolveMentionGatingWithBypass, es as normalizeCommandBody, fa as getTelegramTextParts, fd as resolveChannelGroupPolicy, ff as formatErrorMessage, fn as createInboundDebouncer, ga as resolveTelegramForumThreadId, gi as calculateTotalPages, gn as resolveEnvelopeFormatOptions, ha as resolveTelegramDirectPeerId, hi as buildProviderKeyboard, ia as buildTelegramGroupFrom, ic as resolveThreadBindingIdleTimeoutMsForChannel, ii as getTelegramExecApprovalApprovers, ir as buildCommandsMessagePaginated, ja as withTelegramApiErrorLogging, ji as deleteMessageTelegram, jr as formatDurationPrecise, js as loadSessionStore, ka as formatLocationText, kf as resolveAgentMaxConcurrent, ki as buildInlineKeyboard, la as describeReplyTarget, li as shouldEnableTelegramExecApprovalButtons, lr as sleepWithAbort, ma as normalizeForwardedContext, mi as buildModelsKeyboard, mn as formatInboundEnvelope, ms as resolveCommandAuthorization, na as buildSenderLabel, oa as buildTelegramParentPeer, oc as resolveThreadBindingMaxAgeMsForChannel, oi as isTelegramExecApprovalClientEnabled, on as recordInboundSession, os as isNativeCommandsExplicitlyDisabled, pa as hasBotMention, pd as resolveChannelGroupRequireMention, pf as formatUncaughtError, pn as resolveInboundDebounceMs, qa as resolveTelegramToken, qc as recordChannelActivity, qi as isTelegramClientRejection, qo as buildMentionRegexes, ra as buildSenderName, rr as applyModelOverrideToSessionEntry, rs as resolveCommandArgMenu, sa as buildTelegramThreadParams, sc as resolveThreadBindingSpawnPolicy, si as resolveTelegramExecApprovalConfig, sn as resolveCommandAuthorizedFromAuthorizers, ss as resolveNativeCommandsEnabled, su as resolveGlobalSingleton, ta as buildGroupLabel, tn as waitForAbortSignal, ts as parseCommandArgs, ua as expandTextLinks, ui as shouldSuppressLocalTelegramExecApprovalPrompt, un as dispatchReplyWithBufferedBlockDispatcher, us as getGlobalHookRunner, va as resolveTelegramMediaPlaceholder, vi as parseModelCallbackData, vr as toInternalMessageSentContext, vt as resolveStoredModelOverride, wa as normalizeDmAllowFromWithStore, wf as loadConfig, wi as cacheSticker, wn as buildModelsProviderData, xa as resolveTelegramThreadSpec, xf as isInsideCode, xn as hasControlCommand, xr as fireAndForgetHook, xs as loadModelCatalog, xt as auditTelegramGroupMembership, ya as resolveTelegramReplyId, yf as stripReasoningTagsFromText, yi as resolveModelSelection, yr as toPluginMessageContext, zi as sendPollTelegram, zo as logTypingFailure, zu as chunkMarkdownTextWithMode } from "./setup-wizard-helpers-BPw-E_P4.js";
import "./provider-env-vars-CWXfFyDU.js";
import { O as resolveStateDir, S as init_paths, t as getChildLogger } from "./logger-D1gzveLR.js";
import "./tmp-openclaw-dir-DgWJsVV_.js";
import { C as warn, c as defaultRuntime, g as init_globals, l as init_runtime, m as danger, n as init_subsystem, s as createNonExitingRuntime, t as createSubsystemLogger, v as logVerbose, x as shouldLogVerbose } from "./subsystem-0lZt3jI5.js";
import "./utils-DknlDzAi.js";
import { a as fetchWithTimeout, o as init_fetch_timeout } from "./fetch-CysqlwhH.js";
import { r as retryAsync, t as init_retry } from "./retry-CyJj_oar.js";
import { i as writeJsonAtomic, n as init_json_files } from "./json-files-DFquuRAh.js";
import "./paths-BDsrA18Z.js";
import { h as resolveTelegramCustomCommands, m as normalizeTelegramCommandName, p as TELEGRAM_COMMAND_NAME_PATTERN } from "./signal-FT4PyBH3.js";
import "./config-helpers-BQX8LEv1.js";
import { c as makeProxyFetch, n as resolveTelegramTransport, r as shouldRetryTelegramIpv4Fallback, t as resolveTelegramFetch } from "./fetch-CKhAJuFk.js";
import "./exec-DEBhRlDf.js";
import { i as resolveAgentDir, l as resolveDefaultAgentId } from "./agent-scope-CgozsAuQ.js";
import { i as resolveAckReaction, n as createReplyPrefixOptions } from "./reply-prefix-Dcd4HlHm.js";
import "./logger-CXkOEiRn.js";
import "./fetch-guard-DryYzke6.js";
import { a as resolveInboundLastRouteSessionKey, i as resolveAgentRoute, n as deriveLastRoutePolicy, t as buildAgentSessionKey } from "./resolve-route-CPxNiUBg.js";
import "./pairing-token-ukgXF6GK.js";
import { G as kindFromMime, R as resolveStorePath, W as isGifMedia } from "./query-expansion-t4qzEE5Z.js";
import { a as compileSafeRegex, o as testRegexWithBoundedInput } from "./redact-DkskT6Xp.js";
import "./channel-plugin-common-Cs4waNSc.js";
import "./secret-file-CCHXecQt.js";
import { n as isDiagnosticsEnabled } from "./diagnostic-events-DscEoHcg.js";
import { n as shouldAckReaction, t as removeAckReactionAfterReply } from "./ack-reactions-CF0ySZQ8.js";
import { t as recordInboundSessionMetaSafe } from "./session-meta-Dbnv_qpc.js";
import { a as createFinalizableDraftLifecycle, c as createStatusReactionController, i as resolveConfiguredAcpRoute, n as createOperatorApprovalsGatewayClient, o as DEFAULT_EMOJIS, r as ensureConfiguredAcpRouteReady, t as resolveExecApprovalCommandDisplay } from "./exec-approval-command-display-BBC7bhl_.js";
import { t as resolveNativeCommandSessionTargets } from "./native-command-session-targets-B2n7HauU.js";
import path from "node:path";
import os from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { API_CONSTANTS, Bot, GrammyError, InputFile, webhookCallback } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
//#region extensions/telegram/src/allowed-updates.ts
function resolveTelegramAllowedUpdates() {
	const updates = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES];
	if (!updates.includes("message_reaction")) updates.push("message_reaction");
	if (!updates.includes("channel_post")) updates.push("channel_post");
	return updates;
}
//#endregion
//#region src/infra/exec-approval-session-target.ts
init_session_key();
function normalizeOptionalString(value) {
	const normalized = value?.trim();
	return normalized ? normalized : void 0;
}
function normalizeOptionalThreadId(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value !== "string") return;
	const normalized = Number.parseInt(value, 10);
	return Number.isFinite(normalized) ? normalized : void 0;
}
function resolveExecApprovalSessionTarget(params) {
	const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
	if (!sessionKey) return null;
	const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? params.request.request.agentId ?? "main";
	const entry = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId }))[sessionKey];
	if (!entry) return null;
	const target = resolveSessionDeliveryTarget({
		entry,
		requestedChannel: "last",
		turnSourceChannel: normalizeOptionalString(params.turnSourceChannel),
		turnSourceTo: normalizeOptionalString(params.turnSourceTo),
		turnSourceAccountId: normalizeOptionalString(params.turnSourceAccountId),
		turnSourceThreadId: normalizeOptionalThreadId(params.turnSourceThreadId)
	});
	if (!target.to) return null;
	return {
		channel: normalizeOptionalString(target.channel),
		to: target.to,
		accountId: normalizeOptionalString(target.accountId),
		threadId: normalizeOptionalThreadId(target.threadId)
	};
}
//#endregion
//#region extensions/telegram/src/approval-buttons.ts
init_subsystem();
init_runtime();
init_globals();
const MAX_CALLBACK_DATA_BYTES = 64;
function fitsCallbackData(value) {
	return Buffer.byteLength(value, "utf8") <= MAX_CALLBACK_DATA_BYTES;
}
function buildTelegramExecApprovalButtons(approvalId) {
	return buildTelegramExecApprovalButtonsForDecisions(approvalId, [
		"allow-once",
		"allow-always",
		"deny"
	]);
}
function buildTelegramExecApprovalButtonsForDecisions(approvalId, allowedDecisions) {
	const allowOnce = `/approve ${approvalId} allow-once`;
	if (!allowedDecisions.includes("allow-once") || !fitsCallbackData(allowOnce)) return;
	const primaryRow = [{
		text: "Allow Once",
		callback_data: allowOnce
	}];
	const allowAlways = `/approve ${approvalId} allow-always`;
	if (allowedDecisions.includes("allow-always") && fitsCallbackData(allowAlways)) primaryRow.push({
		text: "Allow Always",
		callback_data: allowAlways
	});
	const rows = [primaryRow];
	const deny = `/approve ${approvalId} deny`;
	if (allowedDecisions.includes("deny") && fitsCallbackData(deny)) rows.push([{
		text: "Deny",
		callback_data: deny
	}]);
	return rows;
}
//#endregion
//#region extensions/telegram/src/exec-approvals-handler.ts
init_session_key();
const log = createSubsystemLogger("telegram/exec-approvals");
function matchesFilters(params) {
	const config = resolveTelegramExecApprovalConfig({
		cfg: params.cfg,
		accountId: params.accountId
	});
	if (!config?.enabled) return false;
	if (getTelegramExecApprovalApprovers({
		cfg: params.cfg,
		accountId: params.accountId
	}).length === 0) return false;
	if (config.agentFilter?.length) {
		const agentId = params.request.request.agentId ?? parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
		if (!agentId || !config.agentFilter.includes(agentId)) return false;
	}
	if (config.sessionFilter?.length) {
		const sessionKey = params.request.request.sessionKey;
		if (!sessionKey) return false;
		if (!config.sessionFilter.some((pattern) => {
			if (sessionKey.includes(pattern)) return true;
			const regex = compileSafeRegex(pattern);
			return regex ? testRegexWithBoundedInput(regex, sessionKey) : false;
		})) return false;
	}
	return true;
}
function isHandlerConfigured(params) {
	if (!resolveTelegramExecApprovalConfig({
		cfg: params.cfg,
		accountId: params.accountId
	})?.enabled) return false;
	return getTelegramExecApprovalApprovers({
		cfg: params.cfg,
		accountId: params.accountId
	}).length > 0;
}
function resolveRequestSessionTarget(params) {
	return resolveExecApprovalSessionTarget({
		cfg: params.cfg,
		request: params.request,
		turnSourceChannel: params.request.request.turnSourceChannel ?? void 0,
		turnSourceTo: params.request.request.turnSourceTo ?? void 0,
		turnSourceAccountId: params.request.request.turnSourceAccountId ?? void 0,
		turnSourceThreadId: params.request.request.turnSourceThreadId ?? void 0
	});
}
function resolveTelegramSourceTarget(params) {
	const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
	const turnSourceTo = params.request.request.turnSourceTo?.trim() || "";
	const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
	if (turnSourceChannel === "telegram" && turnSourceTo) {
		if (turnSourceAccountId && normalizeAccountId$1(turnSourceAccountId) !== normalizeAccountId$1(params.accountId)) return null;
		const threadId = typeof params.request.request.turnSourceThreadId === "number" ? params.request.request.turnSourceThreadId : typeof params.request.request.turnSourceThreadId === "string" ? Number.parseInt(params.request.request.turnSourceThreadId, 10) : void 0;
		return {
			to: turnSourceTo,
			threadId: Number.isFinite(threadId) ? threadId : void 0
		};
	}
	const sessionTarget = resolveRequestSessionTarget(params);
	if (!sessionTarget || sessionTarget.channel !== "telegram") return null;
	if (sessionTarget.accountId && normalizeAccountId$1(sessionTarget.accountId) !== normalizeAccountId$1(params.accountId)) return null;
	return {
		to: sessionTarget.to,
		threadId: sessionTarget.threadId
	};
}
function dedupeTargets(targets) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const target of targets) {
		const key = `${target.to}:${target.threadId ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(target);
	}
	return deduped;
}
var TelegramExecApprovalHandler = class {
	constructor(opts, deps = {}) {
		this.opts = opts;
		this.gatewayClient = null;
		this.pending = /* @__PURE__ */ new Map();
		this.started = false;
		this.nowMs = deps.nowMs ?? Date.now;
		this.sendTyping = deps.sendTyping ?? sendTypingTelegram;
		this.sendMessage = deps.sendMessage ?? sendMessageTelegram;
		this.editReplyMarkup = deps.editReplyMarkup ?? editMessageReplyMarkupTelegram;
	}
	shouldHandle(request) {
		return matchesFilters({
			cfg: this.opts.cfg,
			accountId: this.opts.accountId,
			request
		});
	}
	async start() {
		if (this.started) return;
		this.started = true;
		if (!isHandlerConfigured({
			cfg: this.opts.cfg,
			accountId: this.opts.accountId
		})) return;
		this.gatewayClient = await createOperatorApprovalsGatewayClient({
			config: this.opts.cfg,
			gatewayUrl: this.opts.gatewayUrl,
			clientDisplayName: `Telegram Exec Approvals (${this.opts.accountId})`,
			onEvent: (evt) => this.handleGatewayEvent(evt),
			onConnectError: (err) => {
				log.error(`telegram exec approvals: connect error: ${err.message}`);
			}
		});
		this.gatewayClient.start();
	}
	async stop() {
		if (!this.started) return;
		this.started = false;
		for (const pending of this.pending.values()) clearTimeout(pending.timeoutId);
		this.pending.clear();
		this.gatewayClient?.stop();
		this.gatewayClient = null;
	}
	async handleRequested(request) {
		if (!this.shouldHandle(request)) return;
		const targetMode = resolveTelegramExecApprovalTarget({
			cfg: this.opts.cfg,
			accountId: this.opts.accountId
		});
		const targets = [];
		const sourceTarget = resolveTelegramSourceTarget({
			cfg: this.opts.cfg,
			accountId: this.opts.accountId,
			request
		});
		let fallbackToDm = false;
		if (targetMode === "channel" || targetMode === "both") if (sourceTarget) targets.push(sourceTarget);
		else fallbackToDm = true;
		if (targetMode === "dm" || targetMode === "both" || fallbackToDm) for (const approver of getTelegramExecApprovalApprovers({
			cfg: this.opts.cfg,
			accountId: this.opts.accountId
		})) targets.push({ to: approver });
		const resolvedTargets = dedupeTargets(targets);
		if (resolvedTargets.length === 0) return;
		const payload = buildExecApprovalPendingReplyPayload({
			approvalId: request.id,
			approvalSlug: request.id.slice(0, 8),
			approvalCommandId: request.id,
			command: resolveExecApprovalCommandDisplay(request.request).commandText,
			cwd: request.request.cwd ?? void 0,
			host: request.request.host === "node" ? "node" : "gateway",
			nodeId: request.request.nodeId ?? void 0,
			expiresAtMs: request.expiresAtMs,
			nowMs: this.nowMs()
		});
		const buttons = buildTelegramExecApprovalButtons(request.id);
		const sentMessages = [];
		for (const target of resolvedTargets) try {
			await this.sendTyping(target.to, {
				cfg: this.opts.cfg,
				token: this.opts.token,
				accountId: this.opts.accountId,
				...typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}
			}).catch(() => {});
			const result = await this.sendMessage(target.to, payload.text ?? "", {
				cfg: this.opts.cfg,
				token: this.opts.token,
				accountId: this.opts.accountId,
				buttons,
				...typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}
			});
			sentMessages.push({
				chatId: result.chatId,
				messageId: result.messageId
			});
		} catch (err) {
			log.error(`telegram exec approvals: failed to send request ${request.id}: ${String(err)}`);
		}
		if (sentMessages.length === 0) return;
		const timeoutMs = Math.max(0, request.expiresAtMs - this.nowMs());
		const timeoutId = setTimeout(() => {
			this.handleResolved({
				id: request.id,
				decision: "deny",
				ts: Date.now()
			});
		}, timeoutMs);
		timeoutId.unref?.();
		this.pending.set(request.id, {
			timeoutId,
			messages: sentMessages
		});
	}
	async handleResolved(resolved) {
		const pending = this.pending.get(resolved.id);
		if (!pending) return;
		clearTimeout(pending.timeoutId);
		this.pending.delete(resolved.id);
		await Promise.allSettled(pending.messages.map(async (message) => {
			await this.editReplyMarkup(message.chatId, message.messageId, [], {
				cfg: this.opts.cfg,
				token: this.opts.token,
				accountId: this.opts.accountId
			});
		}));
	}
	handleGatewayEvent(evt) {
		if (evt.event === "exec.approval.requested") {
			this.handleRequested(evt.payload);
			return;
		}
		if (evt.event === "exec.approval.resolved") this.handleResolved(evt.payload);
	}
};
//#endregion
//#region extensions/telegram/src/bot-updates.ts
init_interactive();
init_conversation_binding();
init_session_binding_service();
init_json_files();
init_dedupe();
const RECENT_TELEGRAM_UPDATE_TTL_MS = 5 * 6e4;
const RECENT_TELEGRAM_UPDATE_MAX = 2e3;
const resolveTelegramUpdateId = (ctx) => ctx.update?.update_id ?? ctx.update_id;
const buildTelegramUpdateKey = (ctx) => {
	const updateId = resolveTelegramUpdateId(ctx);
	if (typeof updateId === "number") return `update:${updateId}`;
	const callbackId = ctx.callbackQuery?.id;
	if (callbackId) return `callback:${callbackId}`;
	const msg = ctx.message ?? ctx.channelPost ?? ctx.editedChannelPost ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.update?.channel_post ?? ctx.update?.edited_channel_post ?? ctx.callbackQuery?.message;
	const chatId = msg?.chat?.id;
	const messageId = msg?.message_id;
	if (typeof chatId !== "undefined" && typeof messageId === "number") return `message:${chatId}:${messageId}`;
};
const createTelegramUpdateDedupe = () => createDedupeCache({
	ttlMs: RECENT_TELEGRAM_UPDATE_TTL_MS,
	maxSize: RECENT_TELEGRAM_UPDATE_MAX
});
//#endregion
//#region extensions/telegram/src/bot/delivery.send.ts
init_internal_hooks();
const PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;
const EMPTY_TEXT_ERR_RE = /message text is empty/i;
const THREAD_NOT_FOUND_RE$1 = /message thread not found/i;
function isTelegramThreadNotFoundError(err) {
	if (err instanceof GrammyError) return THREAD_NOT_FOUND_RE$1.test(err.description);
	return THREAD_NOT_FOUND_RE$1.test(formatErrorMessage(err));
}
function hasMessageThreadIdParam(params) {
	if (!params) return false;
	return typeof params.message_thread_id === "number";
}
function removeMessageThreadIdParam(params) {
	if (!params) return {};
	const { message_thread_id: _ignored, ...rest } = params;
	return rest;
}
async function sendTelegramWithThreadFallback(params) {
	const allowThreadlessRetry = params.thread?.scope === "dm";
	const hasThreadId = hasMessageThreadIdParam(params.requestParams);
	const shouldSuppressFirstErrorLog = (err) => allowThreadlessRetry && hasThreadId && isTelegramThreadNotFoundError(err);
	const mergedShouldLog = params.shouldLog ? (err) => params.shouldLog(err) && !shouldSuppressFirstErrorLog(err) : (err) => !shouldSuppressFirstErrorLog(err);
	try {
		return await withTelegramApiErrorLogging({
			operation: params.operation,
			runtime: params.runtime,
			shouldLog: mergedShouldLog,
			fn: () => params.send(params.requestParams)
		});
	} catch (err) {
		if (!allowThreadlessRetry || !hasThreadId || !isTelegramThreadNotFoundError(err)) throw err;
		const retryParams = removeMessageThreadIdParam(params.requestParams);
		params.runtime.log?.(`telegram ${params.operation}: message thread not found; retrying without message_thread_id`);
		return await withTelegramApiErrorLogging({
			operation: `${params.operation} (threadless retry)`,
			runtime: params.runtime,
			fn: () => params.send(retryParams)
		});
	}
}
function buildTelegramSendParams(opts) {
	const threadParams = buildTelegramThreadParams(opts?.thread);
	const params = {};
	if (opts?.replyToMessageId) params.reply_to_message_id = opts.replyToMessageId;
	if (threadParams) params.message_thread_id = threadParams.message_thread_id;
	if (opts?.silent === true) params.disable_notification = true;
	return params;
}
async function sendTelegramText(bot, chatId, text, runtime, opts) {
	const baseParams = buildTelegramSendParams({
		replyToMessageId: opts?.replyToMessageId,
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
const VOICE_FORBIDDEN_RE = /VOICE_MESSAGES_FORBIDDEN/;
const CAPTION_TOO_LONG_RE = /caption is too long/i;
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
async function deliverTextReply(params) {
	let firstDeliveredMessageId;
	await sendChunkedTelegramReplyText({
		chunks: params.chunkText(params.replyText),
		progress: params.progress,
		replyToId: params.replyToId,
		replyToMode: params.replyToMode,
		replyMarkup: params.replyMarkup,
		replyQuoteText: params.replyQuoteText,
		markDelivered,
		sendChunk: async ({ chunk, replyToMessageId, replyMarkup, replyQuoteText }) => {
			const messageId = await sendTelegramText(params.bot, params.chatId, chunk.html, params.runtime, {
				replyToMessageId,
				replyQuoteText,
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
		chunks: params.chunkText(params.text),
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
	if (err instanceof GrammyError) return VOICE_FORBIDDEN_RE.test(err.description);
	return VOICE_FORBIDDEN_RE.test(formatErrorMessage(err));
}
function isCaptionTooLong(err) {
	if (err instanceof GrammyError) return CAPTION_TOO_LONG_RE.test(err.description);
	return CAPTION_TOO_LONG_RE.test(formatErrorMessage(err));
}
async function sendTelegramVoiceFallbackText(opts) {
	let firstDeliveredMessageId;
	const chunks = opts.chunkText(opts.text);
	let appliedReplyTo = false;
	for (let i = 0; i < chunks.length; i += 1) {
		const chunk = chunks[i];
		const replyToForChunk = !appliedReplyTo ? opts.replyToId : void 0;
		const messageId = await sendTelegramText(opts.bot, opts.chatId, chunk.html, opts.runtime, {
			replyToMessageId: replyToForChunk,
			replyQuoteText: !appliedReplyTo ? opts.replyQuoteText : void 0,
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
	let first = true;
	let pendingFollowUpText;
	for (const mediaUrl of params.mediaList) {
		const isFirstMedia = first;
		const media = await loadWebMedia(mediaUrl, buildOutboundMediaLoadOptions({ mediaLocalRoots: params.mediaLocalRoots }));
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
		const mediaParams = {
			caption: htmlCaption,
			...htmlCaption ? { parse_mode: "HTML" } : {},
			...shouldAttachButtonsToMedia ? { reply_markup: params.replyMarkup } : {},
			...buildTelegramSendParams({
				replyToMessageId,
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
						const fallbackText = params.reply.text;
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
							thread: params.thread,
							linkPreview: params.linkPreview,
							silent: params.silent,
							replyMarkup: params.replyMarkup,
							replyQuoteText: params.replyQuoteText
						});
						if (firstDeliveredMessageId == null) firstDeliveredMessageId = fallbackMessageId;
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
						const fallbackText = params.reply.text;
						if (fallbackText?.trim()) await sendTelegramVoiceFallbackText({
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
	return firstDeliveredMessageId;
}
async function maybePinFirstDeliveredMessage(params) {
	if (!params.shouldPin || typeof params.firstDeliveredMessageId !== "number") return;
	try {
		await params.bot.api.pinChatMessage(params.chatId, params.firstDeliveredMessageId, { disable_notification: true });
	} catch (err) {
		logVerbose(`telegram pinChatMessage failed chat=${params.chatId} message=${params.firstDeliveredMessageId}: ${formatErrorMessage(err)}`);
	}
}
function emitMessageSentHooks(params) {
	if (!params.enabled && !params.sessionKeyForInternalHooks) return;
	const canonical = buildCanonicalSentMessageHookContext({
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
	if (params.enabled) fireAndForgetHook(Promise.resolve(params.hookRunner.runMessageSent(toPluginMessageSentEvent(canonical), toPluginMessageContext(canonical))), "telegram: message_sent plugin hook failed");
	if (!params.sessionKeyForInternalHooks) return;
	fireAndForgetHook(triggerInternalHook(createInternalHookEvent("message", "sent", params.sessionKeyForInternalHooks, toInternalMessageSentContext(canonical))), "telegram: message:sent internal hook failed");
}
async function deliverReplies(params) {
	const progress = {
		hasReplied: false,
		hasDelivered: false,
		deliveredCount: 0
	};
	const hookRunner = getGlobalHookRunner();
	const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
	const hasMessageSentHooks = hookRunner?.hasHooks("message_sent") ?? false;
	const chunkText = buildChunkTextResolver({
		textLimit: params.textLimit,
		chunkMode: params.chunkMode ?? "length",
		tableMode: params.tableMode
	});
	for (const originalReply of params.replies) {
		let reply = originalReply;
		const mediaList = reply?.mediaUrls?.length ? reply.mediaUrls : reply?.mediaUrl ? [reply.mediaUrl] : [];
		const hasMedia = mediaList.length > 0;
		if (!reply?.text && !hasMedia) {
			if (reply?.audioAsVoice) {
				logVerbose("telegram reply has audioAsVoice without media/text; skipping");
				continue;
			}
			params.runtime.error?.(danger("reply missing text/media"));
			continue;
		}
		const rawContent = reply.text || "";
		if (hasMessageSendingHooks) {
			const hookResult = await hookRunner?.runMessageSending({
				to: params.chatId,
				content: rawContent,
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
			if (typeof hookResult?.content === "string" && hookResult.content !== rawContent) reply = {
				...reply,
				text: hookResult.content
			};
		}
		const contentForSentHook = reply.text || "";
		try {
			const deliveredCountBeforeReply = progress.deliveredCount;
			const replyToId = params.replyToMode === "off" ? void 0 : resolveTelegramReplyId(reply.replyToId);
			const telegramData = reply.channelData?.telegram;
			const shouldPinFirstMessage = telegramData?.pin === true;
			const replyMarkup = buildInlineKeyboard(telegramData?.buttons);
			let firstDeliveredMessageId;
			if (mediaList.length === 0) firstDeliveredMessageId = await deliverTextReply({
				bot: params.bot,
				chatId: params.chatId,
				runtime: params.runtime,
				thread: params.thread,
				chunkText,
				replyText: reply.text || "",
				replyMarkup,
				replyQuoteText: params.replyQuoteText,
				linkPreview: params.linkPreview,
				silent: params.silent,
				replyToId,
				replyToMode: params.replyToMode,
				progress
			});
			else firstDeliveredMessageId = await deliverMediaReply({
				reply,
				mediaList,
				bot: params.bot,
				chatId: params.chatId,
				runtime: params.runtime,
				thread: params.thread,
				tableMode: params.tableMode,
				mediaLocalRoots: params.mediaLocalRoots,
				chunkText,
				onVoiceRecording: params.onVoiceRecording,
				linkPreview: params.linkPreview,
				silent: params.silent,
				replyQuoteText: params.replyQuoteText,
				replyMarkup,
				replyToId,
				replyToMode: params.replyToMode,
				progress
			});
			await maybePinFirstDeliveredMessage({
				shouldPin: shouldPinFirstMessage,
				bot: params.bot,
				chatId: params.chatId,
				runtime: params.runtime,
				firstDeliveredMessageId
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
				error: error instanceof Error ? error.message : String(error),
				isGroup: params.mirrorIsGroup,
				groupId: params.mirrorGroupId
			});
			throw error;
		}
	}
	return { delivered: progress.hasDelivered };
}
//#endregion
//#region extensions/telegram/src/bot/delivery.resolve-media.ts
init_globals();
init_retry();
const FILE_TOO_BIG_RE = /file is too big/i;
const TELEGRAM_MEDIA_SSRF_POLICY = {
	allowedHostnames: ["api.telegram.org"],
	allowRfc2544BenchmarkRange: true
};
/**
* Returns true if the error is Telegram's "file is too big" error.
* This happens when trying to download files >20MB via the Bot API.
* Unlike network errors, this is a permanent error and should not be retried.
*/
function isFileTooBigError(err) {
	if (err instanceof GrammyError) return FILE_TOO_BIG_RE.test(err.description);
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
function resolveMediaFileRef(msg) {
	return msg.photo?.[msg.photo.length - 1] ?? msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice;
}
function resolveTelegramFileName(msg) {
	return msg.document?.file_name ?? msg.audio?.file_name ?? msg.video?.file_name ?? msg.animation?.file_name;
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
		sourceFetch: resolvedFetch
	};
}
function resolveOptionalTelegramTransport(transport) {
	try {
		return resolveRequiredTelegramTransport(transport);
	} catch {
		return null;
	}
}
/** Default idle timeout for Telegram media downloads (30 seconds). */
const TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS = 3e4;
async function downloadAndSaveTelegramFile(params) {
	const fetched = await fetchRemoteMedia({
		url: `https://api.telegram.org/file/bot${params.token}/${params.filePath}`,
		fetchImpl: params.transport.sourceFetch,
		dispatcherPolicy: params.transport.pinnedDispatcherPolicy,
		fallbackDispatcherPolicy: params.transport.fallbackPinnedDispatcherPolicy,
		shouldRetryFetchError: shouldRetryTelegramIpv4Fallback,
		filePathHint: params.filePath,
		maxBytes: params.maxBytes,
		readIdleTimeoutMs: TELEGRAM_DOWNLOAD_IDLE_TIMEOUT_MS,
		ssrfPolicy: TELEGRAM_MEDIA_SSRF_POLICY
	});
	const originalName = params.telegramFileName ?? fetched.fileName ?? params.filePath;
	return saveMediaBuffer(fetched.buffer, fetched.contentType, "inbound", params.maxBytes, originalName);
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
		const resolvedTransport = resolveOptionalTelegramTransport(transport);
		if (!resolvedTransport) {
			logVerbose("telegram: fetch not available for sticker download");
			return null;
		}
		const saved = await downloadAndSaveTelegramFile({
			filePath: file.file_path,
			token,
			transport: resolvedTransport,
			maxBytes
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
async function resolveMedia(ctx, maxBytes, token, transport) {
	const msg = ctx.message;
	const stickerResolved = await resolveStickerMedia({
		msg,
		ctx,
		maxBytes,
		token,
		transport
	});
	if (stickerResolved !== void 0) return stickerResolved;
	if (!resolveMediaFileRef(msg)?.file_id) return null;
	const file = await resolveTelegramFileWithRetry(ctx);
	if (!file) return null;
	if (!file.file_path) throw new Error("Telegram getFile returned no file_path");
	const saved = await downloadAndSaveTelegramFile({
		filePath: file.file_path,
		token,
		transport: resolveRequiredTelegramTransport(transport),
		maxBytes,
		telegramFileName: resolveTelegramFileName(msg)
	});
	const placeholder = resolveTelegramMediaPlaceholder(msg) ?? "<media:document>";
	return {
		path: saved.path,
		contentType: saved.contentType,
		placeholder
	};
}
//#endregion
//#region extensions/telegram/src/conversation-route.ts
init_globals();
init_session_key();
function resolveTelegramConversationRoute(params) {
	const peerId = params.isGroup ? buildTelegramGroupPeerId(params.chatId, params.resolvedThreadId) : resolveTelegramDirectPeerId({
		chatId: params.chatId,
		senderId: params.senderId
	});
	const parentPeer = buildTelegramParentPeer({
		isGroup: params.isGroup,
		resolvedThreadId: params.resolvedThreadId,
		chatId: params.chatId
	});
	let route = resolveAgentRoute({
		cfg: params.cfg,
		channel: "telegram",
		accountId: params.accountId,
		peer: {
			kind: params.isGroup ? "group" : "direct",
			id: peerId
		},
		parentPeer
	});
	const rawTopicAgentId = params.topicAgentId?.trim();
	if (rawTopicAgentId) {
		const topicAgentId = sanitizeAgentId(rawTopicAgentId);
		route = {
			...route,
			agentId: topicAgentId,
			sessionKey: buildAgentSessionKey({
				agentId: topicAgentId,
				channel: "telegram",
				accountId: params.accountId,
				peer: {
					kind: params.isGroup ? "group" : "direct",
					id: peerId
				},
				dmScope: params.cfg.session?.dmScope,
				identityLinks: params.cfg.session?.identityLinks
			}).toLowerCase(),
			mainSessionKey: buildAgentMainSessionKey({ agentId: topicAgentId }).toLowerCase(),
			lastRoutePolicy: deriveLastRoutePolicy({
				sessionKey: buildAgentSessionKey({
					agentId: topicAgentId,
					channel: "telegram",
					accountId: params.accountId,
					peer: {
						kind: params.isGroup ? "group" : "direct",
						id: peerId
					},
					dmScope: params.cfg.session?.dmScope,
					identityLinks: params.cfg.session?.identityLinks
				}).toLowerCase(),
				mainSessionKey: buildAgentMainSessionKey({ agentId: topicAgentId }).toLowerCase()
			})
		};
		logVerbose(`telegram: topic route override: topic=${params.resolvedThreadId ?? params.replyThreadId} agent=${topicAgentId} sessionKey=${route.sessionKey}`);
	}
	const configuredRoute = resolveConfiguredAcpRoute({
		cfg: params.cfg,
		route,
		channel: "telegram",
		accountId: params.accountId,
		conversationId: peerId,
		parentConversationId: params.isGroup ? String(params.chatId) : void 0
	});
	let configuredBinding = configuredRoute.configuredBinding;
	let configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
	route = configuredRoute.route;
	const threadBindingConversationId = params.replyThreadId != null ? `${params.chatId}:topic:${params.replyThreadId}` : !params.isGroup ? String(params.chatId) : void 0;
	if (threadBindingConversationId) {
		const threadBinding = getSessionBindingService().resolveByConversation({
			channel: "telegram",
			accountId: params.accountId,
			conversationId: threadBindingConversationId
		});
		const boundSessionKey = threadBinding?.targetSessionKey?.trim();
		if (threadBinding && boundSessionKey) {
			if (!isPluginOwnedSessionBindingRecord(threadBinding)) route = {
				...route,
				sessionKey: boundSessionKey,
				agentId: resolveAgentIdFromSessionKey(boundSessionKey),
				lastRoutePolicy: deriveLastRoutePolicy({
					sessionKey: boundSessionKey,
					mainSessionKey: route.mainSessionKey
				}),
				matchedBy: "binding.channel"
			};
			configuredBinding = null;
			configuredBindingSessionKey = "";
			getSessionBindingService().touch(threadBinding.bindingId);
			logVerbose(isPluginOwnedSessionBindingRecord(threadBinding) ? `telegram: plugin-bound conversation ${threadBindingConversationId}` : `telegram: routed via bound conversation ${threadBindingConversationId} -> ${boundSessionKey}`);
		}
	}
	return {
		route,
		configuredBinding,
		configuredBindingSessionKey
	};
}
//#endregion
//#region extensions/telegram/src/dm-access.ts
init_globals();
function resolveTelegramSenderIdentity(msg, chatId) {
	const from = msg.from;
	const userId = from?.id != null ? String(from.id) : null;
	return {
		username: from?.username ?? "",
		userId,
		candidateId: userId ?? String(chatId),
		firstName: from?.first_name,
		lastName: from?.last_name
	};
}
async function enforceTelegramDmAccess(params) {
	const { isGroup, dmPolicy, msg, chatId, effectiveDmAllow, accountId, bot, logger } = params;
	if (isGroup) return true;
	if (dmPolicy === "disabled") return false;
	if (dmPolicy === "open") return true;
	const sender = resolveTelegramSenderIdentity(msg, chatId);
	const allowMatch = resolveSenderAllowMatch({
		allow: effectiveDmAllow,
		senderId: sender.candidateId,
		senderUsername: sender.username
	});
	const allowMatchMeta = `matchKey=${allowMatch.matchKey ?? "none"} matchSource=${allowMatch.matchSource ?? "none"}`;
	if (effectiveDmAllow.hasWildcard || effectiveDmAllow.hasEntries && allowMatch.allowed) return true;
	if (dmPolicy === "pairing") {
		try {
			const telegramUserId = sender.userId ?? sender.candidateId;
			await issuePairingChallenge({
				channel: "telegram",
				senderId: telegramUserId,
				senderIdLine: `Your Telegram user id: ${telegramUserId}`,
				meta: {
					username: sender.username || void 0,
					firstName: sender.firstName,
					lastName: sender.lastName
				},
				upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
					channel: "telegram",
					id,
					accountId,
					meta
				}),
				onCreated: () => {
					logger.info({
						chatId: String(chatId),
						senderUserId: sender.userId ?? void 0,
						username: sender.username || void 0,
						firstName: sender.firstName,
						lastName: sender.lastName,
						matchKey: allowMatch.matchKey ?? "none",
						matchSource: allowMatch.matchSource ?? "none"
					}, "telegram pairing request");
				},
				sendPairingReply: async (text) => {
					await withTelegramApiErrorLogging({
						operation: "sendMessage",
						fn: () => bot.api.sendMessage(chatId, text)
					});
				},
				onReplyError: (err) => {
					logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
				}
			});
		} catch (err) {
			logVerbose(`telegram pairing reply failed for chat ${chatId}: ${String(err)}`);
		}
		return false;
	}
	logVerbose(`Blocked unauthorized telegram sender ${sender.candidateId} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`);
	return false;
}
//#endregion
//#region extensions/telegram/src/group-access.ts
init_runtime_group_policy();
init_group_access();
function isGroupAllowOverrideAuthorized(params) {
	if (!params.effectiveGroupAllow.hasEntries) return false;
	const senderId = params.senderId ?? "";
	if (params.requireSenderForAllowOverride && !senderId) return false;
	return isSenderAllowed({
		allow: params.effectiveGroupAllow,
		senderId,
		senderUsername: params.senderUsername ?? ""
	});
}
const evaluateTelegramGroupBaseAccess = (params) => {
	if (params.groupConfig?.enabled === false) return {
		allowed: false,
		reason: "group-disabled"
	};
	if (params.topicConfig?.enabled === false) return {
		allowed: false,
		reason: "topic-disabled"
	};
	if (!params.isGroup) {
		if (params.enforceAllowOverride && params.hasGroupAllowOverride) {
			if (!isGroupAllowOverrideAuthorized({
				effectiveGroupAllow: params.effectiveGroupAllow,
				senderId: params.senderId,
				senderUsername: params.senderUsername,
				requireSenderForAllowOverride: params.requireSenderForAllowOverride
			})) return {
				allowed: false,
				reason: "group-override-unauthorized"
			};
		}
		return { allowed: true };
	}
	if (!params.enforceAllowOverride || !params.hasGroupAllowOverride) return { allowed: true };
	if (!isGroupAllowOverrideAuthorized({
		effectiveGroupAllow: params.effectiveGroupAllow,
		senderId: params.senderId,
		senderUsername: params.senderUsername,
		requireSenderForAllowOverride: params.requireSenderForAllowOverride
	})) return {
		allowed: false,
		reason: "group-override-unauthorized"
	};
	return { allowed: true };
};
const resolveTelegramRuntimeGroupPolicy = (params) => resolveOpenProviderRuntimeGroupPolicy({
	providerConfigPresent: params.providerConfigPresent,
	groupPolicy: params.groupPolicy,
	defaultGroupPolicy: params.defaultGroupPolicy
});
const evaluateTelegramGroupPolicyAccess = (params) => {
	const { groupPolicy: runtimeFallbackPolicy } = resolveTelegramRuntimeGroupPolicy({
		providerConfigPresent: params.cfg.channels?.telegram !== void 0,
		groupPolicy: params.telegramCfg.groupPolicy,
		defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy
	});
	const fallbackPolicy = firstDefined(params.telegramCfg.groupPolicy, params.cfg.channels?.defaults?.groupPolicy) ?? runtimeFallbackPolicy;
	const groupPolicy = params.useTopicAndGroupOverrides ? firstDefined(params.topicConfig?.groupPolicy, params.groupConfig?.groupPolicy, params.telegramCfg.groupPolicy, params.cfg.channels?.defaults?.groupPolicy) ?? runtimeFallbackPolicy : fallbackPolicy;
	if (!params.isGroup || !params.enforcePolicy) return {
		allowed: true,
		groupPolicy
	};
	if (groupPolicy === "disabled") return {
		allowed: false,
		reason: "group-policy-disabled",
		groupPolicy
	};
	let chatExplicitlyAllowed = false;
	if (params.checkChatAllowlist) {
		const groupAllowlist = params.resolveGroupPolicy(params.chatId);
		if (groupAllowlist.allowlistEnabled && !groupAllowlist.allowed) return {
			allowed: false,
			reason: "group-chat-not-allowed",
			groupPolicy
		};
		if (groupAllowlist.allowlistEnabled && groupAllowlist.allowed && groupAllowlist.groupConfig) chatExplicitlyAllowed = true;
	}
	if (groupPolicy === "allowlist" && params.enforceAllowlistAuthorization) {
		const senderId = params.senderId ?? "";
		const senderAuthorization = evaluateMatchedGroupAccessForPolicy({
			groupPolicy,
			requireMatchInput: params.requireSenderForAllowlistAuthorization,
			hasMatchInput: Boolean(senderId),
			allowlistConfigured: chatExplicitlyAllowed || params.allowEmptyAllowlistEntries || params.effectiveGroupAllow.hasEntries,
			allowlistMatched: chatExplicitlyAllowed && !params.effectiveGroupAllow.hasEntries || isSenderAllowed({
				allow: params.effectiveGroupAllow,
				senderId,
				senderUsername: params.senderUsername ?? ""
			})
		});
		if (!senderAuthorization.allowed && senderAuthorization.reason === "missing_match_input") return {
			allowed: false,
			reason: "group-policy-allowlist-no-sender",
			groupPolicy
		};
		if (!senderAuthorization.allowed && senderAuthorization.reason === "empty_allowlist") return {
			allowed: false,
			reason: "group-policy-allowlist-empty",
			groupPolicy
		};
		if (!senderAuthorization.allowed && senderAuthorization.reason === "not_allowlisted") return {
			allowed: false,
			reason: "group-policy-allowlist-unauthorized",
			groupPolicy
		};
	}
	return {
		allowed: true,
		groupPolicy
	};
};
//#endregion
//#region extensions/telegram/src/group-migration.ts
init_session_key();
function resolveAccountGroups(cfg, accountId) {
	if (!accountId) return {};
	const normalized = normalizeAccountId$1(accountId);
	const accounts = cfg.channels?.telegram?.accounts;
	if (!accounts || typeof accounts !== "object") return {};
	const exact = accounts[normalized];
	if (exact?.groups) return { groups: exact.groups };
	const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized.toLowerCase());
	return { groups: matchKey ? accounts[matchKey]?.groups : void 0 };
}
function migrateTelegramGroupsInPlace(groups, oldChatId, newChatId) {
	if (!groups) return {
		migrated: false,
		skippedExisting: false
	};
	if (oldChatId === newChatId) return {
		migrated: false,
		skippedExisting: false
	};
	if (!Object.hasOwn(groups, oldChatId)) return {
		migrated: false,
		skippedExisting: false
	};
	if (Object.hasOwn(groups, newChatId)) return {
		migrated: false,
		skippedExisting: true
	};
	groups[newChatId] = groups[oldChatId];
	delete groups[oldChatId];
	return {
		migrated: true,
		skippedExisting: false
	};
}
function migrateTelegramGroupConfig(params) {
	const scopes = [];
	let migrated = false;
	let skippedExisting = false;
	const migrationTargets = [{
		scope: "account",
		groups: resolveAccountGroups(params.cfg, params.accountId).groups
	}, {
		scope: "global",
		groups: params.cfg.channels?.telegram?.groups
	}];
	for (const target of migrationTargets) {
		const result = migrateTelegramGroupsInPlace(target.groups, params.oldChatId, params.newChatId);
		if (result.migrated) {
			migrated = true;
			scopes.push(target.scope);
		}
		if (result.skippedExisting) skippedExisting = true;
	}
	return {
		migrated,
		skippedExisting,
		scopes
	};
}
//#endregion
//#region extensions/telegram/src/bot-handlers.ts
init_globals();
init_conversation_binding();
init_session_key();
const APPROVE_CALLBACK_DATA_RE = /^\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+(allow-once|allow-always|deny)\b/i;
function isMediaSizeLimitError(err) {
	const errMsg = String(err);
	return errMsg.includes("exceeds") && errMsg.includes("MB limit");
}
function isRecoverableMediaGroupError(err) {
	return err instanceof MediaFetchError || isMediaSizeLimitError(err);
}
function hasInboundMedia(msg) {
	return Boolean(msg.media_group_id) || Array.isArray(msg.photo) && msg.photo.length > 0 || Boolean(msg.video ?? msg.video_note ?? msg.document ?? msg.audio ?? msg.voice ?? msg.sticker);
}
function hasReplyTargetMedia(msg) {
	const externalReply = msg.external_reply;
	const replyTarget = msg.reply_to_message ?? externalReply;
	return Boolean(replyTarget && hasInboundMedia(replyTarget));
}
function resolveInboundMediaFileId(msg) {
	return msg.sticker?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id ?? msg.video?.file_id ?? msg.video_note?.file_id ?? msg.document?.file_id ?? msg.audio?.file_id ?? msg.voice?.file_id;
}
const registerTelegramHandlers = ({ cfg, accountId, bot, opts, telegramTransport, runtime, mediaMaxBytes, telegramCfg, allowFrom, groupAllowFrom, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, processMessage, logger }) => {
	const DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS = 1500;
	const TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS = 4e3;
	const TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS = typeof opts.testTimings?.textFragmentGapMs === "number" && Number.isFinite(opts.testTimings.textFragmentGapMs) ? Math.max(10, Math.floor(opts.testTimings.textFragmentGapMs)) : DEFAULT_TEXT_FRAGMENT_MAX_GAP_MS;
	const TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP = 1;
	const TELEGRAM_TEXT_FRAGMENT_MAX_PARTS = 12;
	const TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS = 5e4;
	const mediaGroupTimeoutMs = typeof opts.testTimings?.mediaGroupFlushMs === "number" && Number.isFinite(opts.testTimings.mediaGroupFlushMs) ? Math.max(10, Math.floor(opts.testTimings.mediaGroupFlushMs)) : 500;
	const mediaGroupBuffer = /* @__PURE__ */ new Map();
	let mediaGroupProcessing = Promise.resolve();
	const textFragmentBuffer = /* @__PURE__ */ new Map();
	let textFragmentProcessing = Promise.resolve();
	const debounceMs = resolveInboundDebounceMs({
		cfg,
		channel: "telegram"
	});
	const FORWARD_BURST_DEBOUNCE_MS = 80;
	const resolveTelegramDebounceLane = (msg) => {
		const forwardMeta = msg;
		return forwardMeta.forward_origin ?? forwardMeta.forward_from ?? forwardMeta.forward_from_chat ?? forwardMeta.forward_sender_name ?? forwardMeta.forward_date ? "forward" : "default";
	};
	const buildSyntheticTextMessage = (params) => ({
		...params.base,
		...params.from ? { from: params.from } : {},
		text: params.text,
		caption: void 0,
		caption_entities: void 0,
		entities: void 0,
		...params.date != null ? { date: params.date } : {}
	});
	const buildSyntheticContext = (ctx, message) => {
		const getFile = typeof ctx.getFile === "function" ? ctx.getFile.bind(ctx) : async () => ({});
		return {
			message,
			me: ctx.me,
			getFile
		};
	};
	const inboundDebouncer = createInboundDebouncer({
		debounceMs,
		resolveDebounceMs: (entry) => entry.debounceLane === "forward" ? FORWARD_BURST_DEBOUNCE_MS : debounceMs,
		buildKey: (entry) => entry.debounceKey,
		shouldDebounce: (entry) => {
			const hasDebounceableText = shouldDebounceTextInbound({
				text: entry.msg.text ?? entry.msg.caption ?? "",
				cfg,
				commandOptions: { botUsername: entry.botUsername }
			});
			if (entry.debounceLane === "forward") return hasDebounceableText || entry.allMedia.length > 0;
			if (!hasDebounceableText) return false;
			return entry.allMedia.length === 0;
		},
		onFlush: async (entries) => {
			const last = entries.at(-1);
			if (!last) return;
			if (entries.length === 1) {
				const replyMedia = await resolveReplyMediaForMessage(last.ctx, last.msg);
				await processMessage(last.ctx, last.allMedia, last.storeAllowFrom, void 0, replyMedia);
				return;
			}
			const combinedText = entries.map((entry) => entry.msg.text ?? entry.msg.caption ?? "").filter(Boolean).join("\n");
			const combinedMedia = entries.flatMap((entry) => entry.allMedia);
			if (!combinedText.trim() && combinedMedia.length === 0) return;
			const first = entries[0];
			const baseCtx = first.ctx;
			const syntheticMessage = buildSyntheticTextMessage({
				base: first.msg,
				text: combinedText,
				date: last.msg.date ?? first.msg.date
			});
			const messageIdOverride = last.msg.message_id ? String(last.msg.message_id) : void 0;
			const syntheticCtx = buildSyntheticContext(baseCtx, syntheticMessage);
			const replyMedia = await resolveReplyMediaForMessage(baseCtx, syntheticMessage);
			await processMessage(syntheticCtx, combinedMedia, first.storeAllowFrom, messageIdOverride ? { messageIdOverride } : void 0, replyMedia);
		},
		onError: (err, items) => {
			runtime.error?.(danger(`telegram debounce flush failed: ${String(err)}`));
			const chatId = items[0]?.msg.chat.id;
			if (chatId != null) {
				const threadId = items[0]?.msg.message_thread_id;
				bot.api.sendMessage(chatId, "Something went wrong while processing your message. Please try again.", threadId != null ? { message_thread_id: threadId } : void 0).catch((sendErr) => {
					logVerbose(`telegram: error fallback send failed: ${String(sendErr)}`);
				});
			}
		}
	});
	const resolveTelegramSessionState = (params) => {
		const resolvedThreadId = params.resolvedThreadId ?? resolveTelegramForumThreadId({
			isForum: params.isForum,
			messageThreadId: params.messageThreadId
		});
		const dmThreadId = !params.isGroup ? params.messageThreadId : void 0;
		const topicThreadId = resolvedThreadId ?? dmThreadId;
		const { topicConfig } = resolveTelegramGroupConfig(params.chatId, topicThreadId);
		const { route } = resolveTelegramConversationRoute({
			cfg,
			accountId,
			chatId: params.chatId,
			isGroup: params.isGroup,
			resolvedThreadId,
			replyThreadId: topicThreadId,
			senderId: params.senderId,
			topicAgentId: topicConfig?.agentId
		});
		const baseSessionKey = route.sessionKey;
		const sessionKey = (dmThreadId != null ? resolveThreadSessionKeys({
			baseSessionKey,
			threadId: `${params.chatId}:${dmThreadId}`
		}) : null)?.sessionKey ?? baseSessionKey;
		const store = loadSessionStore(resolveStorePath(cfg.session?.store, { agentId: route.agentId }));
		const entry = resolveSessionStoreEntry({
			store,
			sessionKey
		}).existing;
		const storedOverride = resolveStoredModelOverride({
			sessionEntry: entry,
			sessionStore: store,
			sessionKey
		});
		if (storedOverride) return {
			agentId: route.agentId,
			sessionEntry: entry,
			sessionKey,
			model: storedOverride.provider ? `${storedOverride.provider}/${storedOverride.model}` : storedOverride.model
		};
		const provider = entry?.modelProvider?.trim();
		const model = entry?.model?.trim();
		if (provider && model) return {
			agentId: route.agentId,
			sessionEntry: entry,
			sessionKey,
			model: `${provider}/${model}`
		};
		const modelCfg = cfg.agents?.defaults?.model;
		return {
			agentId: route.agentId,
			sessionEntry: entry,
			sessionKey,
			model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary
		};
	};
	const processMediaGroup = async (entry) => {
		try {
			entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
			const primaryEntry = entry.messages.find((m) => m.msg.caption || m.msg.text) ?? entry.messages[0];
			const allMedia = [];
			for (const { ctx } of entry.messages) {
				let media;
				try {
					media = await resolveMedia(ctx, mediaMaxBytes, opts.token, telegramTransport);
				} catch (mediaErr) {
					if (!isRecoverableMediaGroupError(mediaErr)) throw mediaErr;
					runtime.log?.(warn(`media group: skipping photo that failed to fetch: ${String(mediaErr)}`));
					continue;
				}
				if (media) allMedia.push({
					path: media.path,
					contentType: media.contentType,
					stickerMetadata: media.stickerMetadata
				});
			}
			const storeAllowFrom = await loadStoreAllowFrom();
			const replyMedia = await resolveReplyMediaForMessage(primaryEntry.ctx, primaryEntry.msg);
			await processMessage(primaryEntry.ctx, allMedia, storeAllowFrom, void 0, replyMedia);
		} catch (err) {
			runtime.error?.(danger(`media group handler failed: ${String(err)}`));
		}
	};
	const flushTextFragments = async (entry) => {
		try {
			entry.messages.sort((a, b) => a.msg.message_id - b.msg.message_id);
			const first = entry.messages[0];
			const last = entry.messages.at(-1);
			if (!first || !last) return;
			const combinedText = entry.messages.map((m) => m.msg.text ?? "").join("");
			if (!combinedText.trim()) return;
			const syntheticMessage = buildSyntheticTextMessage({
				base: first.msg,
				text: combinedText,
				date: last.msg.date ?? first.msg.date
			});
			const storeAllowFrom = await loadStoreAllowFrom();
			const baseCtx = first.ctx;
			await processMessage(buildSyntheticContext(baseCtx, syntheticMessage), [], storeAllowFrom, { messageIdOverride: String(last.msg.message_id) });
		} catch (err) {
			runtime.error?.(danger(`text fragment handler failed: ${String(err)}`));
		}
	};
	const queueTextFragmentFlush = async (entry) => {
		textFragmentProcessing = textFragmentProcessing.then(async () => {
			await flushTextFragments(entry);
		}).catch(() => void 0);
		await textFragmentProcessing;
	};
	const runTextFragmentFlush = async (entry) => {
		textFragmentBuffer.delete(entry.key);
		await queueTextFragmentFlush(entry);
	};
	const scheduleTextFragmentFlush = (entry) => {
		clearTimeout(entry.timer);
		entry.timer = setTimeout(async () => {
			await runTextFragmentFlush(entry);
		}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS);
	};
	const loadStoreAllowFrom = async () => readChannelAllowFromStore("telegram", process.env, accountId).catch(() => []);
	const resolveReplyMediaForMessage = async (ctx, msg) => {
		const replyMessage = msg.reply_to_message;
		if (!replyMessage || !hasInboundMedia(replyMessage)) return [];
		const replyFileId = resolveInboundMediaFileId(replyMessage);
		if (!replyFileId) return [];
		try {
			const media = await resolveMedia({
				message: replyMessage,
				me: ctx.me,
				getFile: async () => await bot.api.getFile(replyFileId)
			}, mediaMaxBytes, opts.token, telegramTransport);
			if (!media) return [];
			return [{
				path: media.path,
				contentType: media.contentType,
				stickerMetadata: media.stickerMetadata
			}];
		} catch (err) {
			logger.warn({
				chatId: msg.chat.id,
				error: String(err)
			}, "reply media fetch failed");
			return [];
		}
	};
	const isAllowlistAuthorized = (allow, senderId, senderUsername) => allow.hasWildcard || allow.hasEntries && isSenderAllowed({
		allow,
		senderId,
		senderUsername
	});
	const shouldSkipGroupMessage = (params) => {
		const { isGroup, chatId, chatTitle, resolvedThreadId, senderId, senderUsername, effectiveGroupAllow, hasGroupAllowOverride, groupConfig, topicConfig } = params;
		const baseAccess = evaluateTelegramGroupBaseAccess({
			isGroup,
			groupConfig,
			topicConfig,
			hasGroupAllowOverride,
			effectiveGroupAllow,
			senderId,
			senderUsername,
			enforceAllowOverride: true,
			requireSenderForAllowOverride: true
		});
		if (!baseAccess.allowed) {
			if (baseAccess.reason === "group-disabled") {
				logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
				return true;
			}
			if (baseAccess.reason === "topic-disabled") {
				logVerbose(`Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`);
				return true;
			}
			logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)`);
			return true;
		}
		if (!isGroup) return false;
		const policyAccess = evaluateTelegramGroupPolicyAccess({
			isGroup,
			chatId,
			cfg,
			telegramCfg,
			topicConfig,
			groupConfig,
			effectiveGroupAllow,
			senderId,
			senderUsername,
			resolveGroupPolicy,
			enforcePolicy: true,
			useTopicAndGroupOverrides: true,
			enforceAllowlistAuthorization: true,
			allowEmptyAllowlistEntries: false,
			requireSenderForAllowlistAuthorization: true,
			checkChatAllowlist: true
		});
		if (!policyAccess.allowed) {
			if (policyAccess.reason === "group-policy-disabled") {
				logVerbose("Blocked telegram group message (groupPolicy: disabled)");
				return true;
			}
			if (policyAccess.reason === "group-policy-allowlist-no-sender") {
				logVerbose("Blocked telegram group message (no sender ID, groupPolicy: allowlist)");
				return true;
			}
			if (policyAccess.reason === "group-policy-allowlist-empty") {
				logVerbose("Blocked telegram group message (groupPolicy: allowlist, no group allowlist entries)");
				return true;
			}
			if (policyAccess.reason === "group-policy-allowlist-unauthorized") {
				logVerbose(`Blocked telegram group message from ${senderId} (groupPolicy: allowlist)`);
				return true;
			}
			logger.info({
				chatId,
				title: chatTitle,
				reason: "not-allowed"
			}, "skipping group message");
			return true;
		}
		return false;
	};
	const TELEGRAM_EVENT_AUTH_RULES = {
		reaction: {
			enforceDirectAuthorization: true,
			enforceGroupAllowlistAuthorization: false,
			deniedDmReason: "reaction unauthorized by dm policy/allowlist",
			deniedGroupReason: "reaction unauthorized by group allowlist"
		},
		"callback-scope": {
			enforceDirectAuthorization: false,
			enforceGroupAllowlistAuthorization: false,
			deniedDmReason: "callback unauthorized by inlineButtonsScope",
			deniedGroupReason: "callback unauthorized by inlineButtonsScope"
		},
		"callback-allowlist": {
			enforceDirectAuthorization: true,
			enforceGroupAllowlistAuthorization: false,
			deniedDmReason: "callback unauthorized by inlineButtonsScope allowlist",
			deniedGroupReason: "callback unauthorized by inlineButtonsScope allowlist"
		}
	};
	const resolveTelegramEventAuthorizationContext = async (params) => {
		const groupAllowContext = params.groupAllowContext ?? await resolveTelegramGroupAllowFromContext({
			chatId: params.chatId,
			accountId,
			isGroup: params.isGroup,
			isForum: params.isForum,
			messageThreadId: params.messageThreadId,
			groupAllowFrom,
			resolveTelegramGroupConfig
		});
		return {
			dmPolicy: !params.isGroup && groupAllowContext.groupConfig && "dmPolicy" in groupAllowContext.groupConfig ? groupAllowContext.groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing" : telegramCfg.dmPolicy ?? "pairing",
			...groupAllowContext
		};
	};
	const authorizeTelegramEventSender = (params) => {
		const { chatId, chatTitle, isGroup, senderId, senderUsername, mode, context } = params;
		const { dmPolicy, resolvedThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = context;
		const { enforceDirectAuthorization, enforceGroupAllowlistAuthorization, deniedDmReason, deniedGroupReason } = TELEGRAM_EVENT_AUTH_RULES[mode];
		if (shouldSkipGroupMessage({
			isGroup,
			chatId,
			chatTitle,
			resolvedThreadId,
			senderId,
			senderUsername,
			effectiveGroupAllow,
			hasGroupAllowOverride,
			groupConfig,
			topicConfig
		})) return {
			allowed: false,
			reason: "group-policy"
		};
		if (!isGroup && enforceDirectAuthorization) {
			if (dmPolicy === "disabled") {
				logVerbose(`Blocked telegram direct event from ${senderId || "unknown"} (${deniedDmReason})`);
				return {
					allowed: false,
					reason: "direct-disabled"
				};
			}
			if (dmPolicy !== "open") {
				if (!isAllowlistAuthorized(normalizeDmAllowFromWithStore({
					allowFrom: groupAllowOverride ?? allowFrom,
					storeAllowFrom,
					dmPolicy
				}), senderId, senderUsername)) {
					logVerbose(`Blocked telegram direct sender ${senderId || "unknown"} (${deniedDmReason})`);
					return {
						allowed: false,
						reason: "direct-unauthorized"
					};
				}
			}
		}
		if (isGroup && enforceGroupAllowlistAuthorization) {
			if (!isAllowlistAuthorized(effectiveGroupAllow, senderId, senderUsername)) {
				logVerbose(`Blocked telegram group sender ${senderId || "unknown"} (${deniedGroupReason})`);
				return {
					allowed: false,
					reason: "group-unauthorized"
				};
			}
		}
		return { allowed: true };
	};
	bot.on("message_reaction", async (ctx) => {
		try {
			const reaction = ctx.messageReaction;
			if (!reaction) return;
			if (shouldSkipUpdate(ctx)) return;
			const chatId = reaction.chat.id;
			const messageId = reaction.message_id;
			const user = reaction.user;
			const senderId = user?.id != null ? String(user.id) : "";
			const senderUsername = user?.username ?? "";
			const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
			const isForum = reaction.chat.is_forum === true;
			const reactionMode = telegramCfg.reactionNotifications ?? "own";
			if (reactionMode === "off") return;
			if (user?.is_bot) return;
			if (reactionMode === "own" && !wasSentByBot(chatId, messageId)) return;
			const eventAuthContext = await resolveTelegramEventAuthorizationContext({
				chatId,
				isGroup,
				isForum
			});
			if (!authorizeTelegramEventSender({
				chatId,
				chatTitle: reaction.chat.title,
				isGroup,
				senderId,
				senderUsername,
				mode: "reaction",
				context: eventAuthContext
			}).allowed) return;
			if (!isGroup) {
				if (eventAuthContext.groupConfig?.requireTopic === true) {
					logVerbose(`Blocked telegram reaction in DM ${chatId}: requireTopic=true but topic unknown for reactions`);
					return;
				}
			}
			const oldEmojis = new Set(reaction.old_reaction.filter((r) => r.type === "emoji").map((r) => r.emoji));
			const addedReactions = reaction.new_reaction.filter((r) => r.type === "emoji").filter((r) => !oldEmojis.has(r.emoji));
			if (addedReactions.length === 0) return;
			const senderName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username : void 0;
			const senderUsernameLabel = user?.username ? `@${user.username}` : void 0;
			let senderLabel = senderName;
			if (senderName && senderUsernameLabel) senderLabel = `${senderName} (${senderUsernameLabel})`;
			else if (!senderName && senderUsernameLabel) senderLabel = senderUsernameLabel;
			if (!senderLabel && user?.id) senderLabel = `id:${user.id}`;
			senderLabel = senderLabel || "unknown";
			const resolvedThreadId = isForum ? resolveTelegramForumThreadId({
				isForum,
				messageThreadId: void 0
			}) : void 0;
			const peerId = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : String(chatId);
			const parentPeer = buildTelegramParentPeer({
				isGroup,
				resolvedThreadId,
				chatId
			});
			const sessionKey = resolveAgentRoute({
				cfg: loadConfig(),
				channel: "telegram",
				accountId,
				peer: {
					kind: isGroup ? "group" : "direct",
					id: peerId
				},
				parentPeer
			}).sessionKey;
			for (const r of addedReactions) {
				const emoji = r.emoji;
				const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
				enqueueSystemEvent(text, {
					sessionKey,
					contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`
				});
				logVerbose(`telegram: reaction event enqueued: ${text}`);
			}
		} catch (err) {
			runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
		}
	});
	const processInboundMessage = async (params) => {
		const { ctx, msg, chatId, resolvedThreadId, dmThreadId, storeAllowFrom, sendOversizeWarning, oversizeLogMessage } = params;
		const text = typeof msg.text === "string" ? msg.text : void 0;
		const isCommandLike = (text ?? "").trim().startsWith("/");
		if (text && !isCommandLike) {
			const nowMs = Date.now();
			const senderId = msg.from?.id != null ? String(msg.from.id) : "unknown";
			const key = `text:${chatId}:${resolvedThreadId ?? dmThreadId ?? "main"}:${senderId}`;
			const existing = textFragmentBuffer.get(key);
			if (existing) {
				const last = existing.messages.at(-1);
				const lastMsgId = last?.msg.message_id;
				const lastReceivedAtMs = last?.receivedAtMs ?? nowMs;
				const idGap = typeof lastMsgId === "number" ? msg.message_id - lastMsgId : Infinity;
				const timeGapMs = nowMs - lastReceivedAtMs;
				if (idGap > 0 && idGap <= TELEGRAM_TEXT_FRAGMENT_MAX_ID_GAP && timeGapMs >= 0 && timeGapMs <= TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS) {
					const nextTotalChars = existing.messages.reduce((sum, m) => sum + (m.msg.text?.length ?? 0), 0) + text.length;
					if (existing.messages.length + 1 <= TELEGRAM_TEXT_FRAGMENT_MAX_PARTS && nextTotalChars <= TELEGRAM_TEXT_FRAGMENT_MAX_TOTAL_CHARS) {
						existing.messages.push({
							msg,
							ctx,
							receivedAtMs: nowMs
						});
						scheduleTextFragmentFlush(existing);
						return;
					}
				}
				clearTimeout(existing.timer);
				textFragmentBuffer.delete(key);
				textFragmentProcessing = textFragmentProcessing.then(async () => {
					await flushTextFragments(existing);
				}).catch(() => void 0);
				await textFragmentProcessing;
			}
			if (text.length >= TELEGRAM_TEXT_FRAGMENT_START_THRESHOLD_CHARS) {
				const entry = {
					key,
					messages: [{
						msg,
						ctx,
						receivedAtMs: nowMs
					}],
					timer: setTimeout(() => {}, TELEGRAM_TEXT_FRAGMENT_MAX_GAP_MS)
				};
				textFragmentBuffer.set(key, entry);
				scheduleTextFragmentFlush(entry);
				return;
			}
		}
		const mediaGroupId = msg.media_group_id;
		if (mediaGroupId) {
			const existing = mediaGroupBuffer.get(mediaGroupId);
			if (existing) {
				clearTimeout(existing.timer);
				existing.messages.push({
					msg,
					ctx
				});
				existing.timer = setTimeout(async () => {
					mediaGroupBuffer.delete(mediaGroupId);
					mediaGroupProcessing = mediaGroupProcessing.then(async () => {
						await processMediaGroup(existing);
					}).catch(() => void 0);
					await mediaGroupProcessing;
				}, mediaGroupTimeoutMs);
			} else {
				const entry = {
					messages: [{
						msg,
						ctx
					}],
					timer: setTimeout(async () => {
						mediaGroupBuffer.delete(mediaGroupId);
						mediaGroupProcessing = mediaGroupProcessing.then(async () => {
							await processMediaGroup(entry);
						}).catch(() => void 0);
						await mediaGroupProcessing;
					}, mediaGroupTimeoutMs)
				};
				mediaGroupBuffer.set(mediaGroupId, entry);
			}
			return;
		}
		let media = null;
		try {
			media = await resolveMedia(ctx, mediaMaxBytes, opts.token, telegramTransport);
		} catch (mediaErr) {
			if (isMediaSizeLimitError(mediaErr)) {
				if (sendOversizeWarning) {
					const limitMb = Math.round(mediaMaxBytes / (1024 * 1024));
					await withTelegramApiErrorLogging({
						operation: "sendMessage",
						runtime,
						fn: () => bot.api.sendMessage(chatId, `⚠️ File too large. Maximum size is ${limitMb}MB.`, { reply_to_message_id: msg.message_id })
					}).catch(() => {});
				}
				logger.warn({
					chatId,
					error: String(mediaErr)
				}, oversizeLogMessage);
				return;
			}
			logger.warn({
				chatId,
				error: String(mediaErr)
			}, "media fetch failed");
			await withTelegramApiErrorLogging({
				operation: "sendMessage",
				runtime,
				fn: () => bot.api.sendMessage(chatId, "⚠️ Failed to download media. Please try again.", { reply_to_message_id: msg.message_id })
			}).catch(() => {});
			return;
		}
		const hasText = Boolean(getTelegramTextParts(msg).text.trim());
		if (msg.sticker && !media && !hasText) {
			logVerbose("telegram: skipping sticker-only message (unsupported sticker type)");
			return;
		}
		const allMedia = media ? [{
			path: media.path,
			contentType: media.contentType,
			stickerMetadata: media.stickerMetadata
		}] : [];
		const senderId = msg.from?.id ? String(msg.from.id) : "";
		const conversationThreadId = resolvedThreadId ?? dmThreadId;
		const conversationKey = conversationThreadId != null ? `${chatId}:topic:${conversationThreadId}` : String(chatId);
		const debounceLane = resolveTelegramDebounceLane(msg);
		const debounceKey = senderId ? `telegram:${accountId ?? "default"}:${conversationKey}:${senderId}:${debounceLane}` : null;
		await inboundDebouncer.enqueue({
			ctx,
			msg,
			allMedia,
			storeAllowFrom,
			debounceKey,
			debounceLane,
			botUsername: ctx.me?.username
		});
	};
	bot.on("callback_query", async (ctx) => {
		const callback = ctx.callbackQuery;
		if (!callback) return;
		if (shouldSkipUpdate(ctx)) return;
		await withTelegramApiErrorLogging({
			operation: "answerCallbackQuery",
			runtime,
			fn: typeof ctx.answerCallbackQuery === "function" ? () => ctx.answerCallbackQuery() : () => bot.api.answerCallbackQuery(callback.id)
		}).catch(() => {});
		try {
			const data = (callback.data ?? "").trim();
			const callbackMessage = callback.message;
			if (!data || !callbackMessage) return;
			const editCallbackMessage = async (text, params) => {
				if (typeof ctx.editMessageText === "function") return await ctx.editMessageText(text, params);
				return await bot.api.editMessageText(callbackMessage.chat.id, callbackMessage.message_id, text, params);
			};
			const clearCallbackButtons = async () => {
				const replyMarkup = { reply_markup: { inline_keyboard: [] } };
				if (typeof ctx.editMessageReplyMarkup === "function") return await ctx.editMessageReplyMarkup(replyMarkup);
				if (typeof bot.api.editMessageReplyMarkup === "function") return await bot.api.editMessageReplyMarkup(callbackMessage.chat.id, callbackMessage.message_id, replyMarkup);
				const messageText = callbackMessage.text ?? callbackMessage.caption;
				if (typeof messageText !== "string" || messageText.trim().length === 0) return;
				return await editCallbackMessage(messageText, replyMarkup);
			};
			const editCallbackButtons = async (buttons) => {
				const replyMarkup = { reply_markup: buildInlineKeyboard(buttons) ?? { inline_keyboard: [] } };
				if (typeof ctx.editMessageReplyMarkup === "function") return await ctx.editMessageReplyMarkup(replyMarkup);
				return await bot.api.editMessageReplyMarkup(callbackMessage.chat.id, callbackMessage.message_id, replyMarkup);
			};
			const deleteCallbackMessage = async () => {
				if (typeof ctx.deleteMessage === "function") return await ctx.deleteMessage();
				return await bot.api.deleteMessage(callbackMessage.chat.id, callbackMessage.message_id);
			};
			const replyToCallbackChat = async (text, params) => {
				if (typeof ctx.reply === "function") return await ctx.reply(text, params);
				return await bot.api.sendMessage(callbackMessage.chat.id, text, params);
			};
			const chatId = callbackMessage.chat.id;
			const isGroup = callbackMessage.chat.type === "group" || callbackMessage.chat.type === "supergroup";
			const isApprovalCallback = APPROVE_CALLBACK_DATA_RE.test(data);
			const inlineButtonsScope = resolveTelegramInlineButtonsScope({
				cfg,
				accountId
			});
			const execApprovalButtonsEnabled = isApprovalCallback && shouldEnableTelegramExecApprovalButtons({
				cfg,
				accountId,
				to: String(chatId)
			});
			if (!execApprovalButtonsEnabled) {
				if (inlineButtonsScope === "off") return;
				if (inlineButtonsScope === "dm" && isGroup) return;
				if (inlineButtonsScope === "group" && !isGroup) return;
			}
			const messageThreadId = callbackMessage.message_thread_id;
			const isForum = callbackMessage.chat.is_forum === true;
			const eventAuthContext = await resolveTelegramEventAuthorizationContext({
				chatId,
				isGroup,
				isForum,
				messageThreadId
			});
			const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig } = eventAuthContext;
			const requireTopic = groupConfig?.requireTopic;
			if (!isGroup && requireTopic === true && dmThreadId == null) {
				logVerbose(`Blocked telegram callback in DM ${chatId}: requireTopic=true but no topic present`);
				return;
			}
			const senderId = callback.from?.id ? String(callback.from.id) : "";
			const senderUsername = callback.from?.username ?? "";
			const authorizationMode = !execApprovalButtonsEnabled && inlineButtonsScope === "allowlist" ? "callback-allowlist" : "callback-scope";
			if (!authorizeTelegramEventSender({
				chatId,
				chatTitle: callbackMessage.chat.title,
				isGroup,
				senderId,
				senderUsername,
				mode: authorizationMode,
				context: eventAuthContext
			}).allowed) return;
			const callbackConversationId = messageThreadId != null ? `${chatId}:topic:${messageThreadId}` : String(chatId);
			const pluginBindingApproval = parsePluginBindingApprovalCustomId(data);
			if (pluginBindingApproval) {
				const resolved = await resolvePluginConversationBindingApproval({
					approvalId: pluginBindingApproval.approvalId,
					decision: pluginBindingApproval.decision,
					senderId: senderId || void 0
				});
				await clearCallbackButtons();
				await replyToCallbackChat(buildPluginBindingResolvedText(resolved));
				return;
			}
			if ((await dispatchPluginInteractiveHandler({
				channel: "telegram",
				data,
				callbackId: callback.id,
				ctx: {
					accountId,
					callbackId: callback.id,
					conversationId: callbackConversationId,
					parentConversationId: messageThreadId != null ? String(chatId) : void 0,
					senderId: senderId || void 0,
					senderUsername: senderUsername || void 0,
					threadId: messageThreadId,
					isGroup,
					isForum,
					auth: { isAuthorizedSender: true },
					callbackMessage: {
						messageId: callbackMessage.message_id,
						chatId: String(chatId),
						messageText: callbackMessage.text ?? callbackMessage.caption
					}
				},
				respond: {
					reply: async ({ text, buttons }) => {
						await replyToCallbackChat(text, buttons ? { reply_markup: buildInlineKeyboard(buttons) } : void 0);
					},
					editMessage: async ({ text, buttons }) => {
						await editCallbackMessage(text, buttons ? { reply_markup: buildInlineKeyboard(buttons) } : void 0);
					},
					editButtons: async ({ buttons }) => {
						await editCallbackButtons(buttons);
					},
					clearButtons: async () => {
						await clearCallbackButtons();
					},
					deleteMessage: async () => {
						await deleteCallbackMessage();
					}
				}
			})).handled) return;
			if (isApprovalCallback) {
				if (!isTelegramExecApprovalClientEnabled({
					cfg,
					accountId
				}) || !isTelegramExecApprovalApprover({
					cfg,
					accountId,
					senderId
				})) {
					logVerbose(`Blocked telegram exec approval callback from ${senderId || "unknown"} (not an approver)`);
					return;
				}
				try {
					await clearCallbackButtons();
				} catch (editErr) {
					const errStr = String(editErr);
					if (!errStr.includes("message is not modified") && !errStr.includes("there is no text in the message to edit")) logVerbose(`telegram: failed to clear approval callback buttons: ${errStr}`);
				}
			}
			const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
			if (paginationMatch) {
				const pageValue = paginationMatch[1];
				if (pageValue === "noop") return;
				const page = Number.parseInt(pageValue, 10);
				if (Number.isNaN(page) || page < 1) return;
				const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(cfg);
				const result = buildCommandsMessagePaginated(cfg, listSkillCommandsForAgents({
					cfg,
					agentIds: [agentId]
				}), {
					page,
					surface: "telegram"
				});
				const keyboard = result.totalPages > 1 ? buildInlineKeyboard(buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId)) : void 0;
				try {
					await editCallbackMessage(result.text, keyboard ? { reply_markup: keyboard } : void 0);
				} catch (editErr) {
					if (!String(editErr).includes("message is not modified")) throw editErr;
				}
				return;
			}
			const modelCallback = parseModelCallbackData(data);
			if (modelCallback) {
				const sessionState = resolveTelegramSessionState({
					chatId,
					isGroup,
					isForum,
					messageThreadId,
					resolvedThreadId,
					senderId
				});
				const { byProvider, providers } = await buildModelsProviderData(cfg, sessionState.agentId);
				const editMessageWithButtons = async (text, buttons) => {
					const keyboard = buildInlineKeyboard(buttons);
					try {
						await editCallbackMessage(text, keyboard ? { reply_markup: keyboard } : void 0);
					} catch (editErr) {
						const errStr = String(editErr);
						if (errStr.includes("no text in the message")) {
							try {
								await deleteCallbackMessage();
							} catch {}
							await replyToCallbackChat(text, keyboard ? { reply_markup: keyboard } : void 0);
						} else if (!errStr.includes("message is not modified")) throw editErr;
					}
				};
				if (modelCallback.type === "providers" || modelCallback.type === "back") {
					if (providers.length === 0) {
						await editMessageWithButtons("No providers available.", []);
						return;
					}
					await editMessageWithButtons("Select a provider:", buildProviderKeyboard(providers.map((p) => ({
						id: p,
						count: byProvider.get(p)?.size ?? 0
					}))));
					return;
				}
				if (modelCallback.type === "list") {
					const { provider, page } = modelCallback;
					const modelSet = byProvider.get(provider);
					if (!modelSet || modelSet.size === 0) {
						const buttons = buildProviderKeyboard(providers.map((p) => ({
							id: p,
							count: byProvider.get(p)?.size ?? 0
						})));
						await editMessageWithButtons(`Unknown provider: ${provider}\n\nSelect a provider:`, buttons);
						return;
					}
					const models = [...modelSet].toSorted();
					const pageSize = getModelsPageSize();
					const totalPages = calculateTotalPages(models.length, pageSize);
					const safePage = Math.max(1, Math.min(page, totalPages));
					const currentSessionState = resolveTelegramSessionState({
						chatId,
						isGroup,
						isForum,
						messageThreadId,
						resolvedThreadId,
						senderId
					});
					const currentModel = currentSessionState.model;
					const buttons = buildModelsKeyboard({
						provider,
						models,
						currentModel,
						currentPage: safePage,
						totalPages,
						pageSize
					});
					await editMessageWithButtons(formatModelsAvailableHeader({
						provider,
						total: models.length,
						cfg,
						agentDir: resolveAgentDir(cfg, currentSessionState.agentId),
						sessionEntry: currentSessionState.sessionEntry
					}), buttons);
					return;
				}
				if (modelCallback.type === "select") {
					const selection = resolveModelSelection({
						callback: modelCallback,
						providers,
						byProvider
					});
					if (selection.kind !== "resolved") {
						const buttons = buildProviderKeyboard(providers.map((p) => ({
							id: p,
							count: byProvider.get(p)?.size ?? 0
						})));
						await editMessageWithButtons(`Could not resolve model "${selection.model}".\n\nSelect a provider:`, buttons);
						return;
					}
					if (!byProvider.get(selection.provider)?.has(selection.model)) {
						await editMessageWithButtons(`❌ Model "${selection.provider}/${selection.model}" is not allowed.`, []);
						return;
					}
					try {
						const storePath = resolveStorePath(cfg.session?.store, { agentId: sessionState.agentId });
						const resolvedDefault = resolveDefaultModelForAgent({
							cfg,
							agentId: sessionState.agentId
						});
						const isDefaultSelection = selection.provider === resolvedDefault.provider && selection.model === resolvedDefault.model;
						await updateSessionStore(storePath, (store) => {
							const sessionKey = sessionState.sessionKey;
							const entry = store[sessionKey] ?? {};
							store[sessionKey] = entry;
							applyModelOverrideToSessionEntry({
								entry,
								selection: {
									provider: selection.provider,
									model: selection.model,
									isDefault: isDefaultSelection
								}
							});
						});
						await editMessageWithButtons(`✅ Model ${isDefaultSelection ? "reset to default" : `changed to **${selection.provider}/${selection.model}**`}\n\nThis model will be used for your next message.`, []);
					} catch (err) {
						await editMessageWithButtons(`❌ Failed to change model: ${String(err)}`, []);
					}
					return;
				}
				return;
			}
			await processMessage(buildSyntheticContext(ctx, buildSyntheticTextMessage({
				base: callbackMessage,
				from: callback.from,
				text: data
			})), [], storeAllowFrom, {
				forceWasMentioned: true,
				messageIdOverride: callback.id
			});
		} catch (err) {
			runtime.error?.(danger(`callback handler failed: ${String(err)}`));
		}
	});
	bot.on("message:migrate_to_chat_id", async (ctx) => {
		try {
			const msg = ctx.message;
			if (!msg?.migrate_to_chat_id) return;
			if (shouldSkipUpdate(ctx)) return;
			const oldChatId = String(msg.chat.id);
			const newChatId = String(msg.migrate_to_chat_id);
			const chatTitle = msg.chat.title ?? "Unknown";
			runtime.log?.(warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`));
			if (!resolveChannelConfigWrites({
				cfg,
				channelId: "telegram",
				accountId
			})) {
				runtime.log?.(warn("[telegram] Config writes disabled; skipping group config migration."));
				return;
			}
			const currentConfig = loadConfig();
			const migration = migrateTelegramGroupConfig({
				cfg: currentConfig,
				accountId,
				oldChatId,
				newChatId
			});
			if (migration.migrated) {
				runtime.log?.(warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`));
				migrateTelegramGroupConfig({
					cfg,
					accountId,
					oldChatId,
					newChatId
				});
				await writeConfigFile(currentConfig);
				runtime.log?.(warn(`[telegram] Group config migrated and saved successfully`));
			} else if (migration.skippedExisting) runtime.log?.(warn(`[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`));
			else runtime.log?.(warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`));
		} catch (err) {
			runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
		}
	});
	const handleInboundMessageLike = async (event) => {
		try {
			if (shouldSkipUpdate(event.ctxForDedupe)) return;
			const { dmPolicy, resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = await resolveTelegramEventAuthorizationContext({
				chatId: event.chatId,
				isGroup: event.isGroup,
				isForum: event.isForum,
				messageThreadId: event.messageThreadId
			});
			const effectiveDmAllow = normalizeDmAllowFromWithStore({
				allowFrom: groupAllowOverride ?? allowFrom,
				storeAllowFrom,
				dmPolicy
			});
			if (event.requireConfiguredGroup && (!groupConfig || groupConfig.enabled === false)) {
				logVerbose(`Blocked telegram channel ${event.chatId} (channel disabled)`);
				return;
			}
			if (shouldSkipGroupMessage({
				isGroup: event.isGroup,
				chatId: event.chatId,
				chatTitle: event.msg.chat.title,
				resolvedThreadId,
				senderId: event.senderId,
				senderUsername: event.senderUsername,
				effectiveGroupAllow,
				hasGroupAllowOverride,
				groupConfig,
				topicConfig
			})) return;
			if (!event.isGroup && (hasInboundMedia(event.msg) || hasReplyTargetMedia(event.msg))) {
				if (!await enforceTelegramDmAccess({
					isGroup: event.isGroup,
					dmPolicy,
					msg: event.msg,
					chatId: event.chatId,
					effectiveDmAllow,
					accountId,
					bot,
					logger
				})) return;
			}
			await processInboundMessage({
				ctx: event.ctx,
				msg: event.msg,
				chatId: event.chatId,
				resolvedThreadId,
				dmThreadId,
				storeAllowFrom,
				sendOversizeWarning: event.sendOversizeWarning,
				oversizeLogMessage: event.oversizeLogMessage
			});
		} catch (err) {
			runtime.error?.(danger(`${event.errorMessage}: ${String(err)}`));
		}
	};
	bot.on("message", async (ctx) => {
		const msg = ctx.message;
		if (!msg) return;
		await handleInboundMessageLike({
			ctxForDedupe: ctx,
			ctx: buildSyntheticContext(ctx, msg),
			msg,
			chatId: msg.chat.id,
			isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
			isForum: msg.chat.is_forum === true,
			messageThreadId: msg.message_thread_id,
			senderId: msg.from?.id != null ? String(msg.from.id) : "",
			senderUsername: msg.from?.username ?? "",
			requireConfiguredGroup: false,
			sendOversizeWarning: true,
			oversizeLogMessage: "media exceeds size limit",
			errorMessage: "handler failed"
		});
	});
	bot.on("channel_post", async (ctx) => {
		const post = ctx.channelPost;
		if (!post) return;
		const chatId = post.chat.id;
		const syntheticFrom = post.sender_chat ? {
			id: post.sender_chat.id,
			is_bot: true,
			first_name: post.sender_chat.title || "Channel",
			username: post.sender_chat.username
		} : {
			id: chatId,
			is_bot: true,
			first_name: post.chat.title || "Channel",
			username: post.chat.username
		};
		const syntheticMsg = {
			...post,
			from: post.from ?? syntheticFrom,
			chat: {
				...post.chat,
				type: "supergroup"
			}
		};
		await handleInboundMessageLike({
			ctxForDedupe: ctx,
			ctx: buildSyntheticContext(ctx, syntheticMsg),
			msg: syntheticMsg,
			chatId,
			isGroup: true,
			isForum: false,
			senderId: post.sender_chat?.id != null ? String(post.sender_chat.id) : post.from?.id != null ? String(post.from.id) : "",
			senderUsername: post.sender_chat?.username ?? post.from?.username ?? "",
			requireConfiguredGroup: true,
			sendOversizeWarning: false,
			oversizeLogMessage: "channel post media exceeds size limit",
			errorMessage: "channel_post handler failed"
		});
	});
};
//#endregion
//#region extensions/telegram/src/forum-service-message.ts
/** Telegram forum-topic service-message fields (Bot API). */
const TELEGRAM_FORUM_SERVICE_FIELDS = [
	"forum_topic_created",
	"forum_topic_edited",
	"forum_topic_closed",
	"forum_topic_reopened",
	"general_forum_topic_hidden",
	"general_forum_topic_unhidden"
];
/**
* Returns `true` when the message is a Telegram forum service message (e.g.
* "Topic created"). These auto-generated messages carry one of the
* `forum_topic_*` / `general_forum_topic_*` fields and should not count as
* regular bot replies for implicit-mention purposes.
*/
function isTelegramForumServiceMessage(msg) {
	if (!msg || typeof msg !== "object") return false;
	const record = msg;
	return TELEGRAM_FORUM_SERVICE_FIELDS.some((field) => record[field] != null);
}
//#endregion
//#region extensions/telegram/src/bot-message-context.body.ts
init_globals();
async function resolveStickerVisionSupport$1(params) {
	try {
		const catalog = await loadModelCatalog({ config: params.cfg });
		const defaultModel = resolveDefaultModelForAgent({
			cfg: params.cfg,
			agentId: params.agentId
		});
		const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
		if (!entry) return false;
		return modelSupportsVision(entry);
	} catch {
		return false;
	}
}
async function resolveTelegramInboundBody(params) {
	const { cfg, primaryCtx, msg, allMedia, isGroup, chatId, senderId, senderUsername, resolvedThreadId, routeAgentId, effectiveGroupAllow, effectiveDmAllow, groupConfig, topicConfig, requireMention, options, groupHistories, historyLimit, logger } = params;
	const botUsername = primaryCtx.me?.username?.toLowerCase();
	const mentionRegexes = buildMentionRegexes(cfg, routeAgentId);
	const messageTextParts = getTelegramTextParts(msg);
	const allowForCommands = isGroup ? effectiveGroupAllow : effectiveDmAllow;
	const senderAllowedForCommands = isSenderAllowed({
		allow: allowForCommands,
		senderId,
		senderUsername
	});
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const hasControlCommandInMessage = hasControlCommand(messageTextParts.text, cfg, { botUsername });
	const commandGate = resolveControlCommandGate({
		useAccessGroups,
		authorizers: [{
			configured: allowForCommands.hasEntries,
			allowed: senderAllowedForCommands
		}],
		allowTextCommands: true,
		hasControlCommand: hasControlCommandInMessage
	});
	const commandAuthorized = commandGate.commandAuthorized;
	const historyKey = isGroup ? buildTelegramGroupPeerId(chatId, resolvedThreadId) : void 0;
	let placeholder = resolveTelegramMediaPlaceholder(msg) ?? "";
	const cachedStickerDescription = allMedia[0]?.stickerMetadata?.cachedDescription;
	const stickerSupportsVision = msg.sticker ? await resolveStickerVisionSupport$1({
		cfg,
		agentId: routeAgentId
	}) : false;
	const stickerCacheHit = Boolean(cachedStickerDescription) && !stickerSupportsVision;
	if (stickerCacheHit) {
		const emoji = allMedia[0]?.stickerMetadata?.emoji;
		const setName = allMedia[0]?.stickerMetadata?.setName;
		const stickerContext = [emoji, setName ? `from "${setName}"` : null].filter(Boolean).join(" ");
		placeholder = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${cachedStickerDescription}`;
	}
	const locationData = extractTelegramLocation(msg);
	const locationText = locationData ? formatLocationText(locationData) : void 0;
	const rawText = expandTextLinks(messageTextParts.text, messageTextParts.entities).trim();
	const hasUserText = Boolean(rawText || locationText);
	let rawBody = [rawText, locationText].filter(Boolean).join("\n").trim();
	if (!rawBody) rawBody = placeholder;
	if (!rawBody && allMedia.length === 0) return null;
	let bodyText = rawBody;
	const hasAudio = allMedia.some((media) => media.contentType?.startsWith("audio/"));
	const disableAudioPreflight = (topicConfig?.disableAudioPreflight ?? groupConfig?.disableAudioPreflight) === true;
	let preflightTranscript;
	if (isGroup && requireMention && hasAudio && !hasUserText && mentionRegexes.length > 0 && !disableAudioPreflight) try {
		const { transcribeFirstAudio } = await import("./audio-preflight-Cm_5btQa.js");
		preflightTranscript = await transcribeFirstAudio({
			ctx: {
				MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : void 0,
				MediaTypes: allMedia.length > 0 ? allMedia.map((m) => m.contentType).filter(Boolean) : void 0
			},
			cfg,
			agentDir: void 0
		});
	} catch (err) {
		logVerbose(`telegram: audio preflight transcription failed: ${String(err)}`);
	}
	if (hasAudio && bodyText === "<media:audio>" && preflightTranscript) bodyText = preflightTranscript;
	if (!bodyText && allMedia.length > 0) if (hasAudio) bodyText = preflightTranscript || "<media:audio>";
	else bodyText = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
	const hasAnyMention = messageTextParts.entities.some((ent) => ent.type === "mention");
	const explicitlyMentioned = botUsername ? hasBotMention(msg, botUsername) : false;
	const computedWasMentioned = matchesMentionWithExplicit({
		text: messageTextParts.text,
		mentionRegexes,
		explicit: {
			hasAnyMention,
			isExplicitlyMentioned: explicitlyMentioned,
			canResolveExplicit: Boolean(botUsername)
		},
		transcript: preflightTranscript
	});
	const wasMentioned = options?.forceWasMentioned === true ? true : computedWasMentioned;
	if (isGroup && commandGate.shouldBlock) {
		logInboundDrop({
			log: logVerbose,
			channel: "telegram",
			reason: "control command (unauthorized)",
			target: senderId ?? "unknown"
		});
		return null;
	}
	const botId = primaryCtx.me?.id;
	const replyFromId = msg.reply_to_message?.from?.id;
	const replyToBotMessage = botId != null && replyFromId === botId;
	const isReplyToServiceMessage = replyToBotMessage && isTelegramForumServiceMessage(msg.reply_to_message);
	const implicitMention = replyToBotMessage && !isReplyToServiceMessage;
	const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
	const mentionGate = resolveMentionGatingWithBypass({
		isGroup,
		requireMention: Boolean(requireMention),
		canDetectMention,
		wasMentioned,
		implicitMention: isGroup && Boolean(requireMention) && implicitMention,
		hasAnyMention,
		allowTextCommands: true,
		hasControlCommand: hasControlCommandInMessage,
		commandAuthorized
	});
	const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
	if (isGroup && requireMention && canDetectMention && mentionGate.shouldSkip) {
		logger.info({
			chatId,
			reason: "no-mention"
		}, "skipping group message");
		recordPendingHistoryEntryIfEnabled({
			historyMap: groupHistories,
			historyKey: historyKey ?? "",
			limit: historyLimit,
			entry: historyKey ? {
				sender: buildSenderLabel(msg, senderId || chatId),
				body: rawBody,
				timestamp: msg.date ? msg.date * 1e3 : void 0,
				messageId: typeof msg.message_id === "number" ? String(msg.message_id) : void 0
			} : null
		});
		return null;
	}
	return {
		bodyText,
		rawBody,
		historyKey,
		commandAuthorized,
		effectiveWasMentioned,
		canDetectMention,
		shouldBypassMention: mentionGate.shouldBypassMention,
		stickerCacheHit,
		locationData: locationData ?? void 0
	};
}
//#endregion
//#region extensions/telegram/src/group-config-helpers.ts
function resolveTelegramGroupPromptSettings(params) {
	const skillFilter = firstDefined(params.topicConfig?.skills, params.groupConfig?.skills);
	const systemPromptParts = [params.groupConfig?.systemPrompt?.trim() || null, params.topicConfig?.systemPrompt?.trim() || null].filter((entry) => Boolean(entry));
	return {
		skillFilter,
		groupSystemPrompt: systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : void 0
	};
}
//#endregion
//#region extensions/telegram/src/bot-message-context.session.ts
init_globals();
async function buildTelegramInboundContextPayload(params) {
	const { cfg, primaryCtx, msg, allMedia, replyMedia, isGroup, isForum, chatId, senderId, senderUsername, resolvedThreadId, dmThreadId, threadSpec, route, rawBody, bodyText, historyKey, historyLimit, groupHistories, groupConfig, topicConfig, stickerCacheHit, effectiveWasMentioned, commandAuthorized, locationData, options, dmAllowFrom } = params;
	const replyTarget = describeReplyTarget(msg);
	const forwardOrigin = normalizeForwardedContext(msg);
	const replyForwardAnnotation = replyTarget?.forwardedFrom ? `[Forwarded from ${replyTarget.forwardedFrom.from}${replyTarget.forwardedFrom.date ? ` at ${(/* @__PURE__ */ new Date(replyTarget.forwardedFrom.date * 1e3)).toISOString()}` : ""}]\n` : "";
	const replySuffix = replyTarget ? replyTarget.kind === "quote" ? `\n\n[Quoting ${replyTarget.sender}${replyTarget.id ? ` id:${replyTarget.id}` : ""}]\n${replyForwardAnnotation}"${replyTarget.body}"\n[/Quoting]` : `\n\n[Replying to ${replyTarget.sender}${replyTarget.id ? ` id:${replyTarget.id}` : ""}]\n${replyForwardAnnotation}${replyTarget.body}\n[/Replying]` : "";
	const forwardPrefix = forwardOrigin ? `[Forwarded from ${forwardOrigin.from}${forwardOrigin.date ? ` at ${(/* @__PURE__ */ new Date(forwardOrigin.date * 1e3)).toISOString()}` : ""}]\n` : "";
	const groupLabel = isGroup ? buildGroupLabel(msg, chatId, resolvedThreadId) : void 0;
	const senderName = buildSenderName(msg);
	const conversationLabel = isGroup ? groupLabel ?? `group:${chatId}` : buildSenderLabel(msg, senderId || chatId);
	const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
	const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
	const previousTimestamp = readSessionUpdatedAt({
		storePath,
		sessionKey: route.sessionKey
	});
	const body = formatInboundEnvelope({
		channel: "Telegram",
		from: conversationLabel,
		timestamp: msg.date ? msg.date * 1e3 : void 0,
		body: `${forwardPrefix}${bodyText}${replySuffix}`,
		chatType: isGroup ? "group" : "direct",
		sender: {
			name: senderName,
			username: senderUsername || void 0,
			id: senderId || void 0
		},
		previousTimestamp,
		envelope: envelopeOptions
	});
	let combinedBody = body;
	if (isGroup && historyKey && historyLimit > 0) combinedBody = buildPendingHistoryContextFromMap({
		historyMap: groupHistories,
		historyKey,
		limit: historyLimit,
		currentMessage: combinedBody,
		formatEntry: (entry) => formatInboundEnvelope({
			channel: "Telegram",
			from: groupLabel ?? `group:${chatId}`,
			timestamp: entry.timestamp,
			body: `${entry.body} [id:${entry.messageId ?? "unknown"} chat:${chatId}]`,
			chatType: "group",
			senderLabel: entry.sender,
			envelope: envelopeOptions
		})
	});
	const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
		groupConfig,
		topicConfig
	});
	const commandBody = normalizeCommandBody(rawBody, { botUsername: primaryCtx.me?.username?.toLowerCase() });
	const inboundHistory = isGroup && historyKey && historyLimit > 0 ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
		sender: entry.sender,
		body: entry.body,
		timestamp: entry.timestamp
	})) : void 0;
	const contextMedia = [...stickerCacheHit ? [] : allMedia, ...replyMedia];
	const ctxPayload = finalizeInboundContext({
		Body: combinedBody,
		BodyForAgent: bodyText,
		InboundHistory: inboundHistory,
		RawBody: rawBody,
		CommandBody: commandBody,
		From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
		To: `telegram:${chatId}`,
		SessionKey: route.sessionKey,
		AccountId: route.accountId,
		ChatType: isGroup ? "group" : "direct",
		ConversationLabel: conversationLabel,
		GroupSubject: isGroup ? msg.chat.title ?? void 0 : void 0,
		GroupSystemPrompt: isGroup || !isGroup && groupConfig ? groupSystemPrompt : void 0,
		SenderName: senderName,
		SenderId: senderId || void 0,
		SenderUsername: senderUsername || void 0,
		Provider: "telegram",
		Surface: "telegram",
		BotUsername: primaryCtx.me?.username ?? void 0,
		MessageSid: options?.messageIdOverride ?? String(msg.message_id),
		ReplyToId: replyTarget?.id,
		ReplyToBody: replyTarget?.body,
		ReplyToSender: replyTarget?.sender,
		ReplyToIsQuote: replyTarget?.kind === "quote" ? true : void 0,
		ReplyToForwardedFrom: replyTarget?.forwardedFrom?.from,
		ReplyToForwardedFromType: replyTarget?.forwardedFrom?.fromType,
		ReplyToForwardedFromId: replyTarget?.forwardedFrom?.fromId,
		ReplyToForwardedFromUsername: replyTarget?.forwardedFrom?.fromUsername,
		ReplyToForwardedFromTitle: replyTarget?.forwardedFrom?.fromTitle,
		ReplyToForwardedDate: replyTarget?.forwardedFrom?.date ? replyTarget.forwardedFrom.date * 1e3 : void 0,
		ForwardedFrom: forwardOrigin?.from,
		ForwardedFromType: forwardOrigin?.fromType,
		ForwardedFromId: forwardOrigin?.fromId,
		ForwardedFromUsername: forwardOrigin?.fromUsername,
		ForwardedFromTitle: forwardOrigin?.fromTitle,
		ForwardedFromSignature: forwardOrigin?.fromSignature,
		ForwardedFromChatType: forwardOrigin?.fromChatType,
		ForwardedFromMessageId: forwardOrigin?.fromMessageId,
		ForwardedDate: forwardOrigin?.date ? forwardOrigin.date * 1e3 : void 0,
		Timestamp: msg.date ? msg.date * 1e3 : void 0,
		WasMentioned: isGroup ? effectiveWasMentioned : void 0,
		MediaPath: contextMedia.length > 0 ? contextMedia[0]?.path : void 0,
		MediaType: contextMedia.length > 0 ? contextMedia[0]?.contentType : void 0,
		MediaUrl: contextMedia.length > 0 ? contextMedia[0]?.path : void 0,
		MediaPaths: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : void 0,
		MediaUrls: contextMedia.length > 0 ? contextMedia.map((m) => m.path) : void 0,
		MediaTypes: contextMedia.length > 0 ? contextMedia.map((m) => m.contentType).filter(Boolean) : void 0,
		Sticker: allMedia[0]?.stickerMetadata,
		StickerMediaIncluded: allMedia[0]?.stickerMetadata ? !stickerCacheHit : void 0,
		...locationData ? toLocationContext(locationData) : void 0,
		CommandAuthorized: commandAuthorized,
		MessageThreadId: threadSpec.id,
		IsForum: isForum,
		OriginatingChannel: "telegram",
		OriginatingTo: `telegram:${chatId}`
	});
	const pinnedMainDmOwner = !isGroup ? resolvePinnedMainDmOwnerFromAllowlist({
		dmScope: cfg.session?.dmScope,
		allowFrom: dmAllowFrom,
		normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0]
	}) : null;
	const updateLastRouteSessionKey = resolveInboundLastRouteSessionKey({
		route,
		sessionKey: route.sessionKey
	});
	await recordInboundSession({
		storePath,
		sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
		ctx: ctxPayload,
		updateLastRoute: !isGroup ? {
			sessionKey: updateLastRouteSessionKey,
			channel: "telegram",
			to: `telegram:${chatId}`,
			accountId: route.accountId,
			threadId: dmThreadId != null ? String(dmThreadId) : void 0,
			mainDmOwnerPin: updateLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner && senderId ? {
				ownerRecipient: pinnedMainDmOwner,
				senderRecipient: senderId,
				onSkip: ({ ownerRecipient, senderRecipient }) => {
					logVerbose(`telegram: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
				}
			} : void 0
		} : void 0,
		onRecordError: (err) => {
			logVerbose(`telegram: failed updating session meta: ${String(err)}`);
		}
	});
	if (replyTarget && shouldLogVerbose()) {
		const preview = replyTarget.body.replace(/\s+/g, " ").slice(0, 120);
		logVerbose(`telegram reply-context: replyToId=${replyTarget.id} replyToSender=${replyTarget.sender} replyToBody="${preview}"`);
	}
	if (forwardOrigin && shouldLogVerbose()) logVerbose(`telegram forward-context: forwardedFrom="${forwardOrigin.from}" type=${forwardOrigin.fromType}`);
	if (shouldLogVerbose()) {
		const preview = body.slice(0, 200).replace(/\n/g, "\\n");
		const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
		const topicInfo = resolvedThreadId != null ? ` topic=${resolvedThreadId}` : "";
		logVerbose(`telegram inbound: chatId=${chatId} from=${ctxPayload.From} len=${body.length}${mediaInfo}${topicInfo} preview="${preview}"`);
	}
	return {
		ctxPayload,
		skillFilter
	};
}
//#endregion
//#region extensions/telegram/src/status-reaction-variants.ts
const TELEGRAM_GENERIC_REACTION_FALLBACKS = [
	"👍",
	"👀",
	"🔥"
];
const TELEGRAM_SUPPORTED_REACTION_EMOJIS = new Set([
	"❤",
	"👍",
	"👎",
	"🔥",
	"🥰",
	"👏",
	"😁",
	"🤔",
	"🤯",
	"😱",
	"🤬",
	"😢",
	"🎉",
	"🤩",
	"🤮",
	"💩",
	"🙏",
	"👌",
	"🕊",
	"🤡",
	"🥱",
	"🥴",
	"😍",
	"🐳",
	"❤‍🔥",
	"🌚",
	"🌭",
	"💯",
	"🤣",
	"⚡",
	"🍌",
	"🏆",
	"💔",
	"🤨",
	"😐",
	"🍓",
	"🍾",
	"💋",
	"🖕",
	"😈",
	"😴",
	"😭",
	"🤓",
	"👻",
	"👨‍💻",
	"👀",
	"🎃",
	"🙈",
	"😇",
	"😨",
	"🤝",
	"✍",
	"🤗",
	"🫡",
	"🎅",
	"🎄",
	"☃",
	"💅",
	"🤪",
	"🗿",
	"🆒",
	"💘",
	"🙉",
	"🦄",
	"😘",
	"💊",
	"🙊",
	"😎",
	"👾",
	"🤷‍♂",
	"🤷",
	"🤷‍♀",
	"😡"
]);
const TELEGRAM_STATUS_REACTION_VARIANTS = {
	queued: [
		"👀",
		"👍",
		"🔥"
	],
	thinking: [
		"🤔",
		"🤓",
		"👀"
	],
	tool: [
		"🔥",
		"⚡",
		"👍"
	],
	coding: [
		"👨‍💻",
		"🔥",
		"⚡"
	],
	web: [
		"⚡",
		"🔥",
		"👍"
	],
	done: [
		"👍",
		"🎉",
		"💯"
	],
	error: [
		"😱",
		"😨",
		"🤯"
	],
	stallSoft: [
		"🥱",
		"😴",
		"🤔"
	],
	stallHard: [
		"😨",
		"😱",
		"⚡"
	],
	compacting: [
		"✍",
		"🤔",
		"🤯"
	]
};
const STATUS_REACTION_EMOJI_KEYS = [
	"queued",
	"thinking",
	"tool",
	"coding",
	"web",
	"done",
	"error",
	"stallSoft",
	"stallHard",
	"compacting"
];
function normalizeEmoji(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function toUniqueNonEmpty(values) {
	return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
function resolveTelegramStatusReactionEmojis(params) {
	const { overrides } = params;
	const queuedFallback = normalizeEmoji(params.initialEmoji) ?? DEFAULT_EMOJIS.queued;
	return {
		queued: normalizeEmoji(overrides?.queued) ?? queuedFallback,
		thinking: normalizeEmoji(overrides?.thinking) ?? DEFAULT_EMOJIS.thinking,
		tool: normalizeEmoji(overrides?.tool) ?? DEFAULT_EMOJIS.tool,
		coding: normalizeEmoji(overrides?.coding) ?? DEFAULT_EMOJIS.coding,
		web: normalizeEmoji(overrides?.web) ?? DEFAULT_EMOJIS.web,
		done: normalizeEmoji(overrides?.done) ?? DEFAULT_EMOJIS.done,
		error: normalizeEmoji(overrides?.error) ?? DEFAULT_EMOJIS.error,
		stallSoft: normalizeEmoji(overrides?.stallSoft) ?? DEFAULT_EMOJIS.stallSoft,
		stallHard: normalizeEmoji(overrides?.stallHard) ?? DEFAULT_EMOJIS.stallHard,
		compacting: normalizeEmoji(overrides?.compacting) ?? DEFAULT_EMOJIS.compacting
	};
}
function buildTelegramStatusReactionVariants(emojis) {
	const variantsByRequested = /* @__PURE__ */ new Map();
	for (const key of STATUS_REACTION_EMOJI_KEYS) {
		const requested = normalizeEmoji(emojis[key]);
		if (!requested) continue;
		const candidates = toUniqueNonEmpty([requested, ...TELEGRAM_STATUS_REACTION_VARIANTS[key] ?? []]);
		variantsByRequested.set(requested, candidates);
	}
	return variantsByRequested;
}
function isTelegramSupportedReactionEmoji(emoji) {
	return TELEGRAM_SUPPORTED_REACTION_EMOJIS.has(emoji);
}
function extractTelegramAllowedEmojiReactions(chat) {
	if (!chat || typeof chat !== "object") return;
	if (!Object.prototype.hasOwnProperty.call(chat, "available_reactions")) return;
	const availableReactions = chat.available_reactions;
	if (availableReactions == null) return null;
	if (!Array.isArray(availableReactions)) return /* @__PURE__ */ new Set();
	const allowed = /* @__PURE__ */ new Set();
	for (const reaction of availableReactions) {
		if (!reaction || typeof reaction !== "object") continue;
		const typedReaction = reaction;
		if (typedReaction.type !== "emoji" || typeof typedReaction.emoji !== "string") continue;
		const emoji = typedReaction.emoji.trim();
		if (emoji) allowed.add(emoji);
	}
	return allowed;
}
async function resolveTelegramAllowedEmojiReactions(params) {
	const fromMessage = extractTelegramAllowedEmojiReactions(params.chat);
	if (fromMessage !== void 0) return fromMessage;
	if (params.getChat) try {
		const fromLookup = extractTelegramAllowedEmojiReactions(await params.getChat(params.chatId));
		if (fromLookup !== void 0) return fromLookup;
	} catch {
		return null;
	}
	return null;
}
function resolveTelegramReactionVariant(params) {
	const requestedEmoji = normalizeEmoji(params.requestedEmoji);
	if (!requestedEmoji) return;
	const variants = toUniqueNonEmpty([...params.variantsByRequestedEmoji.get(requestedEmoji) ?? [requestedEmoji], ...TELEGRAM_GENERIC_REACTION_FALLBACKS]);
	for (const candidate of variants) if ((params.allowedEmojiReactions == null || params.allowedEmojiReactions.has(candidate)) && isTelegramSupportedReactionEmoji(candidate)) return candidate;
}
//#endregion
//#region extensions/telegram/src/bot-message-context.ts
init_globals();
init_session_key();
const buildTelegramMessageContext = async ({ primaryCtx, allMedia, replyMedia = [], storeAllowFrom, options, bot, cfg, account, historyLimit, groupHistories, dmPolicy, allowFrom, groupAllowFrom, ackReactionScope, logger, resolveGroupActivation, resolveGroupRequireMention, resolveTelegramGroupConfig, sendChatActionHandler }) => {
	const msg = primaryCtx.message;
	const chatId = msg.chat.id;
	const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
	const senderId = msg.from?.id ? String(msg.from.id) : "";
	const messageThreadId = msg.message_thread_id;
	const isForum = msg.chat.is_forum === true;
	const threadSpec = resolveTelegramThreadSpec({
		isGroup,
		isForum,
		messageThreadId
	});
	const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : void 0;
	const replyThreadId = threadSpec.id;
	const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : void 0;
	const { groupConfig, topicConfig } = resolveTelegramGroupConfig(chatId, resolvedThreadId ?? dmThreadId);
	const effectiveDmPolicy = !isGroup && groupConfig && "dmPolicy" in groupConfig ? groupConfig.dmPolicy ?? dmPolicy : dmPolicy;
	const freshCfg = loadConfig();
	let { route, configuredBinding, configuredBindingSessionKey } = resolveTelegramConversationRoute({
		cfg: freshCfg,
		accountId: account.accountId,
		chatId,
		isGroup,
		resolvedThreadId,
		replyThreadId,
		senderId,
		topicAgentId: topicConfig?.agentId
	});
	const requiresExplicitAccountBinding = (candidate) => candidate.accountId !== "default" && candidate.matchedBy === "default";
	const isNamedAccountFallback = requiresExplicitAccountBinding(route);
	if (isNamedAccountFallback && isGroup) {
		logInboundDrop({
			log: logVerbose,
			channel: "telegram",
			reason: "non-default account requires explicit binding",
			target: route.accountId
		});
		return null;
	}
	const groupAllowOverride = firstDefined(topicConfig?.allowFrom, groupConfig?.allowFrom);
	const dmAllowFrom = groupAllowOverride ?? allowFrom;
	const effectiveDmAllow = normalizeDmAllowFromWithStore({
		allowFrom: dmAllowFrom,
		storeAllowFrom,
		dmPolicy: effectiveDmPolicy
	});
	const effectiveGroupAllow = normalizeAllowFrom(groupAllowOverride ?? groupAllowFrom);
	const hasGroupAllowOverride = typeof groupAllowOverride !== "undefined";
	const senderUsername = msg.from?.username ?? "";
	const baseAccess = evaluateTelegramGroupBaseAccess({
		isGroup,
		groupConfig,
		topicConfig,
		hasGroupAllowOverride,
		effectiveGroupAllow,
		senderId,
		senderUsername,
		enforceAllowOverride: true,
		requireSenderForAllowOverride: false
	});
	if (!baseAccess.allowed) {
		if (baseAccess.reason === "group-disabled") {
			logVerbose(`Blocked telegram group ${chatId} (group disabled)`);
			return null;
		}
		if (baseAccess.reason === "topic-disabled") {
			logVerbose(`Blocked telegram topic ${chatId} (${resolvedThreadId ?? "unknown"}) (topic disabled)`);
			return null;
		}
		logVerbose(isGroup ? `Blocked telegram group sender ${senderId || "unknown"} (group allowFrom override)` : `Blocked telegram DM sender ${senderId || "unknown"} (DM allowFrom override)`);
		return null;
	}
	const requireTopic = groupConfig?.requireTopic;
	if (!isGroup && requireTopic === true && dmThreadId == null) {
		logVerbose(`Blocked telegram DM ${chatId}: requireTopic=true but no topic present`);
		return null;
	}
	const sendTyping = async () => {
		await withTelegramApiErrorLogging({
			operation: "sendChatAction",
			fn: () => sendChatActionHandler.sendChatAction(chatId, "typing", buildTypingThreadParams(replyThreadId))
		});
	};
	const sendRecordVoice = async () => {
		try {
			await withTelegramApiErrorLogging({
				operation: "sendChatAction",
				fn: () => sendChatActionHandler.sendChatAction(chatId, "record_voice", buildTypingThreadParams(replyThreadId))
			});
		} catch (err) {
			logVerbose(`telegram record_voice cue failed for chat ${chatId}: ${String(err)}`);
		}
	};
	if (!await enforceTelegramDmAccess({
		isGroup,
		dmPolicy: effectiveDmPolicy,
		msg,
		chatId,
		effectiveDmAllow,
		accountId: account.accountId,
		bot,
		logger
	})) return null;
	const ensureConfiguredBindingReady = async () => {
		if (!configuredBinding) return true;
		const ensured = await ensureConfiguredAcpRouteReady({
			cfg: freshCfg,
			configuredBinding
		});
		if (ensured.ok) {
			logVerbose(`telegram: using configured ACP binding for ${configuredBinding.spec.conversationId} -> ${configuredBindingSessionKey}`);
			return true;
		}
		logVerbose(`telegram: configured ACP binding unavailable for ${configuredBinding.spec.conversationId}: ${ensured.error}`);
		logInboundDrop({
			log: logVerbose,
			channel: "telegram",
			reason: "configured ACP binding unavailable",
			target: configuredBinding.spec.conversationId
		});
		return false;
	};
	const baseSessionKey = isNamedAccountFallback ? buildAgentSessionKey({
		agentId: route.agentId,
		channel: "telegram",
		accountId: route.accountId,
		peer: {
			kind: "direct",
			id: resolveTelegramDirectPeerId({
				chatId,
				senderId
			})
		},
		dmScope: "per-account-channel-peer",
		identityLinks: freshCfg.session?.identityLinks
	}).toLowerCase() : route.sessionKey;
	const sessionKey = (dmThreadId != null ? resolveThreadSessionKeys({
		baseSessionKey,
		threadId: `${chatId}:${dmThreadId}`
	}) : null)?.sessionKey ?? baseSessionKey;
	route = {
		...route,
		sessionKey,
		lastRoutePolicy: deriveLastRoutePolicy({
			sessionKey,
			mainSessionKey: route.mainSessionKey
		})
	};
	const activationOverride = resolveGroupActivation({
		chatId,
		messageThreadId: resolvedThreadId,
		sessionKey,
		agentId: route.agentId
	});
	const baseRequireMention = resolveGroupRequireMention(chatId);
	const requireMention = firstDefined(activationOverride, topicConfig?.requireMention, groupConfig?.requireMention, baseRequireMention);
	recordChannelActivity({
		channel: "telegram",
		accountId: account.accountId,
		direction: "inbound"
	});
	const bodyResult = await resolveTelegramInboundBody({
		cfg,
		primaryCtx,
		msg,
		allMedia,
		isGroup,
		chatId,
		senderId,
		senderUsername,
		resolvedThreadId,
		routeAgentId: route.agentId,
		effectiveGroupAllow,
		effectiveDmAllow,
		groupConfig,
		topicConfig,
		requireMention,
		options,
		groupHistories,
		historyLimit,
		logger
	});
	if (!bodyResult) return null;
	if (!await ensureConfiguredBindingReady()) return null;
	const ackReaction = resolveAckReaction(cfg, route.agentId, {
		channel: "telegram",
		accountId: account.accountId
	});
	const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
	const shouldAckReaction$1 = () => Boolean(ackReaction && shouldAckReaction({
		scope: ackReactionScope,
		isDirect: !isGroup,
		isGroup,
		isMentionableGroup: isGroup,
		requireMention: Boolean(requireMention),
		canDetectMention: bodyResult.canDetectMention,
		effectiveWasMentioned: bodyResult.effectiveWasMentioned,
		shouldBypassMention: bodyResult.shouldBypassMention
	}));
	const api = bot.api;
	const reactionApi = typeof api.setMessageReaction === "function" ? api.setMessageReaction.bind(api) : null;
	const getChatApi = typeof api.getChat === "function" ? api.getChat.bind(api) : null;
	const statusReactionsConfig = cfg.messages?.statusReactions;
	const statusReactionsEnabled = statusReactionsConfig?.enabled === true && Boolean(reactionApi) && shouldAckReaction$1();
	const resolvedStatusReactionEmojis = resolveTelegramStatusReactionEmojis({
		initialEmoji: ackReaction,
		overrides: statusReactionsConfig?.emojis
	});
	const statusReactionVariantsByEmoji = buildTelegramStatusReactionVariants(resolvedStatusReactionEmojis);
	let allowedStatusReactionEmojisPromise = null;
	const statusReactionController = statusReactionsEnabled && msg.message_id ? createStatusReactionController({
		enabled: true,
		adapter: { setReaction: async (emoji) => {
			if (reactionApi) {
				if (!allowedStatusReactionEmojisPromise) allowedStatusReactionEmojisPromise = resolveTelegramAllowedEmojiReactions({
					chat: msg.chat,
					chatId,
					getChat: getChatApi ?? void 0
				}).catch((err) => {
					logVerbose(`telegram status-reaction available_reactions lookup failed for chat ${chatId}: ${String(err)}`);
					return null;
				});
				const resolvedEmoji = resolveTelegramReactionVariant({
					requestedEmoji: emoji,
					variantsByRequestedEmoji: statusReactionVariantsByEmoji,
					allowedEmojiReactions: await allowedStatusReactionEmojisPromise
				});
				if (!resolvedEmoji) return;
				await reactionApi(chatId, msg.message_id, [{
					type: "emoji",
					emoji: resolvedEmoji
				}]);
			}
		} },
		initialEmoji: ackReaction,
		emojis: resolvedStatusReactionEmojis,
		timing: statusReactionsConfig?.timing,
		onError: (err) => {
			logVerbose(`telegram status-reaction error for chat ${chatId}: ${String(err)}`);
		}
	}) : null;
	const ackReactionPromise = statusReactionController ? shouldAckReaction$1() ? Promise.resolve(statusReactionController.setQueued()).then(() => true, () => false) : null : shouldAckReaction$1() && msg.message_id && reactionApi ? withTelegramApiErrorLogging({
		operation: "setMessageReaction",
		fn: () => reactionApi(chatId, msg.message_id, [{
			type: "emoji",
			emoji: ackReaction
		}])
	}).then(() => true, (err) => {
		logVerbose(`telegram react failed for chat ${chatId}: ${String(err)}`);
		return false;
	}) : null;
	const { ctxPayload, skillFilter } = await buildTelegramInboundContextPayload({
		cfg,
		primaryCtx,
		msg,
		allMedia,
		replyMedia,
		isGroup,
		isForum,
		chatId,
		senderId,
		senderUsername,
		resolvedThreadId,
		dmThreadId,
		threadSpec,
		route,
		rawBody: bodyResult.rawBody,
		bodyText: bodyResult.bodyText,
		historyKey: bodyResult.historyKey,
		historyLimit,
		groupHistories,
		groupConfig,
		topicConfig,
		stickerCacheHit: bodyResult.stickerCacheHit,
		effectiveWasMentioned: bodyResult.effectiveWasMentioned,
		locationData: bodyResult.locationData,
		options,
		dmAllowFrom,
		commandAuthorized: bodyResult.commandAuthorized
	});
	return {
		ctxPayload,
		primaryCtx,
		msg,
		chatId,
		isGroup,
		resolvedThreadId,
		threadSpec,
		replyThreadId,
		isForum,
		historyKey: bodyResult.historyKey,
		historyLimit,
		groupHistories,
		route,
		skillFilter,
		sendTyping,
		sendRecordVoice,
		ackReactionPromise,
		reactionApi,
		removeAckAfterReply,
		statusReactionController,
		accountId: account.accountId
	};
};
//#endregion
//#region extensions/telegram/src/draft-stream.ts
const TELEGRAM_STREAM_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 1e3;
const TELEGRAM_DRAFT_ID_MAX = 2147483647;
const THREAD_NOT_FOUND_RE = /400:\s*Bad Request:\s*message thread not found/i;
const DRAFT_METHOD_UNAVAILABLE_RE = /(unknown method|method .*not (found|available|supported)|unsupported)/i;
const DRAFT_CHAT_UNSUPPORTED_RE = /(can't be used|can be used only)/i;
const draftStreamState = resolveGlobalSingleton(Symbol.for("openclaw.telegramDraftStreamState"), () => ({ nextDraftId: 0 }));
function allocateTelegramDraftId() {
	draftStreamState.nextDraftId = draftStreamState.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : draftStreamState.nextDraftId + 1;
	return draftStreamState.nextDraftId;
}
function resolveSendMessageDraftApi(api) {
	const sendMessageDraft = api.sendMessageDraft;
	if (typeof sendMessageDraft !== "function") return;
	return sendMessageDraft.bind(api);
}
function shouldFallbackFromDraftTransport(err) {
	const text = typeof err === "string" ? err : err instanceof Error ? err.message : typeof err === "object" && err && "description" in err ? typeof err.description === "string" ? err.description : "" : "";
	if (!/sendMessageDraft/i.test(text)) return false;
	return DRAFT_METHOD_UNAVAILABLE_RE.test(text) || DRAFT_CHAT_UNSUPPORTED_RE.test(text);
}
function createTelegramDraftStream(params) {
	const maxChars = Math.min(params.maxChars ?? TELEGRAM_STREAM_MAX_CHARS, TELEGRAM_STREAM_MAX_CHARS);
	const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
	const minInitialChars = params.minInitialChars;
	const chatId = params.chatId;
	const requestedPreviewTransport = params.previewTransport ?? "auto";
	const prefersDraftTransport = requestedPreviewTransport === "draft" ? true : requestedPreviewTransport === "message" ? false : params.thread?.scope === "dm";
	const threadParams = buildTelegramThreadParams(params.thread);
	const replyParams = params.replyToMessageId != null ? {
		...threadParams,
		reply_to_message_id: params.replyToMessageId
	} : threadParams;
	const resolvedDraftApi = prefersDraftTransport ? resolveSendMessageDraftApi(params.api) : void 0;
	const usesDraftTransport = Boolean(prefersDraftTransport && resolvedDraftApi);
	if (prefersDraftTransport && !usesDraftTransport) params.warn?.("telegram stream preview: sendMessageDraft unavailable; falling back to sendMessage/editMessageText");
	const streamState = {
		stopped: false,
		final: false
	};
	let messageSendAttempted = false;
	let streamMessageId;
	let streamDraftId = usesDraftTransport ? allocateTelegramDraftId() : void 0;
	let previewTransport = usesDraftTransport ? "draft" : "message";
	let lastSentText = "";
	let lastDeliveredText = "";
	let lastSentParseMode;
	let previewRevision = 0;
	let generation = 0;
	const sendRenderedMessageWithThreadFallback = async (sendArgs) => {
		const sendParams = sendArgs.renderedParseMode ? {
			...replyParams,
			parse_mode: sendArgs.renderedParseMode
		} : replyParams;
		const usedThreadParams = "message_thread_id" in (sendParams ?? {}) && typeof sendParams.message_thread_id === "number";
		try {
			return {
				sent: await params.api.sendMessage(chatId, sendArgs.renderedText, sendParams),
				usedThreadParams
			};
		} catch (err) {
			if (!usedThreadParams || !THREAD_NOT_FOUND_RE.test(String(err))) throw err;
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
		if (sendGeneration !== generation) {
			params.onSupersededPreview?.({
				messageId: normalizedMessageId,
				textSnapshot: renderedText,
				parseMode: renderedParseMode
			});
			return true;
		}
		streamMessageId = normalizedMessageId;
		return true;
	};
	const sendDraftTransportPreview = async ({ renderedText, renderedParseMode }) => {
		const draftId = streamDraftId ?? allocateTelegramDraftId();
		streamDraftId = draftId;
		const draftParams = {
			...threadParams?.message_thread_id != null ? { message_thread_id: threadParams.message_thread_id } : {},
			...renderedParseMode ? { parse_mode: renderedParseMode } : {}
		};
		await resolvedDraftApi(chatId, draftId, renderedText, Object.keys(draftParams).length > 0 ? draftParams : void 0);
		return true;
	};
	const sendOrEditStreamMessage = async (text) => {
		if (streamState.stopped && !streamState.final) return false;
		const trimmed = text.trimEnd();
		if (!trimmed) return false;
		const rendered = params.renderText?.(trimmed) ?? { text: trimmed };
		const renderedText = rendered.text.trimEnd();
		const renderedParseMode = rendered.parseMode;
		if (!renderedText) return false;
		if (renderedText.length > maxChars) {
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
			let sent = false;
			if (previewTransport === "draft") try {
				sent = await sendDraftTransportPreview({
					renderedText,
					renderedParseMode,
					sendGeneration
				});
			} catch (err) {
				if (!shouldFallbackFromDraftTransport(err)) throw err;
				previewTransport = "message";
				streamDraftId = void 0;
				params.warn?.("telegram stream preview: sendMessageDraft rejected by API; falling back to sendMessage/editMessageText");
				sent = await sendMessageTransportPreview({
					renderedText,
					renderedParseMode,
					sendGeneration
				});
			}
			else sent = await sendMessageTransportPreview({
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
			params.warn?.(`telegram stream preview failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	};
	const { loop, update, stop, clear } = createFinalizableDraftLifecycle({
		throttleMs,
		state: streamState,
		sendOrEditStreamMessage,
		readMessageId: () => streamMessageId,
		clearMessageId: () => {
			streamMessageId = void 0;
		},
		isValidMessageId: (value) => typeof value === "number" && Number.isFinite(value),
		deleteMessage: async (messageId) => {
			await params.api.deleteMessage(chatId, messageId);
		},
		onDeleteSuccess: (messageId) => {
			params.log?.(`telegram stream preview deleted (chat=${chatId}, message=${messageId})`);
		},
		warn: params.warn,
		warnPrefix: "telegram stream preview cleanup failed"
	});
	const forceNewMessage = () => {
		streamState.final = false;
		generation += 1;
		messageSendAttempted = false;
		streamMessageId = void 0;
		if (previewTransport === "draft") streamDraftId = allocateTelegramDraftId();
		lastSentText = "";
		lastSentParseMode = void 0;
		loop.resetPending();
		loop.resetThrottleWindow();
	};
	/**
	* Materialize the current draft into a permanent message.
	* For draft transport: sends the accumulated text as a real sendMessage.
	* For message transport: the message is already permanent (noop).
	* Returns the permanent message id, or undefined if nothing to materialize.
	*/
	const materialize = async () => {
		await stop();
		if (previewTransport === "message" && typeof streamMessageId === "number") return streamMessageId;
		const renderedText = lastSentText || lastDeliveredText;
		if (!renderedText) return;
		const renderedParseMode = lastSentText ? lastSentParseMode : void 0;
		try {
			const { sent, usedThreadParams } = await sendRenderedMessageWithThreadFallback({
				renderedText,
				renderedParseMode,
				fallbackWarnMessage: "telegram stream preview materialize send failed with message_thread_id, retrying without thread"
			});
			const sentId = sent?.message_id;
			if (typeof sentId === "number" && Number.isFinite(sentId)) {
				streamMessageId = Math.trunc(sentId);
				if (resolvedDraftApi != null && streamDraftId != null) {
					const clearDraftId = streamDraftId;
					const clearThreadParams = usedThreadParams && threadParams?.message_thread_id != null ? { message_thread_id: threadParams.message_thread_id } : void 0;
					try {
						await resolvedDraftApi(chatId, clearDraftId, "", clearThreadParams);
					} catch {}
				}
				return streamMessageId;
			}
		} catch (err) {
			params.warn?.(`telegram stream preview materialize failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	params.log?.(`telegram stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
	return {
		update,
		flush: loop.flush,
		messageId: () => streamMessageId,
		previewMode: () => previewTransport,
		previewRevision: () => previewRevision,
		lastDeliveredText: () => lastDeliveredText,
		clear,
		stop,
		materialize,
		forceNewMessage,
		sendMayHaveLanded: () => messageSendAttempted && typeof streamMessageId !== "number"
	};
}
//#endregion
//#region extensions/telegram/src/lane-delivery-text-deliverer.ts
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_NOT_FOUND_RE = /400:\s*Bad Request:\s*message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i;
function extractErrorText(err) {
	return typeof err === "string" ? err : err instanceof Error ? err.message : typeof err === "object" && err && "description" in err ? typeof err.description === "string" ? err.description : "" : "";
}
function isMessageNotModifiedError(err) {
	return MESSAGE_NOT_MODIFIED_RE.test(extractErrorText(err));
}
/**
* Returns true when Telegram rejects an edit because the target message can no
* longer be resolved or edited. The caller still needs preview context to
* decide whether to retain a different visible preview or fall back to send.
*/
function isMissingPreviewMessageError(err) {
	return MESSAGE_NOT_FOUND_RE.test(extractErrorText(err));
}
function shouldSkipRegressivePreviewUpdate(args) {
	const currentPreviewText = args.currentPreviewText;
	if (currentPreviewText === void 0) return false;
	return currentPreviewText.startsWith(args.text) && args.text.length < currentPreviewText.length && (args.skipRegressive === "always" || args.hadPreviewMessage);
}
function resolvePreviewTarget(params) {
	const lanePreviewMessageId = params.lane.stream?.messageId();
	const previewMessageId = typeof params.previewMessageIdOverride === "number" ? params.previewMessageIdOverride : lanePreviewMessageId;
	const hadPreviewMessage = typeof params.previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
	return {
		hadPreviewMessage,
		previewMessageId: typeof previewMessageId === "number" ? previewMessageId : void 0,
		stopCreatesFirstPreview: params.stopBeforeEdit && !hadPreviewMessage && params.context === "final"
	};
}
function createLaneTextDeliverer(params) {
	const getLanePreviewText = (lane) => lane.lastPartialText;
	const markActivePreviewComplete = (laneName) => {
		params.activePreviewLifecycleByLane[laneName] = "complete";
		params.retainPreviewOnCleanupByLane[laneName] = true;
	};
	const isDraftPreviewLane = (lane) => lane.stream?.previewMode?.() === "draft";
	const canMaterializeDraftFinal = (lane, previewButtons) => {
		const hasPreviewButtons = Boolean(previewButtons && previewButtons.length > 0);
		return isDraftPreviewLane(lane) && !hasPreviewButtons && typeof lane.stream?.materialize === "function";
	};
	const tryMaterializeDraftPreviewForFinal = async (args) => {
		const stream = args.lane.stream;
		if (!stream || !isDraftPreviewLane(args.lane)) return false;
		stream.update(args.text);
		if (typeof await stream.materialize?.() !== "number") {
			params.log(`telegram: ${args.laneName} draft preview materialize produced no message id; falling back to standard send`);
			return false;
		}
		args.lane.lastPartialText = args.text;
		params.markDelivered();
		return true;
	};
	const tryEditPreviewMessage = async (args) => {
		try {
			await params.editPreview({
				laneName: args.laneName,
				messageId: args.messageId,
				text: args.text,
				previewButtons: args.previewButtons,
				context: args.context
			});
			if (args.updateLaneSnapshot) args.lane.lastPartialText = args.text;
			params.markDelivered();
			return "edited";
		} catch (err) {
			if (isMessageNotModifiedError(err)) {
				params.log(`telegram: ${args.laneName} preview ${args.context} edit returned "message is not modified"; treating as delivered`);
				params.markDelivered();
				return "edited";
			}
			if (args.context === "final") {
				if (args.finalTextAlreadyLanded) {
					params.log(`telegram: ${args.laneName} preview final edit failed after stop flush; keeping existing preview (${String(err)})`);
					params.markDelivered();
					return "retained";
				}
				if (isSafeToRetrySendError(err)) {
					params.log(`telegram: ${args.laneName} preview final edit failed before reaching Telegram; falling back to standard send (${String(err)})`);
					return "fallback";
				}
				if (isMissingPreviewMessageError(err)) {
					if (args.retainAlternatePreviewOnMissingTarget) {
						params.log(`telegram: ${args.laneName} preview final edit target missing; keeping alternate preview without fallback (${String(err)})`);
						params.markDelivered();
						return "retained";
					}
					params.log(`telegram: ${args.laneName} preview final edit target missing with no alternate preview; falling back to standard send (${String(err)})`);
					return "fallback";
				}
				if (isRecoverableTelegramNetworkError(err, { allowMessageMatch: true })) {
					params.log(`telegram: ${args.laneName} preview final edit may have landed despite network error; keeping existing preview (${String(err)})`);
					params.markDelivered();
					return "retained";
				}
				if (isTelegramClientRejection(err)) {
					params.log(`telegram: ${args.laneName} preview final edit rejected by Telegram (client error); falling back to standard send (${String(err)})`);
					return "fallback";
				}
				params.log(`telegram: ${args.laneName} preview final edit failed with ambiguous error; keeping existing preview to avoid duplicate (${String(err)})`);
				params.markDelivered();
				return "retained";
			}
			params.log(`telegram: ${args.laneName} preview ${args.context} edit failed; falling back to standard send (${String(err)})`);
			return "fallback";
		}
	};
	const tryUpdatePreviewForLane = async ({ lane, laneName, text, previewButtons, stopBeforeEdit = false, updateLaneSnapshot = false, skipRegressive, context, previewMessageId: previewMessageIdOverride, previewTextSnapshot }) => {
		const editPreview = (messageId, finalTextAlreadyLanded, retainAlternatePreviewOnMissingTarget) => tryEditPreviewMessage({
			laneName,
			messageId,
			text,
			context,
			previewButtons,
			updateLaneSnapshot,
			lane,
			finalTextAlreadyLanded,
			retainAlternatePreviewOnMissingTarget
		});
		const finalizePreview = (previewMessageId, finalTextAlreadyLanded, hadPreviewMessage, retainAlternatePreviewOnMissingTarget = false) => {
			if (shouldSkipRegressivePreviewUpdate({
				currentPreviewText: previewTextSnapshot ?? getLanePreviewText(lane),
				text,
				skipRegressive,
				hadPreviewMessage
			})) {
				params.markDelivered();
				return "edited";
			}
			return editPreview(previewMessageId, finalTextAlreadyLanded, retainAlternatePreviewOnMissingTarget);
		};
		if (!lane.stream) return "fallback";
		if (resolvePreviewTarget({
			lane,
			previewMessageIdOverride,
			stopBeforeEdit,
			context
		}).stopCreatesFirstPreview) {
			lane.stream.update(text);
			await params.stopDraftLane(lane);
			const previewTargetAfterStop = resolvePreviewTarget({
				lane,
				stopBeforeEdit: false,
				context
			});
			if (typeof previewTargetAfterStop.previewMessageId !== "number") return "fallback";
			return finalizePreview(previewTargetAfterStop.previewMessageId, true, false);
		}
		if (stopBeforeEdit) await params.stopDraftLane(lane);
		const previewTargetAfterStop = resolvePreviewTarget({
			lane,
			previewMessageIdOverride,
			stopBeforeEdit: false,
			context
		});
		if (typeof previewTargetAfterStop.previewMessageId !== "number") {
			if (context === "final" && lane.hasStreamedMessage && lane.stream?.sendMayHaveLanded?.()) {
				params.log(`telegram: ${laneName} preview send may have landed despite missing message id; keeping to avoid duplicate`);
				params.markDelivered();
				return "retained";
			}
			return "fallback";
		}
		const activePreviewMessageId = lane.stream?.messageId();
		return finalizePreview(previewTargetAfterStop.previewMessageId, false, previewTargetAfterStop.hadPreviewMessage, typeof activePreviewMessageId === "number" && activePreviewMessageId !== previewTargetAfterStop.previewMessageId);
	};
	const consumeArchivedAnswerPreviewForFinal = async ({ lane, text, payload, previewButtons, canEditViaPreview }) => {
		const archivedPreview = params.archivedAnswerPreviews.shift();
		if (!archivedPreview) return;
		if (canEditViaPreview) {
			const finalized = await tryUpdatePreviewForLane({
				lane,
				laneName: "answer",
				text,
				previewButtons,
				stopBeforeEdit: false,
				skipRegressive: "existingOnly",
				context: "final",
				previewMessageId: archivedPreview.messageId,
				previewTextSnapshot: archivedPreview.textSnapshot
			});
			if (finalized === "edited") return "preview-finalized";
			if (finalized === "retained") {
				params.retainPreviewOnCleanupByLane.answer = true;
				return "preview-retained";
			}
		}
		const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
		if (delivered || archivedPreview.deleteIfUnused !== false) try {
			await params.deletePreviewMessage(archivedPreview.messageId);
		} catch (err) {
			params.log(`telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`);
		}
		return delivered ? "sent" : "skipped";
	};
	return async ({ laneName, text, payload, infoKind, previewButtons, allowPreviewUpdateForNonFinal = false }) => {
		const lane = params.lanes[laneName];
		const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
		const canEditViaPreview = !hasMedia && text.length > 0 && text.length <= params.draftMaxChars && !payload.isError;
		if (infoKind === "final") {
			if (params.activePreviewLifecycleByLane[laneName] === "transient") params.retainPreviewOnCleanupByLane[laneName] = false;
			if (laneName === "answer") {
				const archivedResult = await consumeArchivedAnswerPreviewForFinal({
					lane,
					text,
					payload,
					previewButtons,
					canEditViaPreview
				});
				if (archivedResult) return archivedResult;
			}
			if (canEditViaPreview && params.activePreviewLifecycleByLane[laneName] === "transient") {
				await params.flushDraftLane(lane);
				if (laneName === "answer") {
					const archivedResultAfterFlush = await consumeArchivedAnswerPreviewForFinal({
						lane,
						text,
						payload,
						previewButtons,
						canEditViaPreview
					});
					if (archivedResultAfterFlush) return archivedResultAfterFlush;
				}
				if (canMaterializeDraftFinal(lane, previewButtons)) {
					if (await tryMaterializeDraftPreviewForFinal({
						lane,
						laneName,
						text
					})) {
						markActivePreviewComplete(laneName);
						return "preview-finalized";
					}
				}
				const finalized = await tryUpdatePreviewForLane({
					lane,
					laneName,
					text,
					previewButtons,
					stopBeforeEdit: true,
					skipRegressive: "existingOnly",
					context: "final"
				});
				if (finalized === "edited") {
					markActivePreviewComplete(laneName);
					return "preview-finalized";
				}
				if (finalized === "retained") {
					markActivePreviewComplete(laneName);
					return "preview-retained";
				}
			} else if (!hasMedia && !payload.isError && text.length > params.draftMaxChars) params.log(`telegram: preview final too long for edit (${text.length} > ${params.draftMaxChars}); falling back to standard send`);
			await params.stopDraftLane(lane);
			return await params.sendPayload(params.applyTextToPayload(payload, text)) ? "sent" : "skipped";
		}
		if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
			if (isDraftPreviewLane(lane)) {
				const previewRevisionBeforeFlush = lane.stream?.previewRevision?.() ?? 0;
				lane.stream?.update(text);
				await params.flushDraftLane(lane);
				if (!((lane.stream?.previewRevision?.() ?? 0) > previewRevisionBeforeFlush)) {
					params.log(`telegram: ${laneName} draft preview update not emitted; falling back to standard send`);
					return await params.sendPayload(params.applyTextToPayload(payload, text)) ? "sent" : "skipped";
				}
				lane.lastPartialText = text;
				params.markDelivered();
				return "preview-updated";
			}
			if (await tryUpdatePreviewForLane({
				lane,
				laneName,
				text,
				previewButtons,
				stopBeforeEdit: false,
				updateLaneSnapshot: true,
				skipRegressive: "always",
				context: "update"
			}) === "edited") return "preview-updated";
		}
		return await params.sendPayload(params.applyTextToPayload(payload, text)) ? "sent" : "skipped";
	};
}
//#endregion
//#region extensions/telegram/src/lane-delivery-state.ts
function createLaneDeliveryStateTracker() {
	const state = {
		delivered: false,
		skippedNonSilent: 0,
		failedNonSilent: 0
	};
	return {
		markDelivered: () => {
			state.delivered = true;
		},
		markNonSilentSkip: () => {
			state.skippedNonSilent += 1;
		},
		markNonSilentFailure: () => {
			state.failedNonSilent += 1;
		},
		snapshot: () => ({ ...state })
	};
}
//#endregion
//#region extensions/telegram/src/reasoning-lane-coordinator.ts
const REASONING_MESSAGE_PREFIX = "Reasoning:\n";
const REASONING_TAG_PREFIXES = [
	"<think",
	"<thinking",
	"<thought",
	"<antthinking",
	"</think",
	"</thinking",
	"</thought",
	"</antthinking"
];
const THINKING_TAG_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi;
function extractThinkingFromTaggedStreamOutsideCode(text) {
	if (!text) return "";
	const codeRegions = findCodeRegions(text);
	let result = "";
	let lastIndex = 0;
	let inThinking = false;
	THINKING_TAG_RE.lastIndex = 0;
	for (const match of text.matchAll(THINKING_TAG_RE)) {
		const idx = match.index ?? 0;
		if (isInsideCode(idx, codeRegions)) continue;
		if (inThinking) result += text.slice(lastIndex, idx);
		inThinking = !(match[1] === "/");
		lastIndex = idx + match[0].length;
	}
	if (inThinking) result += text.slice(lastIndex);
	return result.trim();
}
function isPartialReasoningTagPrefix(text) {
	const trimmed = text.trimStart().toLowerCase();
	if (!trimmed.startsWith("<")) return false;
	if (trimmed.includes(">")) return false;
	return REASONING_TAG_PREFIXES.some((prefix) => prefix.startsWith(trimmed));
}
function splitTelegramReasoningText(text) {
	if (typeof text !== "string") return {};
	const trimmed = text.trim();
	if (isPartialReasoningTagPrefix(trimmed)) return {};
	if (trimmed.startsWith(REASONING_MESSAGE_PREFIX) && trimmed.length > 11) return { reasoningText: trimmed };
	const taggedReasoning = extractThinkingFromTaggedStreamOutsideCode(text);
	const strippedAnswer = stripReasoningTagsFromText(text, {
		mode: "strict",
		trim: "both"
	});
	if (!taggedReasoning && strippedAnswer === text) return { answerText: text };
	return {
		reasoningText: taggedReasoning ? formatReasoningMessage(taggedReasoning) : void 0,
		answerText: strippedAnswer || void 0
	};
}
function createTelegramReasoningStepState() {
	let reasoningStatus = "none";
	let bufferedFinalAnswer;
	const noteReasoningHint = () => {
		if (reasoningStatus === "none") reasoningStatus = "hinted";
	};
	const noteReasoningDelivered = () => {
		reasoningStatus = "delivered";
	};
	const shouldBufferFinalAnswer = () => {
		return reasoningStatus === "hinted" && !bufferedFinalAnswer;
	};
	const bufferFinalAnswer = (value) => {
		bufferedFinalAnswer = value;
	};
	const takeBufferedFinalAnswer = () => {
		const value = bufferedFinalAnswer;
		bufferedFinalAnswer = void 0;
		return value;
	};
	const resetForNextStep = () => {
		reasoningStatus = "none";
		bufferedFinalAnswer = void 0;
	};
	return {
		noteReasoningHint,
		noteReasoningDelivered,
		shouldBufferFinalAnswer,
		bufferFinalAnswer,
		takeBufferedFinalAnswer,
		resetForNextStep
	};
}
//#endregion
//#region extensions/telegram/src/bot-message-dispatch.ts
init_globals();
const EMPTY_RESPONSE_FALLBACK$1 = "No response generated. Please try again.";
/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;
async function resolveStickerVisionSupport(cfg, agentId) {
	try {
		const catalog = await loadModelCatalog({ config: cfg });
		const defaultModel = resolveDefaultModelForAgent({
			cfg,
			agentId
		});
		const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
		if (!entry) return false;
		return modelSupportsVision(entry);
	} catch {
		return false;
	}
}
function pruneStickerMediaFromContext(ctxPayload, opts) {
	if (opts?.stickerMediaIncluded === false) return;
	const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths) ? ctxPayload.MediaPaths.slice(1) : void 0;
	const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls) ? ctxPayload.MediaUrls.slice(1) : void 0;
	const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes) ? ctxPayload.MediaTypes.slice(1) : void 0;
	ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : void 0;
	ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : void 0;
	ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : void 0;
	ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
	ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
	ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}
function resolveTelegramReasoningLevel(params) {
	const { cfg, sessionKey, agentId } = params;
	if (!sessionKey) return "off";
	try {
		const level = resolveSessionStoreEntry({
			store: loadSessionStore(resolveStorePath(cfg.session?.store, { agentId }), { skipCache: true }),
			sessionKey
		}).existing?.reasoningLevel;
		if (level === "on" || level === "stream") return level;
	} catch {}
	return "off";
}
const dispatchTelegramMessage = async ({ context, bot, cfg, runtime, replyToMode, streamMode, textLimit, telegramCfg, opts }) => {
	const { ctxPayload, msg, chatId, isGroup, threadSpec, historyKey, historyLimit, groupHistories, route, skillFilter, sendTyping, sendRecordVoice, ackReactionPromise, reactionApi, removeAckAfterReply, statusReactionController } = context;
	const draftMaxChars = Math.min(textLimit, 4096);
	const tableMode = resolveMarkdownTableMode({
		cfg,
		channel: "telegram",
		accountId: route.accountId
	});
	const renderDraftPreview = (text) => ({
		text: renderTelegramHtmlText(text, { tableMode }),
		parseMode: "HTML"
	});
	const accountBlockStreamingEnabled = typeof telegramCfg.blockStreaming === "boolean" ? telegramCfg.blockStreaming : cfg.agents?.defaults?.blockStreamingDefault === "on";
	const resolvedReasoningLevel = resolveTelegramReasoningLevel({
		cfg,
		sessionKey: ctxPayload.SessionKey,
		agentId: route.agentId
	});
	const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
	const streamReasoningDraft = resolvedReasoningLevel === "stream";
	const previewStreamingEnabled = streamMode !== "off";
	const canStreamAnswerDraft = previewStreamingEnabled && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
	const canStreamReasoningDraft = canStreamAnswerDraft || streamReasoningDraft;
	const draftReplyToMessageId = replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : void 0;
	const draftMinInitialChars = DRAFT_MIN_INITIAL_CHARS;
	const useMessagePreviewTransportForDm = threadSpec?.scope === "dm" && canStreamAnswerDraft;
	const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
	const archivedAnswerPreviews = [];
	const archivedReasoningPreviewIds = [];
	const createDraftLane = (laneName, enabled) => {
		return {
			stream: enabled ? createTelegramDraftStream({
				api: bot.api,
				chatId,
				maxChars: draftMaxChars,
				thread: threadSpec,
				previewTransport: useMessagePreviewTransportForDm ? "message" : "auto",
				replyToMessageId: draftReplyToMessageId,
				minInitialChars: draftMinInitialChars,
				renderText: renderDraftPreview,
				onSupersededPreview: laneName === "answer" || laneName === "reasoning" ? (preview) => {
					if (laneName === "reasoning") {
						if (!archivedReasoningPreviewIds.includes(preview.messageId)) archivedReasoningPreviewIds.push(preview.messageId);
						return;
					}
					archivedAnswerPreviews.push({
						messageId: preview.messageId,
						textSnapshot: preview.textSnapshot,
						deleteIfUnused: true
					});
				} : void 0,
				log: logVerbose,
				warn: logVerbose
			}) : void 0,
			lastPartialText: "",
			hasStreamedMessage: false
		};
	};
	const lanes = {
		answer: createDraftLane("answer", canStreamAnswerDraft),
		reasoning: createDraftLane("reasoning", canStreamReasoningDraft)
	};
	const activePreviewLifecycleByLane = {
		answer: "transient",
		reasoning: "transient"
	};
	const retainPreviewOnCleanupByLane = {
		answer: false,
		reasoning: false
	};
	const answerLane = lanes.answer;
	const reasoningLane = lanes.reasoning;
	let splitReasoningOnNextStream = false;
	let skipNextAnswerMessageStartRotation = false;
	let draftLaneEventQueue = Promise.resolve();
	const reasoningStepState = createTelegramReasoningStepState();
	const enqueueDraftLaneEvent = (task) => {
		draftLaneEventQueue = draftLaneEventQueue.then(task).catch((err) => {
			logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
		});
		return draftLaneEventQueue;
	};
	const splitTextIntoLaneSegments = (text) => {
		const split = splitTelegramReasoningText(text);
		const segments = [];
		const suppressReasoning = resolvedReasoningLevel === "off";
		if (split.reasoningText && !suppressReasoning) segments.push({
			lane: "reasoning",
			text: split.reasoningText
		});
		if (split.answerText) segments.push({
			lane: "answer",
			text: split.answerText
		});
		return {
			segments,
			suppressedReasoningOnly: Boolean(split.reasoningText) && suppressReasoning && !split.answerText
		};
	};
	const resetDraftLaneState = (lane) => {
		lane.lastPartialText = "";
		lane.hasStreamedMessage = false;
	};
	const rotateAnswerLaneForNewAssistantMessage = async () => {
		let didForceNewMessage = false;
		if (answerLane.hasStreamedMessage) {
			const previewMessageId = await answerLane.stream?.materialize?.() ?? answerLane.stream?.messageId();
			if (typeof previewMessageId === "number" && activePreviewLifecycleByLane.answer === "transient") archivedAnswerPreviews.push({
				messageId: previewMessageId,
				textSnapshot: answerLane.lastPartialText,
				deleteIfUnused: false
			});
			answerLane.stream?.forceNewMessage();
			didForceNewMessage = true;
		}
		resetDraftLaneState(answerLane);
		if (didForceNewMessage) {
			activePreviewLifecycleByLane.answer = "transient";
			retainPreviewOnCleanupByLane.answer = false;
		}
		return didForceNewMessage;
	};
	const updateDraftFromPartial = (lane, text) => {
		const laneStream = lane.stream;
		if (!laneStream || !text) return;
		if (text === lane.lastPartialText) return;
		lane.hasStreamedMessage = true;
		if (lane.lastPartialText && lane.lastPartialText.startsWith(text) && text.length < lane.lastPartialText.length) return;
		lane.lastPartialText = text;
		laneStream.update(text);
	};
	const ingestDraftLaneSegments = async (text) => {
		const split = splitTextIntoLaneSegments(text);
		if (split.segments.some((segment) => segment.lane === "answer") && activePreviewLifecycleByLane.answer !== "transient") skipNextAnswerMessageStartRotation = await rotateAnswerLaneForNewAssistantMessage();
		for (const segment of split.segments) {
			if (segment.lane === "reasoning") {
				reasoningStepState.noteReasoningHint();
				reasoningStepState.noteReasoningDelivered();
			}
			updateDraftFromPartial(lanes[segment.lane], segment.text);
		}
	};
	const flushDraftLane = async (lane) => {
		if (!lane.stream) return;
		await lane.stream.flush();
	};
	const disableBlockStreaming = !previewStreamingEnabled ? true : forceBlockStreamingForReasoning ? false : typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : canStreamAnswerDraft ? true : void 0;
	const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
		cfg,
		agentId: route.agentId,
		channel: "telegram",
		accountId: route.accountId
	});
	const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);
	const sticker = ctxPayload.Sticker;
	if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
		const agentDir = resolveAgentDir(cfg, route.agentId);
		const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
		let description = sticker.cachedDescription ?? null;
		if (!description) description = await describeStickerImage({
			imagePath: ctxPayload.MediaPath,
			cfg,
			agentDir,
			agentId: route.agentId
		});
		if (description) {
			const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null].filter(Boolean).join(" ");
			const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;
			sticker.cachedDescription = description;
			if (!stickerSupportsVision) {
				ctxPayload.Body = formattedDesc;
				ctxPayload.BodyForAgent = formattedDesc;
				pruneStickerMediaFromContext(ctxPayload, { stickerMediaIncluded: ctxPayload.StickerMediaIncluded });
			}
			if (sticker.fileId) {
				cacheSticker({
					fileId: sticker.fileId,
					fileUniqueId: sticker.fileUniqueId,
					emoji: sticker.emoji,
					setName: sticker.setName,
					description,
					cachedAt: (/* @__PURE__ */ new Date()).toISOString(),
					receivedFrom: ctxPayload.From
				});
				logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
			} else logVerbose(`telegram: skipped sticker cache (missing fileId)`);
		}
	}
	const replyQuoteText = ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody ? ctxPayload.ReplyToBody.trim() || void 0 : void 0;
	const deliveryState = createLaneDeliveryStateTracker();
	const clearGroupHistory = () => {
		if (isGroup && historyKey) clearHistoryEntriesIfEnabled({
			historyMap: groupHistories,
			historyKey,
			limit: historyLimit
		});
	};
	const deliveryBaseOptions = {
		chatId: String(chatId),
		accountId: route.accountId,
		sessionKeyForInternalHooks: ctxPayload.SessionKey,
		mirrorIsGroup: isGroup,
		mirrorGroupId: isGroup ? String(chatId) : void 0,
		token: opts.token,
		runtime,
		bot,
		mediaLocalRoots,
		replyToMode,
		textLimit,
		thread: threadSpec,
		tableMode,
		chunkMode,
		linkPreview: telegramCfg.linkPreview,
		replyQuoteText
	};
	const silentErrorReplies = telegramCfg.silentErrorReplies === true;
	const applyTextToPayload = (payload, text) => {
		if (payload.text === text) return payload;
		return {
			...payload,
			text
		};
	};
	const sendPayload = async (payload) => {
		const result = await deliverReplies({
			...deliveryBaseOptions,
			replies: [payload],
			onVoiceRecording: sendRecordVoice,
			silent: silentErrorReplies && payload.isError === true
		});
		if (result.delivered) deliveryState.markDelivered();
		return result.delivered;
	};
	const deliverLaneText = createLaneTextDeliverer({
		lanes,
		archivedAnswerPreviews,
		activePreviewLifecycleByLane,
		retainPreviewOnCleanupByLane,
		draftMaxChars,
		applyTextToPayload,
		sendPayload,
		flushDraftLane,
		stopDraftLane: async (lane) => {
			await lane.stream?.stop();
		},
		editPreview: async ({ messageId, text, previewButtons }) => {
			await editMessageTelegram(chatId, messageId, text, {
				api: bot.api,
				cfg,
				accountId: route.accountId,
				linkPreview: telegramCfg.linkPreview,
				buttons: previewButtons
			});
		},
		deletePreviewMessage: async (messageId) => {
			await bot.api.deleteMessage(chatId, messageId);
		},
		log: logVerbose,
		markDelivered: () => {
			deliveryState.markDelivered();
		}
	});
	let queuedFinal = false;
	let hadErrorReplyFailureOrSkip = false;
	if (statusReactionController) statusReactionController.setThinking();
	const typingCallbacks = createTypingCallbacks({
		start: sendTyping,
		onStartError: (err) => {
			logTypingFailure({
				log: logVerbose,
				channel: "telegram",
				target: String(chatId),
				error: err
			});
		}
	});
	let dispatchError;
	try {
		({queuedFinal} = await dispatchReplyWithBufferedBlockDispatcher({
			ctx: ctxPayload,
			cfg,
			dispatcherOptions: {
				...prefixOptions,
				typingCallbacks,
				deliver: async (payload, info) => {
					if (payload.isError === true) hadErrorReplyFailureOrSkip = true;
					if (info.kind === "final") await enqueueDraftLaneEvent(async () => {});
					if (shouldSuppressLocalTelegramExecApprovalPrompt({
						cfg,
						accountId: route.accountId,
						payload
					})) {
						queuedFinal = true;
						return;
					}
					const previewButtons = (payload.channelData?.telegram)?.buttons;
					const split = splitTextIntoLaneSegments(payload.text);
					const segments = split.segments;
					const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
					const flushBufferedFinalAnswer = async () => {
						const buffered = reasoningStepState.takeBufferedFinalAnswer();
						if (!buffered) return;
						const bufferedButtons = (buffered.payload.channelData?.telegram)?.buttons;
						await deliverLaneText({
							laneName: "answer",
							text: buffered.text,
							payload: buffered.payload,
							infoKind: "final",
							previewButtons: bufferedButtons
						});
						reasoningStepState.resetForNextStep();
					};
					for (const segment of segments) {
						if (segment.lane === "answer" && info.kind === "final" && reasoningStepState.shouldBufferFinalAnswer()) {
							reasoningStepState.bufferFinalAnswer({
								payload,
								text: segment.text
							});
							continue;
						}
						if (segment.lane === "reasoning") reasoningStepState.noteReasoningHint();
						const result = await deliverLaneText({
							laneName: segment.lane,
							text: segment.text,
							payload,
							infoKind: info.kind,
							previewButtons,
							allowPreviewUpdateForNonFinal: segment.lane === "reasoning"
						});
						if (segment.lane === "reasoning") {
							if (result !== "skipped") {
								reasoningStepState.noteReasoningDelivered();
								await flushBufferedFinalAnswer();
							}
							continue;
						}
						if (info.kind === "final") {
							if (reasoningLane.hasStreamedMessage) {
								activePreviewLifecycleByLane.reasoning = "complete";
								retainPreviewOnCleanupByLane.reasoning = true;
							}
							reasoningStepState.resetForNextStep();
						}
					}
					if (segments.length > 0) return;
					if (split.suppressedReasoningOnly) {
						if (hasMedia) await sendPayload(typeof payload.text === "string" ? {
							...payload,
							text: ""
						} : payload);
						if (info.kind === "final") await flushBufferedFinalAnswer();
						return;
					}
					if (info.kind === "final") {
						await answerLane.stream?.stop();
						await reasoningLane.stream?.stop();
						reasoningStepState.resetForNextStep();
					}
					if (!(hasMedia || typeof payload.text === "string" && payload.text.length > 0)) {
						if (info.kind === "final") await flushBufferedFinalAnswer();
						return;
					}
					await sendPayload(payload);
					if (info.kind === "final") await flushBufferedFinalAnswer();
				},
				onSkip: (payload, info) => {
					if (payload.isError === true) hadErrorReplyFailureOrSkip = true;
					if (info.reason !== "silent") deliveryState.markNonSilentSkip();
				},
				onError: (err, info) => {
					deliveryState.markNonSilentFailure();
					runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
				}
			},
			replyOptions: {
				skillFilter,
				disableBlockStreaming,
				onPartialReply: answerLane.stream || reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
					await ingestDraftLaneSegments(payload.text);
				}) : void 0,
				onReasoningStream: reasoningLane.stream ? (payload) => enqueueDraftLaneEvent(async () => {
					if (splitReasoningOnNextStream) {
						reasoningLane.stream?.forceNewMessage();
						resetDraftLaneState(reasoningLane);
						splitReasoningOnNextStream = false;
					}
					await ingestDraftLaneSegments(payload.text);
				}) : void 0,
				onAssistantMessageStart: answerLane.stream ? () => enqueueDraftLaneEvent(async () => {
					reasoningStepState.resetForNextStep();
					if (skipNextAnswerMessageStartRotation) {
						skipNextAnswerMessageStartRotation = false;
						activePreviewLifecycleByLane.answer = "transient";
						retainPreviewOnCleanupByLane.answer = false;
						return;
					}
					await rotateAnswerLaneForNewAssistantMessage();
					activePreviewLifecycleByLane.answer = "transient";
					retainPreviewOnCleanupByLane.answer = false;
				}) : void 0,
				onReasoningEnd: reasoningLane.stream ? () => enqueueDraftLaneEvent(async () => {
					splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
				}) : void 0,
				onToolStart: statusReactionController ? async (payload) => {
					await statusReactionController.setTool(payload.name);
				} : void 0,
				onCompactionStart: statusReactionController ? () => statusReactionController.setCompacting() : void 0,
				onCompactionEnd: statusReactionController ? async () => {
					statusReactionController.cancelPending();
					await statusReactionController.setThinking();
				} : void 0,
				onModelSelected
			}
		}));
	} catch (err) {
		dispatchError = err;
		runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
	} finally {
		await draftLaneEventQueue;
		const streamCleanupStates = /* @__PURE__ */ new Map();
		const lanesToCleanup = [{
			laneName: "answer",
			lane: answerLane
		}, {
			laneName: "reasoning",
			lane: reasoningLane
		}];
		for (const laneState of lanesToCleanup) {
			const stream = laneState.lane.stream;
			if (!stream) continue;
			const activePreviewMessageId = stream.messageId();
			const hasBoundaryFinalizedActivePreview = laneState.laneName === "answer" && typeof activePreviewMessageId === "number" && archivedAnswerPreviews.some((p) => p.deleteIfUnused === false && p.messageId === activePreviewMessageId);
			const shouldClear = !retainPreviewOnCleanupByLane[laneState.laneName] && !hasBoundaryFinalizedActivePreview;
			const existing = streamCleanupStates.get(stream);
			if (!existing) {
				streamCleanupStates.set(stream, { shouldClear });
				continue;
			}
			existing.shouldClear = existing.shouldClear && shouldClear;
		}
		for (const [stream, cleanupState] of streamCleanupStates) {
			await stream.stop();
			if (cleanupState.shouldClear) await stream.clear();
		}
		for (const archivedPreview of archivedAnswerPreviews) {
			if (archivedPreview.deleteIfUnused === false) continue;
			try {
				await bot.api.deleteMessage(chatId, archivedPreview.messageId);
			} catch (err) {
				logVerbose(`telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`);
			}
		}
		for (const messageId of archivedReasoningPreviewIds) try {
			await bot.api.deleteMessage(chatId, messageId);
		} catch (err) {
			logVerbose(`telegram: archived reasoning preview cleanup failed (${messageId}): ${String(err)}`);
		}
	}
	let sentFallback = false;
	const deliverySummary = deliveryState.snapshot();
	if (dispatchError || !deliverySummary.delivered && (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0)) sentFallback = (await deliverReplies({
		replies: [{ text: dispatchError ? "Something went wrong while processing your request. Please try again." : EMPTY_RESPONSE_FALLBACK$1 }],
		...deliveryBaseOptions,
		silent: silentErrorReplies && (dispatchError != null || hadErrorReplyFailureOrSkip)
	})).delivered;
	const hasFinalResponse = queuedFinal || sentFallback;
	if (statusReactionController && !hasFinalResponse) statusReactionController.setError().catch((err) => {
		logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
	});
	if (!hasFinalResponse) {
		clearGroupHistory();
		return;
	}
	if (statusReactionController) statusReactionController.setDone().catch((err) => {
		logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
	});
	else removeAckReactionAfterReply({
		removeAfterReply: removeAckAfterReply,
		ackReactionPromise,
		ackReactionValue: ackReactionPromise ? "ack" : null,
		remove: () => reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve(),
		onError: (err) => {
			if (!msg.message_id) return;
			logAckFailure({
				log: logVerbose,
				channel: "telegram",
				target: `${chatId}/${msg.message_id}`,
				error: err
			});
		}
	});
	clearGroupHistory();
};
//#endregion
//#region extensions/telegram/src/bot-message.ts
init_globals();
const createTelegramMessageProcessor = (deps) => {
	const { bot, cfg, account, telegramCfg, historyLimit, groupHistories, dmPolicy, allowFrom, groupAllowFrom, ackReactionScope, logger, resolveGroupActivation, resolveGroupRequireMention, resolveTelegramGroupConfig, sendChatActionHandler, runtime, replyToMode, streamMode, textLimit, opts } = deps;
	return async (primaryCtx, allMedia, storeAllowFrom, options, replyMedia) => {
		const context = await buildTelegramMessageContext({
			primaryCtx,
			allMedia,
			replyMedia,
			storeAllowFrom,
			options,
			bot,
			cfg,
			account,
			historyLimit,
			groupHistories,
			dmPolicy,
			allowFrom,
			groupAllowFrom,
			ackReactionScope,
			logger,
			resolveGroupActivation,
			resolveGroupRequireMention,
			resolveTelegramGroupConfig,
			sendChatActionHandler
		});
		if (!context) return;
		try {
			await dispatchTelegramMessage({
				context,
				bot,
				cfg,
				runtime,
				replyToMode,
				streamMode,
				textLimit,
				telegramCfg,
				opts
			});
		} catch (err) {
			runtime.error?.(danger(`telegram message processing failed: ${String(err)}`));
			try {
				await bot.api.sendMessage(context.chatId, "Something went wrong while processing your request. Please try again.", context.threadSpec?.id != null ? { message_thread_id: context.threadSpec.id } : void 0);
			} catch {}
		}
	};
};
//#endregion
//#region extensions/telegram/src/bot-native-command-menu.ts
init_commands();
init_paths();
init_globals();
const TELEGRAM_COMMAND_RETRY_RATIO = .8;
function isBotCommandsTooMuchError(err) {
	if (!err) return false;
	const pattern = /\bBOT_COMMANDS_TOO_MUCH\b/i;
	if (typeof err === "string") return pattern.test(err);
	if (err instanceof Error) {
		if (pattern.test(err.message)) return true;
	}
	if (typeof err === "object") {
		const maybe = err;
		if (typeof maybe.description === "string" && pattern.test(maybe.description)) return true;
		if (typeof maybe.message === "string" && pattern.test(maybe.message)) return true;
	}
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
		const description = typeof spec.description === "string" ? spec.description.trim() : "";
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
	const { allCommands } = params;
	const maxCommands = params.maxCommands ?? 100;
	const totalCommands = allCommands.length;
	const overflowCount = Math.max(0, totalCommands - maxCommands);
	return {
		commandsToRegister: allCommands.slice(0, maxCommands),
		totalCommands,
		maxCommands,
		overflowCount
	};
}
/** Compute a stable hash of the command list for change detection. */
function hashCommandList(commands) {
	const sorted = [...commands].toSorted((a, b) => a.command.localeCompare(b.command));
	return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}
function hashBotIdentity(botIdentity) {
	const normalized = botIdentity?.trim();
	if (!normalized) return "no-bot";
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}
function resolveCommandHashPath(accountId, botIdentity) {
	const stateDir = resolveStateDir(process.env, os.homedir);
	const normalizedAccount = accountId?.trim().replace(/[^a-z0-9._-]+/gi, "_") || "default";
	const botHash = hashBotIdentity(botIdentity);
	return path.join(stateDir, "telegram", `command-hash-${normalizedAccount}-${botHash}.txt`);
}
async function readCachedCommandHash(accountId, botIdentity) {
	try {
		return (await fs.readFile(resolveCommandHashPath(accountId, botIdentity), "utf-8")).trim();
	} catch {
		return null;
	}
}
async function writeCachedCommandHash(accountId, botIdentity, hash) {
	const filePath = resolveCommandHashPath(accountId, botIdentity);
	try {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, hash, "utf-8");
	} catch {}
}
function syncTelegramMenuCommands(params) {
	const { bot, runtime, commandsToRegister, accountId, botIdentity } = params;
	const sync = async () => {
		const currentHash = hashCommandList(commandsToRegister);
		if (await readCachedCommandHash(accountId, botIdentity) === currentHash) {
			logVerbose("telegram: command menu unchanged; skipping sync");
			return;
		}
		let deleteSucceeded = true;
		if (typeof bot.api.deleteMyCommands === "function") deleteSucceeded = await withTelegramApiErrorLogging({
			operation: "deleteMyCommands",
			runtime,
			fn: () => bot.api.deleteMyCommands()
		}).then(() => true).catch(() => false);
		if (commandsToRegister.length === 0) {
			if (!deleteSucceeded) {
				runtime.log?.("telegram: deleteMyCommands failed; skipping empty-menu hash cache write");
				return;
			}
			await writeCachedCommandHash(accountId, botIdentity, currentHash);
			return;
		}
		let retryCommands = commandsToRegister;
		const initialCommandCount = commandsToRegister.length;
		while (retryCommands.length > 0) try {
			await withTelegramApiErrorLogging({
				operation: "setMyCommands",
				runtime,
				shouldLog: (err) => !isBotCommandsTooMuchError(err),
				fn: () => bot.api.setMyCommands(retryCommands)
			});
			if (retryCommands.length < initialCommandCount) runtime.log?.(formatTelegramCommandRetrySuccessLog({
				initialCount: initialCommandCount,
				acceptedCount: retryCommands.length
			}));
			await writeCachedCommandHash(accountId, botIdentity, currentHash);
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
//#region extensions/telegram/src/bot-native-commands.ts
init_globals();
init_session_key();
const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
async function resolveTelegramCommandAuth(params) {
	const { msg, bot, cfg, accountId, telegramCfg, allowFrom, groupAllowFrom, useAccessGroups, resolveGroupPolicy, resolveTelegramGroupConfig, requireAuth } = params;
	const chatId = msg.chat.id;
	const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
	const messageThreadId = msg.message_thread_id;
	const isForum = msg.chat.is_forum === true;
	const threadParams = buildTelegramThreadParams(resolveTelegramThreadSpec({
		isGroup,
		isForum,
		messageThreadId
	})) ?? {};
	const { resolvedThreadId, dmThreadId, storeAllowFrom, groupConfig, topicConfig, groupAllowOverride, effectiveGroupAllow, hasGroupAllowOverride } = await resolveTelegramGroupAllowFromContext({
		chatId,
		accountId,
		isGroup,
		isForum,
		messageThreadId,
		groupAllowFrom,
		resolveTelegramGroupConfig
	});
	const effectiveDmPolicy = !isGroup && groupConfig && "dmPolicy" in groupConfig ? groupConfig.dmPolicy ?? telegramCfg.dmPolicy ?? "pairing" : telegramCfg.dmPolicy ?? "pairing";
	const requireTopic = groupConfig?.requireTopic;
	if (!isGroup && requireTopic === true && dmThreadId == null) {
		logVerbose(`Blocked telegram command in DM ${chatId}: requireTopic=true but no topic present`);
		return null;
	}
	const dmAllowFrom = groupAllowOverride ?? allowFrom;
	const senderId = msg.from?.id ? String(msg.from.id) : "";
	const senderUsername = msg.from?.username ?? "";
	const commandsAllowFrom = cfg.commands?.allowFrom;
	const commandsAllowFromConfigured = commandsAllowFrom != null && typeof commandsAllowFrom === "object" && (Array.isArray(commandsAllowFrom.telegram) || Array.isArray(commandsAllowFrom["*"]));
	const commandsAllowFromAccess = commandsAllowFromConfigured ? resolveCommandAuthorization({
		ctx: {
			Provider: "telegram",
			Surface: "telegram",
			OriginatingChannel: "telegram",
			AccountId: accountId,
			ChatType: isGroup ? "group" : "direct",
			From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
			SenderId: senderId || void 0,
			SenderUsername: senderUsername || void 0
		},
		cfg,
		commandAuthorized: false
	}) : null;
	const sendAuthMessage = async (text) => {
		await withTelegramApiErrorLogging({
			operation: "sendMessage",
			fn: () => bot.api.sendMessage(chatId, text, threadParams)
		});
		return null;
	};
	const rejectNotAuthorized = async () => {
		return await sendAuthMessage("You are not authorized to use this command.");
	};
	const baseAccess = evaluateTelegramGroupBaseAccess({
		isGroup,
		groupConfig,
		topicConfig,
		hasGroupAllowOverride,
		effectiveGroupAllow,
		senderId,
		senderUsername,
		enforceAllowOverride: requireAuth,
		requireSenderForAllowOverride: true
	});
	if (!baseAccess.allowed) {
		if (baseAccess.reason === "group-disabled") return await sendAuthMessage("This group is disabled.");
		if (baseAccess.reason === "topic-disabled") return await sendAuthMessage("This topic is disabled.");
		return await rejectNotAuthorized();
	}
	const policyAccess = evaluateTelegramGroupPolicyAccess({
		isGroup,
		chatId,
		cfg,
		telegramCfg,
		topicConfig,
		groupConfig,
		effectiveGroupAllow,
		senderId,
		senderUsername,
		resolveGroupPolicy,
		enforcePolicy: useAccessGroups,
		useTopicAndGroupOverrides: false,
		enforceAllowlistAuthorization: requireAuth && !commandsAllowFromConfigured,
		allowEmptyAllowlistEntries: true,
		requireSenderForAllowlistAuthorization: true,
		checkChatAllowlist: useAccessGroups
	});
	if (!policyAccess.allowed) {
		if (policyAccess.reason === "group-policy-disabled") return await sendAuthMessage("Telegram group commands are disabled.");
		if (policyAccess.reason === "group-policy-allowlist-no-sender" || policyAccess.reason === "group-policy-allowlist-unauthorized") return await rejectNotAuthorized();
		if (policyAccess.reason === "group-chat-not-allowed") return await sendAuthMessage("This group is not allowed.");
	}
	const dmAllow = normalizeDmAllowFromWithStore({
		allowFrom: dmAllowFrom,
		storeAllowFrom: isGroup ? [] : storeAllowFrom,
		dmPolicy: effectiveDmPolicy
	});
	const senderAllowed = isSenderAllowed({
		allow: dmAllow,
		senderId,
		senderUsername
	});
	const groupSenderAllowed = isGroup ? isSenderAllowed({
		allow: effectiveGroupAllow,
		senderId,
		senderUsername
	}) : false;
	const commandAuthorized = commandsAllowFromConfigured ? Boolean(commandsAllowFromAccess?.isAuthorizedSender) : resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups,
		authorizers: [{
			configured: dmAllow.hasEntries,
			allowed: senderAllowed
		}, ...isGroup ? [{
			configured: effectiveGroupAllow.hasEntries,
			allowed: groupSenderAllowed
		}] : []],
		modeWhenAccessGroupsOff: "configured"
	});
	if (requireAuth && !commandAuthorized) return await rejectNotAuthorized();
	return {
		chatId,
		isGroup,
		isForum,
		resolvedThreadId,
		senderId,
		senderUsername,
		groupConfig,
		topicConfig,
		commandAuthorized
	};
}
const registerTelegramNativeCommands = ({ bot, cfg, runtime, accountId, telegramCfg, allowFrom, groupAllowFrom, replyToMode, textLimit, useAccessGroups, nativeEnabled, nativeSkillsEnabled, nativeDisabledExplicit, resolveGroupPolicy, resolveTelegramGroupConfig, shouldSkipUpdate, opts }) => {
	const silentErrorReplies = telegramCfg.silentErrorReplies === true;
	const boundRoute = nativeEnabled && nativeSkillsEnabled ? resolveAgentRoute({
		cfg,
		channel: "telegram",
		accountId
	}) : null;
	if (nativeEnabled && nativeSkillsEnabled && !boundRoute) runtime.log?.("nativeSkillsEnabled is true but no agent route is bound for this Telegram account; skill commands will not appear in the native menu.");
	const skillCommands = nativeEnabled && nativeSkillsEnabled && boundRoute ? listSkillCommandsForAgents({
		cfg,
		agentIds: [boundRoute.agentId]
	}) : [];
	const nativeCommands = nativeEnabled ? listNativeCommandSpecsForConfig(cfg, {
		skillCommands,
		provider: "telegram"
	}) : [];
	const reservedCommands = new Set(listNativeCommandSpecs().map((command) => normalizeTelegramCommandName(command.name)));
	for (const command of skillCommands) reservedCommands.add(command.name.toLowerCase());
	const customResolution = resolveTelegramCustomCommands({
		commands: telegramCfg.customCommands,
		reservedCommands
	});
	for (const issue of customResolution.issues) runtime.error?.(danger(issue.message));
	const customCommands = customResolution.commands;
	const pluginCatalog = buildPluginTelegramMenuCommands({
		specs: getPluginCommandSpecs("telegram"),
		existingCommands: new Set([...nativeCommands.map((command) => normalizeTelegramCommandName(command.name)), ...customCommands.map((command) => command.command)].map((command) => command.toLowerCase()))
	});
	for (const issue of pluginCatalog.issues) runtime.error?.(danger(issue));
	const { commandsToRegister, totalCommands, maxCommands, overflowCount } = buildCappedTelegramMenuCommands({ allCommands: [
		...nativeCommands.map((command) => {
			const normalized = normalizeTelegramCommandName(command.name);
			if (!TELEGRAM_COMMAND_NAME_PATTERN.test(normalized)) {
				runtime.error?.(danger(`Native command "${command.name}" is invalid for Telegram (resolved to "${normalized}"). Skipping.`));
				return null;
			}
			return {
				command: normalized,
				description: command.description
			};
		}).filter((cmd) => cmd !== null),
		...nativeEnabled ? pluginCatalog.commands : [],
		...customCommands
	] });
	if (overflowCount > 0) runtime.log?.(`Telegram limits bots to ${maxCommands} commands. ${totalCommands} configured; registering first ${maxCommands}. Use channels.telegram.commands.native: false to disable, or reduce plugin/skill/custom commands.`);
	syncTelegramMenuCommands({
		bot,
		runtime,
		commandsToRegister,
		accountId,
		botIdentity: opts.token
	});
	const resolveCommandRuntimeContext = async (params) => {
		const { msg, isGroup, isForum, resolvedThreadId, senderId, topicAgentId } = params;
		const chatId = msg.chat.id;
		const messageThreadId = msg.message_thread_id;
		const threadSpec = resolveTelegramThreadSpec({
			isGroup,
			isForum,
			messageThreadId
		});
		let { route, configuredBinding } = resolveTelegramConversationRoute({
			cfg,
			accountId,
			chatId,
			isGroup,
			resolvedThreadId,
			replyThreadId: threadSpec.id,
			senderId,
			topicAgentId
		});
		if (configuredBinding) {
			const ensured = await ensureConfiguredAcpRouteReady({
				cfg,
				configuredBinding
			});
			if (!ensured.ok) {
				logVerbose(`telegram native command: configured ACP binding unavailable for topic ${configuredBinding.spec.conversationId}: ${ensured.error}`);
				await withTelegramApiErrorLogging({
					operation: "sendMessage",
					runtime,
					fn: () => bot.api.sendMessage(chatId, "Configured ACP binding is unavailable right now. Please try again.", buildTelegramThreadParams(threadSpec) ?? {})
				});
				return null;
			}
		}
		return {
			chatId,
			threadSpec,
			route,
			mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, route.agentId),
			tableMode: resolveMarkdownTableMode({
				cfg,
				channel: "telegram",
				accountId: route.accountId
			}),
			chunkMode: resolveChunkMode(cfg, "telegram", route.accountId)
		};
	};
	const buildCommandDeliveryBaseOptions = (params) => ({
		chatId: String(params.chatId),
		accountId: params.accountId,
		sessionKeyForInternalHooks: params.sessionKeyForInternalHooks,
		mirrorIsGroup: params.mirrorIsGroup,
		mirrorGroupId: params.mirrorGroupId,
		token: opts.token,
		runtime,
		bot,
		mediaLocalRoots: params.mediaLocalRoots,
		replyToMode,
		textLimit,
		thread: params.threadSpec,
		tableMode: params.tableMode,
		chunkMode: params.chunkMode,
		linkPreview: telegramCfg.linkPreview
	});
	if (commandsToRegister.length > 0 || pluginCatalog.commands.length > 0) if (typeof bot.command !== "function") logVerbose("telegram: bot.command unavailable; skipping native handlers");
	else {
		for (const command of nativeCommands) {
			const normalizedCommandName = normalizeTelegramCommandName(command.name);
			bot.command(normalizedCommandName, async (ctx) => {
				const msg = ctx.message;
				if (!msg) return;
				if (shouldSkipUpdate(ctx)) return;
				const auth = await resolveTelegramCommandAuth({
					msg,
					bot,
					cfg,
					accountId,
					telegramCfg,
					allowFrom,
					groupAllowFrom,
					useAccessGroups,
					resolveGroupPolicy,
					resolveTelegramGroupConfig,
					requireAuth: true
				});
				if (!auth) return;
				const { chatId, isGroup, isForum, resolvedThreadId, senderId, senderUsername, groupConfig, topicConfig, commandAuthorized } = auth;
				const runtimeContext = await resolveCommandRuntimeContext({
					msg,
					isGroup,
					isForum,
					resolvedThreadId,
					senderId,
					topicAgentId: topicConfig?.agentId
				});
				if (!runtimeContext) return;
				const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
				const threadParams = buildTelegramThreadParams(threadSpec) ?? {};
				const commandDefinition = findCommandByNativeName(command.name, "telegram");
				const rawText = ctx.match?.trim() ?? "";
				const commandArgs = commandDefinition ? parseCommandArgs(commandDefinition, rawText) : rawText ? { raw: rawText } : void 0;
				const prompt = commandDefinition ? buildCommandTextFromArgs(commandDefinition, commandArgs) : rawText ? `/${command.name} ${rawText}` : `/${command.name}`;
				const menu = commandDefinition ? resolveCommandArgMenu({
					command: commandDefinition,
					args: commandArgs,
					cfg
				}) : null;
				if (menu && commandDefinition) {
					const title = menu.title ?? `Choose ${menu.arg.description || menu.arg.name} for /${commandDefinition.nativeName ?? commandDefinition.key}.`;
					const rows = [];
					for (let i = 0; i < menu.choices.length; i += 2) {
						const slice = menu.choices.slice(i, i + 2);
						rows.push(slice.map((choice) => {
							const args = { values: { [menu.arg.name]: choice.value } };
							return {
								text: choice.label,
								callback_data: buildCommandTextFromArgs(commandDefinition, args)
							};
						}));
					}
					const replyMarkup = buildInlineKeyboard(rows);
					await withTelegramApiErrorLogging({
						operation: "sendMessage",
						runtime,
						fn: () => bot.api.sendMessage(chatId, title, {
							...replyMarkup ? { reply_markup: replyMarkup } : {},
							...threadParams
						})
					});
					return;
				}
				const baseSessionKey = route.sessionKey;
				const dmThreadId = threadSpec.scope === "dm" ? threadSpec.id : void 0;
				const sessionKey = (dmThreadId != null ? resolveThreadSessionKeys({
					baseSessionKey,
					threadId: `${chatId}:${dmThreadId}`
				}) : null)?.sessionKey ?? baseSessionKey;
				const { skillFilter, groupSystemPrompt } = resolveTelegramGroupPromptSettings({
					groupConfig,
					topicConfig
				});
				const { sessionKey: commandSessionKey, commandTargetSessionKey } = resolveNativeCommandSessionTargets({
					agentId: route.agentId,
					sessionPrefix: "telegram:slash",
					userId: String(senderId || chatId),
					targetSessionKey: sessionKey
				});
				const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
					chatId,
					accountId: route.accountId,
					sessionKeyForInternalHooks: commandSessionKey,
					mirrorIsGroup: isGroup,
					mirrorGroupId: isGroup ? String(chatId) : void 0,
					mediaLocalRoots,
					threadSpec,
					tableMode,
					chunkMode
				});
				const conversationLabel = isGroup ? msg.chat.title ? `${msg.chat.title} id:${chatId}` : `group:${chatId}` : buildSenderName(msg) ?? String(senderId || chatId);
				const ctxPayload = finalizeInboundContext({
					Body: prompt,
					BodyForAgent: prompt,
					RawBody: prompt,
					CommandBody: prompt,
					CommandArgs: commandArgs,
					From: isGroup ? buildTelegramGroupFrom(chatId, resolvedThreadId) : `telegram:${chatId}`,
					To: `slash:${senderId || chatId}`,
					ChatType: isGroup ? "group" : "direct",
					ConversationLabel: conversationLabel,
					GroupSubject: isGroup ? msg.chat.title ?? void 0 : void 0,
					GroupSystemPrompt: isGroup || !isGroup && groupConfig ? groupSystemPrompt : void 0,
					SenderName: buildSenderName(msg),
					SenderId: senderId || void 0,
					SenderUsername: senderUsername || void 0,
					Surface: "telegram",
					Provider: "telegram",
					MessageSid: String(msg.message_id),
					Timestamp: msg.date ? msg.date * 1e3 : void 0,
					WasMentioned: true,
					CommandAuthorized: commandAuthorized,
					CommandSource: "native",
					SessionKey: commandSessionKey,
					AccountId: route.accountId,
					CommandTargetSessionKey: commandTargetSessionKey,
					MessageThreadId: threadSpec.id,
					IsForum: isForum,
					OriginatingChannel: "telegram",
					OriginatingTo: `telegram:${chatId}`
				});
				await recordInboundSessionMetaSafe({
					cfg,
					agentId: route.agentId,
					sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
					ctx: ctxPayload,
					onError: (err) => runtime.error?.(danger(`telegram slash: failed updating session meta: ${String(err)}`))
				});
				const disableBlockStreaming = typeof telegramCfg.blockStreaming === "boolean" ? !telegramCfg.blockStreaming : void 0;
				const deliveryState = {
					delivered: false,
					skippedNonSilent: 0
				};
				const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
					cfg,
					agentId: route.agentId,
					channel: "telegram",
					accountId: route.accountId
				});
				await dispatchReplyWithBufferedBlockDispatcher({
					ctx: ctxPayload,
					cfg,
					dispatcherOptions: {
						...prefixOptions,
						deliver: async (payload, _info) => {
							if (shouldSuppressLocalTelegramExecApprovalPrompt({
								cfg,
								accountId: route.accountId,
								payload
							})) {
								deliveryState.delivered = true;
								return;
							}
							if ((await deliverReplies({
								replies: [payload],
								...deliveryBaseOptions,
								silent: silentErrorReplies && payload.isError === true
							})).delivered) deliveryState.delivered = true;
						},
						onSkip: (_payload, info) => {
							if (info.reason !== "silent") deliveryState.skippedNonSilent += 1;
						},
						onError: (err, info) => {
							runtime.error?.(danger(`telegram slash ${info.kind} reply failed: ${String(err)}`));
						}
					},
					replyOptions: {
						skillFilter,
						disableBlockStreaming,
						onModelSelected
					}
				});
				if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) await deliverReplies({
					replies: [{ text: EMPTY_RESPONSE_FALLBACK }],
					...deliveryBaseOptions
				});
			});
		}
		for (const pluginCommand of pluginCatalog.commands) bot.command(pluginCommand.command, async (ctx) => {
			const msg = ctx.message;
			if (!msg) return;
			if (shouldSkipUpdate(ctx)) return;
			const chatId = msg.chat.id;
			const rawText = ctx.match?.trim() ?? "";
			const commandBody = `/${pluginCommand.command}${rawText ? ` ${rawText}` : ""}`;
			const match = matchPluginCommand(commandBody);
			if (!match) {
				await withTelegramApiErrorLogging({
					operation: "sendMessage",
					runtime,
					fn: () => bot.api.sendMessage(chatId, "Command not found.")
				});
				return;
			}
			const auth = await resolveTelegramCommandAuth({
				msg,
				bot,
				cfg,
				accountId,
				telegramCfg,
				allowFrom,
				groupAllowFrom,
				useAccessGroups,
				resolveGroupPolicy,
				resolveTelegramGroupConfig,
				requireAuth: match.command.requireAuth !== false
			});
			if (!auth) return;
			const { senderId, commandAuthorized, isGroup, isForum, resolvedThreadId } = auth;
			const runtimeContext = await resolveCommandRuntimeContext({
				msg,
				isGroup,
				isForum,
				resolvedThreadId,
				senderId,
				topicAgentId: auth.topicConfig?.agentId
			});
			if (!runtimeContext) return;
			const { threadSpec, route, mediaLocalRoots, tableMode, chunkMode } = runtimeContext;
			const deliveryBaseOptions = buildCommandDeliveryBaseOptions({
				chatId,
				accountId: route.accountId,
				sessionKeyForInternalHooks: route.sessionKey,
				mirrorIsGroup: isGroup,
				mirrorGroupId: isGroup ? String(chatId) : void 0,
				mediaLocalRoots,
				threadSpec,
				tableMode,
				chunkMode
			});
			const from = isGroup ? buildTelegramGroupFrom(chatId, threadSpec.id) : `telegram:${chatId}`;
			const to = `telegram:${chatId}`;
			const result = await executePluginCommand({
				command: match.command,
				args: match.args,
				senderId,
				channel: "telegram",
				isAuthorizedSender: commandAuthorized,
				commandBody,
				config: cfg,
				from,
				to,
				accountId,
				messageThreadId: threadSpec.id
			});
			if (!shouldSuppressLocalTelegramExecApprovalPrompt({
				cfg,
				accountId: route.accountId,
				payload: result
			})) await deliverReplies({
				replies: [result],
				...deliveryBaseOptions,
				silent: silentErrorReplies && result.isError === true
			});
		});
	}
	else if (nativeDisabledExplicit) withTelegramApiErrorLogging({
		operation: "setMyCommands",
		runtime,
		fn: () => bot.api.setMyCommands([])
	}).catch(() => {});
};
//#endregion
//#region extensions/telegram/src/sendchataction-401-backoff.ts
const BACKOFF_POLICY = {
	initialMs: 1e3,
	maxMs: 3e5,
	factor: 2,
	jitter: .1
};
function is401Error(error) {
	if (!error) return false;
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	return message.includes("401") || message.toLowerCase().includes("unauthorized");
}
/**
* Creates a GLOBAL (per-account) handler for sendChatAction that tracks 401 errors
* across all message contexts. This prevents the infinite loop that caused Telegram
* to delete bots (issue #27092).
*
* When a 401 occurs, exponential backoff is applied (1s → 2s → 4s → ... → 5min).
* After maxConsecutive401 failures (default 10), all sendChatAction calls are
* suspended until reset() is called.
*/
function createTelegramSendChatActionHandler({ sendChatActionFn, logger, maxConsecutive401 = 10 }) {
	let consecutive401Failures = 0;
	let suspended = false;
	const reset = () => {
		consecutive401Failures = 0;
		suspended = false;
	};
	const sendChatAction = async (chatId, action, threadParams) => {
		if (suspended) return;
		if (consecutive401Failures > 0) {
			const backoffMs = computeBackoff(BACKOFF_POLICY, consecutive401Failures);
			logger(`sendChatAction backoff: waiting ${backoffMs}ms before retry (failure ${consecutive401Failures}/${maxConsecutive401})`);
			await sleepWithAbort(backoffMs);
		}
		try {
			await sendChatActionFn(chatId, action, threadParams);
			if (consecutive401Failures > 0) {
				logger(`sendChatAction recovered after ${consecutive401Failures} consecutive 401 failures`);
				consecutive401Failures = 0;
			}
		} catch (error) {
			if (is401Error(error)) {
				consecutive401Failures++;
				if (consecutive401Failures >= maxConsecutive401) {
					suspended = true;
					logger(`CRITICAL: sendChatAction suspended after ${consecutive401Failures} consecutive 401 errors. Bot token is likely invalid. Telegram may DELETE the bot if requests continue. Replace the token and restart: openclaw channels restart telegram`);
				} else logger(`sendChatAction 401 error (${consecutive401Failures}/${maxConsecutive401}). Retrying with exponential backoff.`);
			}
			throw error;
		}
	};
	return {
		sendChatAction,
		isSuspended: () => suspended,
		reset
	};
}
//#endregion
//#region extensions/telegram/src/sequential-key.ts
function getTelegramSequentialKey(ctx) {
	const reaction = ctx.update?.message_reaction;
	if (reaction?.chat?.id) return `telegram:${reaction.chat.id}`;
	const msg = ctx.message ?? ctx.channelPost ?? ctx.editedChannelPost ?? ctx.update?.message ?? ctx.update?.edited_message ?? ctx.update?.channel_post ?? ctx.update?.edited_channel_post ?? ctx.update?.callback_query?.message;
	const chatId = msg?.chat?.id ?? ctx.chat?.id;
	const rawText = msg?.text ?? msg?.caption;
	const botUsername = ctx.me?.username;
	if (isAbortRequestText(rawText, botUsername ? { botUsername } : void 0)) {
		if (typeof chatId === "number") return `telegram:${chatId}:control`;
		return "telegram:control";
	}
	if (isBtwRequestText(rawText, botUsername ? { botUsername } : void 0)) {
		const messageId = msg?.message_id;
		if (typeof chatId === "number" && typeof messageId === "number") return `telegram:${chatId}:btw:${messageId}`;
		if (typeof chatId === "number") return `telegram:${chatId}:btw`;
		return "telegram:btw";
	}
	const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
	const messageThreadId = msg?.message_thread_id;
	const isForum = msg?.chat?.is_forum;
	const threadId = isGroup ? resolveTelegramForumThreadId({
		isForum,
		messageThreadId
	}) : messageThreadId;
	if (typeof chatId === "number") return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
	return "telegram:unknown";
}
//#endregion
//#region extensions/telegram/src/bot.ts
init_globals();
init_subsystem();
function readRequestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	if (typeof input === "object" && input !== null && "url" in input) {
		const url = input.url;
		return typeof url === "string" ? url : null;
	}
	return null;
}
function extractTelegramApiMethod(input) {
	const url = readRequestUrl(input);
	if (!url) return null;
	try {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		return segments.length > 0 ? segments.at(-1) ?? null : null;
	} catch {
		return null;
	}
}
function createTelegramBot(opts) {
	const runtime = opts.runtime ?? createNonExitingRuntime();
	const cfg = opts.config ?? loadConfig();
	const account = resolveTelegramAccount({
		cfg,
		accountId: opts.accountId
	});
	const threadBindingManager = resolveThreadBindingSpawnPolicy({
		cfg,
		channel: "telegram",
		accountId: account.accountId,
		kind: "subagent"
	}).enabled ? createTelegramThreadBindingManager({
		accountId: account.accountId,
		idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
			cfg,
			channel: "telegram",
			accountId: account.accountId
		}),
		maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
			cfg,
			channel: "telegram",
			accountId: account.accountId
		})
	}) : null;
	const telegramCfg = account.config;
	const telegramTransport = resolveTelegramTransport(opts.proxyFetch, { network: telegramCfg.network });
	const shouldProvideFetch = Boolean(telegramTransport.fetch);
	const fetchForClient = telegramTransport.fetch;
	let finalFetch = shouldProvideFetch ? fetchForClient : void 0;
	if (opts.fetchAbortSignal) {
		const baseFetch = finalFetch ?? globalThis.fetch;
		const shutdownSignal = opts.fetchAbortSignal;
		const callFetch = baseFetch;
		finalFetch = ((input, init) => {
			const controller = new AbortController();
			const abortWith = (signal) => controller.abort(signal.reason);
			const onShutdown = () => abortWith(shutdownSignal);
			let onRequestAbort;
			if (shutdownSignal.aborted) abortWith(shutdownSignal);
			else shutdownSignal.addEventListener("abort", onShutdown, { once: true });
			if (init?.signal) if (init.signal.aborted) abortWith(init.signal);
			else {
				onRequestAbort = () => abortWith(init.signal);
				init.signal.addEventListener("abort", onRequestAbort);
			}
			return callFetch(input, {
				...init,
				signal: controller.signal
			}).finally(() => {
				shutdownSignal.removeEventListener("abort", onShutdown);
				if (init?.signal && onRequestAbort) init.signal.removeEventListener("abort", onRequestAbort);
			});
		});
	}
	if (finalFetch) {
		const baseFetch = finalFetch;
		finalFetch = ((input, init) => {
			return Promise.resolve(baseFetch(input, init)).catch((err) => {
				try {
					tagTelegramNetworkError(err, {
						method: extractTelegramApiMethod(input),
						url: readRequestUrl(input)
					});
				} catch {}
				throw err;
			});
		});
	}
	const timeoutSeconds = typeof telegramCfg?.timeoutSeconds === "number" && Number.isFinite(telegramCfg.timeoutSeconds) ? Math.max(1, Math.floor(telegramCfg.timeoutSeconds)) : void 0;
	const client = finalFetch || timeoutSeconds ? {
		...finalFetch ? { fetch: finalFetch } : {},
		...timeoutSeconds ? { timeoutSeconds } : {}
	} : void 0;
	const bot = new Bot(opts.token, client ? { client } : void 0);
	bot.api.config.use(apiThrottler());
	bot.catch((err) => {
		runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
	});
	const recentUpdates = createTelegramUpdateDedupe();
	const initialUpdateId = typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
	const pendingUpdateIds = /* @__PURE__ */ new Set();
	let highestCompletedUpdateId = initialUpdateId;
	let highestPersistedUpdateId = initialUpdateId;
	const maybePersistSafeWatermark = () => {
		if (typeof opts.updateOffset?.onUpdateId !== "function") return;
		if (highestCompletedUpdateId === null) return;
		let safe = highestCompletedUpdateId;
		if (pendingUpdateIds.size > 0) {
			let minPending = null;
			for (const id of pendingUpdateIds) if (minPending === null || id < minPending) minPending = id;
			if (minPending !== null) safe = Math.min(safe, minPending - 1);
		}
		if (highestPersistedUpdateId !== null && safe <= highestPersistedUpdateId) return;
		highestPersistedUpdateId = safe;
		opts.updateOffset.onUpdateId(safe);
	};
	const shouldSkipUpdate = (ctx) => {
		const updateId = resolveTelegramUpdateId(ctx);
		const skipCutoff = highestPersistedUpdateId ?? initialUpdateId;
		if (typeof updateId === "number" && skipCutoff !== null && updateId <= skipCutoff) return true;
		const key = buildTelegramUpdateKey(ctx);
		const skipped = recentUpdates.check(key);
		if (skipped && key && shouldLogVerbose()) logVerbose(`telegram dedupe: skipped ${key}`);
		return skipped;
	};
	bot.use(async (ctx, next) => {
		const updateId = resolveTelegramUpdateId(ctx);
		if (typeof updateId === "number") pendingUpdateIds.add(updateId);
		try {
			await next();
		} finally {
			if (typeof updateId === "number") {
				pendingUpdateIds.delete(updateId);
				if (highestCompletedUpdateId === null || updateId > highestCompletedUpdateId) highestCompletedUpdateId = updateId;
				maybePersistSafeWatermark();
			}
		}
	});
	bot.use(sequentialize(getTelegramSequentialKey));
	const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
	const MAX_RAW_UPDATE_CHARS = 8e3;
	const MAX_RAW_UPDATE_STRING = 500;
	const MAX_RAW_UPDATE_ARRAY = 20;
	const stringifyUpdate = (update) => {
		const seen = /* @__PURE__ */ new WeakSet();
		return JSON.stringify(update ?? null, (key, value) => {
			if (typeof value === "string" && value.length > MAX_RAW_UPDATE_STRING) return `${value.slice(0, MAX_RAW_UPDATE_STRING)}...`;
			if (Array.isArray(value) && value.length > MAX_RAW_UPDATE_ARRAY) return [...value.slice(0, MAX_RAW_UPDATE_ARRAY), `...(${value.length - MAX_RAW_UPDATE_ARRAY} more)`];
			if (value && typeof value === "object") {
				if (seen.has(value)) return "[Circular]";
				seen.add(value);
			}
			return value;
		});
	};
	bot.use(async (ctx, next) => {
		if (shouldLogVerbose()) try {
			const raw = stringifyUpdate(ctx.update);
			const preview = raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
			rawUpdateLogger.debug(`telegram update: ${preview}`);
		} catch (err) {
			rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
		}
		await next();
	});
	const historyLimit = Math.max(0, telegramCfg.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? 50);
	const groupHistories = /* @__PURE__ */ new Map();
	const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
	const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
	const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
	const groupAllowFrom = opts.groupAllowFrom ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom ?? allowFrom;
	const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "off";
	const nativeEnabled = resolveNativeCommandsEnabled({
		providerId: "telegram",
		providerSetting: telegramCfg.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const nativeSkillsEnabled = resolveNativeSkillsEnabled({
		providerId: "telegram",
		providerSetting: telegramCfg.commands?.nativeSkills,
		globalSetting: cfg.commands?.nativeSkills
	});
	const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
		providerSetting: telegramCfg.commands?.native,
		globalSetting: cfg.commands?.native
	});
	const useAccessGroups = cfg.commands?.useAccessGroups !== false;
	const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
	const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
	const logger = getChildLogger({ module: "telegram-auto-reply" });
	const streamMode = resolveTelegramStreamMode(telegramCfg);
	const resolveGroupPolicy = (chatId) => resolveChannelGroupPolicy({
		cfg,
		channel: "telegram",
		accountId: account.accountId,
		groupId: String(chatId)
	});
	const resolveGroupActivation = (params) => {
		const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
		const sessionKey = params.sessionKey ?? `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
		const storePath = resolveStorePath(cfg.session?.store, { agentId });
		try {
			const entry = loadSessionStore(storePath)[sessionKey];
			if (entry?.groupActivation === "always") return false;
			if (entry?.groupActivation === "mention") return true;
		} catch (err) {
			logVerbose(`Failed to load session for activation check: ${String(err)}`);
		}
	};
	const resolveGroupRequireMention = (chatId) => resolveChannelGroupRequireMention({
		cfg,
		channel: "telegram",
		accountId: account.accountId,
		groupId: String(chatId),
		requireMentionOverride: opts.requireMention,
		overrideOrder: "after-config"
	});
	const resolveTelegramGroupConfig = (chatId, messageThreadId) => {
		const groups = telegramCfg.groups;
		const direct = telegramCfg.direct;
		const chatIdStr = String(chatId);
		if (!chatIdStr.startsWith("-")) {
			const directConfig = direct?.[chatIdStr] ?? direct?.["*"];
			if (directConfig) return {
				groupConfig: directConfig,
				topicConfig: messageThreadId != null ? directConfig.topics?.[String(messageThreadId)] : void 0
			};
			return {
				groupConfig: void 0,
				topicConfig: void 0
			};
		}
		if (!groups) return {
			groupConfig: void 0,
			topicConfig: void 0
		};
		const groupConfig = groups[chatIdStr] ?? groups["*"];
		return {
			groupConfig,
			topicConfig: messageThreadId != null ? groupConfig?.topics?.[String(messageThreadId)] : void 0
		};
	};
	const processMessage = createTelegramMessageProcessor({
		bot,
		cfg,
		account,
		telegramCfg,
		historyLimit,
		groupHistories,
		dmPolicy,
		allowFrom,
		groupAllowFrom,
		ackReactionScope,
		logger,
		resolveGroupActivation,
		resolveGroupRequireMention,
		resolveTelegramGroupConfig,
		sendChatActionHandler: createTelegramSendChatActionHandler({
			sendChatActionFn: (chatId, action, threadParams) => bot.api.sendChatAction(chatId, action, threadParams),
			logger: (message) => logVerbose(`telegram: ${message}`)
		}),
		runtime,
		replyToMode,
		streamMode,
		textLimit,
		opts
	});
	registerTelegramNativeCommands({
		bot,
		cfg,
		runtime,
		accountId: account.accountId,
		telegramCfg,
		allowFrom,
		groupAllowFrom,
		replyToMode,
		textLimit,
		useAccessGroups,
		nativeEnabled,
		nativeSkillsEnabled,
		nativeDisabledExplicit,
		resolveGroupPolicy,
		resolveTelegramGroupConfig,
		shouldSkipUpdate,
		opts
	});
	registerTelegramHandlers({
		cfg,
		accountId: account.accountId,
		bot,
		opts,
		telegramTransport,
		runtime,
		mediaMaxBytes,
		telegramCfg,
		allowFrom,
		groupAllowFrom,
		resolveGroupPolicy,
		resolveTelegramGroupConfig,
		shouldSkipUpdate,
		processMessage,
		logger
	});
	const originalStop = bot.stop.bind(bot);
	bot.stop = ((...args) => {
		threadBindingManager?.stop();
		return originalStop(...args);
	});
	return bot;
}
//#endregion
//#region extensions/telegram/src/polling-session.ts
const TELEGRAM_POLL_RESTART_POLICY = {
	initialMs: 2e3,
	maxMs: 3e4,
	factor: 1.8,
	jitter: .25
};
const POLL_STALL_THRESHOLD_MS = 9e4;
const POLL_WATCHDOG_INTERVAL_MS = 3e4;
const POLL_STOP_GRACE_MS = 15e3;
const waitForGracefulStop = async (stop) => {
	let timer;
	try {
		await Promise.race([stop(), new Promise((resolve) => {
			timer = setTimeout(resolve, POLL_STOP_GRACE_MS);
			timer.unref?.();
		})]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};
var TelegramPollingSession = class {
	#restartAttempts = 0;
	#webhookCleared = false;
	#forceRestarted = false;
	#activeRunner;
	#activeFetchAbort;
	constructor(opts) {
		this.opts = opts;
	}
	get activeRunner() {
		return this.#activeRunner;
	}
	markForceRestarted() {
		this.#forceRestarted = true;
	}
	abortActiveFetch() {
		this.#activeFetchAbort?.abort();
	}
	async runUntilAbort() {
		while (!this.opts.abortSignal?.aborted) {
			const bot = await this.#createPollingBot();
			if (!bot) continue;
			const cleanupState = await this.#ensureWebhookCleanup(bot);
			if (cleanupState === "retry") continue;
			if (cleanupState === "exit") return;
			if (await this.#runPollingCycle(bot) === "exit") return;
		}
	}
	async #waitBeforeRestart(buildLine) {
		this.#restartAttempts += 1;
		const delayMs = computeBackoff(TELEGRAM_POLL_RESTART_POLICY, this.#restartAttempts);
		const delay = formatDurationPrecise(delayMs);
		this.opts.log(buildLine(delay));
		try {
			await sleepWithAbort(delayMs, this.opts.abortSignal);
		} catch (sleepErr) {
			if (this.opts.abortSignal?.aborted) return false;
			throw sleepErr;
		}
		return true;
	}
	async #waitBeforeRetryOnRecoverableSetupError(err, logPrefix) {
		if (this.opts.abortSignal?.aborted) return false;
		if (!isRecoverableTelegramNetworkError(err, { context: "unknown" })) throw err;
		return this.#waitBeforeRestart((delay) => `${logPrefix}: ${formatErrorMessage(err)}; retrying in ${delay}.`);
	}
	async #createPollingBot() {
		const fetchAbortController = new AbortController();
		this.#activeFetchAbort = fetchAbortController;
		try {
			return createTelegramBot({
				token: this.opts.token,
				runtime: this.opts.runtime,
				proxyFetch: this.opts.proxyFetch,
				config: this.opts.config,
				accountId: this.opts.accountId,
				fetchAbortSignal: fetchAbortController.signal,
				updateOffset: {
					lastUpdateId: this.opts.getLastUpdateId(),
					onUpdateId: this.opts.persistUpdateId
				}
			});
		} catch (err) {
			await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram setup network error");
			if (this.#activeFetchAbort === fetchAbortController) this.#activeFetchAbort = void 0;
			return;
		}
	}
	async #ensureWebhookCleanup(bot) {
		if (this.#webhookCleared) return "ready";
		try {
			await withTelegramApiErrorLogging({
				operation: "deleteWebhook",
				runtime: this.opts.runtime,
				fn: () => bot.api.deleteWebhook({ drop_pending_updates: false })
			});
			this.#webhookCleared = true;
			return "ready";
		} catch (err) {
			return await this.#waitBeforeRetryOnRecoverableSetupError(err, "Telegram webhook cleanup failed") ? "retry" : "exit";
		}
	}
	async #confirmPersistedOffset(bot) {
		const lastUpdateId = this.opts.getLastUpdateId();
		if (lastUpdateId === null || lastUpdateId >= Number.MAX_SAFE_INTEGER) return;
		try {
			await bot.api.getUpdates({
				offset: lastUpdateId + 1,
				limit: 1,
				timeout: 0
			});
		} catch {}
	}
	async #runPollingCycle(bot) {
		await this.#confirmPersistedOffset(bot);
		let lastGetUpdatesAt = Date.now();
		bot.api.config.use((prev, method, payload, signal) => {
			if (method === "getUpdates") lastGetUpdatesAt = Date.now();
			return prev(method, payload, signal);
		});
		const runner = run(bot, this.opts.runnerOptions);
		this.#activeRunner = runner;
		const fetchAbortController = this.#activeFetchAbort;
		let stopPromise;
		let stalledRestart = false;
		let forceCycleTimer;
		let forceCycleResolve;
		const forceCyclePromise = new Promise((resolve) => {
			forceCycleResolve = resolve;
		});
		const stopRunner = () => {
			fetchAbortController?.abort();
			stopPromise ??= Promise.resolve(runner.stop()).then(() => void 0).catch(() => {});
			return stopPromise;
		};
		const stopBot = () => {
			return Promise.resolve(bot.stop()).then(() => void 0).catch(() => {});
		};
		const stopOnAbort = () => {
			if (this.opts.abortSignal?.aborted) stopRunner();
		};
		const watchdog = setInterval(() => {
			if (this.opts.abortSignal?.aborted) return;
			const elapsed = Date.now() - lastGetUpdatesAt;
			if (elapsed > POLL_STALL_THRESHOLD_MS && runner.isRunning()) {
				stalledRestart = true;
				this.opts.log(`[telegram] Polling stall detected (no getUpdates for ${formatDurationPrecise(elapsed)}); forcing restart.`);
				stopRunner();
				stopBot();
				if (!forceCycleTimer) forceCycleTimer = setTimeout(() => {
					if (this.opts.abortSignal?.aborted) return;
					this.opts.log(`[telegram] Polling runner stop timed out after ${formatDurationPrecise(POLL_STOP_GRACE_MS)}; forcing restart cycle.`);
					forceCycleResolve?.();
				}, POLL_STOP_GRACE_MS);
			}
		}, POLL_WATCHDOG_INTERVAL_MS);
		this.opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
		try {
			await Promise.race([runner.task(), forceCyclePromise]);
			if (this.opts.abortSignal?.aborted) return "exit";
			const reason = stalledRestart ? "polling stall detected" : this.#forceRestarted ? "unhandled network error" : "runner stopped (maxRetryTime exceeded or graceful stop)";
			this.#forceRestarted = false;
			return await this.#waitBeforeRestart((delay) => `Telegram polling runner stopped (${reason}); restarting in ${delay}.`) ? "continue" : "exit";
		} catch (err) {
			this.#forceRestarted = false;
			if (this.opts.abortSignal?.aborted) throw err;
			const isConflict = isGetUpdatesConflict(err);
			if (isConflict) this.#webhookCleared = false;
			const isRecoverable = isRecoverableTelegramNetworkError(err, { context: "polling" });
			if (!isConflict && !isRecoverable) throw err;
			const reason = isConflict ? "getUpdates conflict" : "network error";
			const errMsg = formatErrorMessage(err);
			return await this.#waitBeforeRestart((delay) => `Telegram ${reason}: ${errMsg}; retrying in ${delay}.`) ? "continue" : "exit";
		} finally {
			clearInterval(watchdog);
			if (forceCycleTimer) clearTimeout(forceCycleTimer);
			this.opts.abortSignal?.removeEventListener("abort", stopOnAbort);
			await waitForGracefulStop(stopRunner);
			await waitForGracefulStop(stopBot);
			this.#activeRunner = void 0;
			if (this.#activeFetchAbort === fetchAbortController) this.#activeFetchAbort = void 0;
		}
	}
};
const isGetUpdatesConflict = (err) => {
	if (!err || typeof err !== "object") return false;
	const typed = err;
	if ((typed.error_code ?? typed.errorCode) !== 409) return false;
	return [
		typed.method,
		typed.description,
		typed.message
	].filter((value) => typeof value === "string").join(" ").toLowerCase().includes("getupdates");
};
//#endregion
//#region extensions/telegram/src/update-offset-store.ts
init_paths();
const STORE_VERSION = 2;
function isValidUpdateId(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function normalizeAccountId(accountId) {
	const trimmed = accountId?.trim();
	if (!trimmed) return "default";
	return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
function resolveTelegramUpdateOffsetPath(accountId, env = process.env) {
	const stateDir = resolveStateDir(env, os.homedir);
	const normalized = normalizeAccountId(accountId);
	return path.join(stateDir, "telegram", `update-offset-${normalized}.json`);
}
function extractBotIdFromToken(token) {
	const trimmed = token?.trim();
	if (!trimmed) return null;
	const [rawBotId] = trimmed.split(":", 1);
	if (!rawBotId || !/^\d+$/.test(rawBotId)) return null;
	return rawBotId;
}
function safeParseState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed?.version !== STORE_VERSION && parsed?.version !== 1) return null;
		if (parsed.lastUpdateId !== null && !isValidUpdateId(parsed.lastUpdateId)) return null;
		if (parsed.version === STORE_VERSION && parsed.botId !== null && typeof parsed.botId !== "string") return null;
		return {
			version: STORE_VERSION,
			lastUpdateId: parsed.lastUpdateId ?? null,
			botId: parsed.version === STORE_VERSION ? parsed.botId ?? null : null
		};
	} catch {
		return null;
	}
}
async function readTelegramUpdateOffset(params) {
	const filePath = resolveTelegramUpdateOffsetPath(params.accountId, params.env);
	try {
		const parsed = safeParseState(await fs.readFile(filePath, "utf-8"));
		const expectedBotId = extractBotIdFromToken(params.botToken);
		if (expectedBotId && parsed?.botId && parsed.botId !== expectedBotId) return null;
		if (expectedBotId && parsed?.botId === null) return null;
		return parsed?.lastUpdateId ?? null;
	} catch (err) {
		if (err.code === "ENOENT") return null;
		return null;
	}
}
async function writeTelegramUpdateOffset(params) {
	if (!isValidUpdateId(params.updateId)) throw new Error("Telegram update offset must be a non-negative safe integer.");
	await writeJsonAtomic(resolveTelegramUpdateOffsetPath(params.accountId, params.env), {
		version: STORE_VERSION,
		lastUpdateId: params.updateId,
		botId: extractBotIdFromToken(params.botToken)
	}, {
		mode: 384,
		trailingNewline: true,
		ensureDirMode: 448
	});
}
//#endregion
//#region extensions/telegram/src/webhook.ts
init_runtime();
const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
const TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS = 1e4;
async function listenHttpServer(params) {
	await new Promise((resolve, reject) => {
		const onError = (err) => {
			params.server.off("error", onError);
			reject(err);
		};
		params.server.once("error", onError);
		params.server.listen(params.port, params.host, () => {
			params.server.off("error", onError);
			resolve();
		});
	});
}
function resolveWebhookPublicUrl(params) {
	if (params.configuredPublicUrl) return params.configuredPublicUrl;
	const address = params.server.address();
	if (address && typeof address !== "string") return `http://${params.host === "0.0.0.0" || address.address === "0.0.0.0" || address.address === "::" ? "localhost" : address.address}:${address.port}${params.path}`;
	return `http://${params.host === "0.0.0.0" ? "localhost" : params.host}:${params.port}${params.path}`;
}
async function initializeTelegramWebhookBot(params) {
	const initSignal = params.abortSignal;
	await withTelegramApiErrorLogging({
		operation: "getMe",
		runtime: params.runtime,
		fn: () => params.bot.init(initSignal)
	});
}
function resolveSingleHeaderValue(header) {
	if (typeof header === "string") return header;
	if (Array.isArray(header) && header.length === 1) return header[0];
}
function hasValidTelegramWebhookSecret(secretHeader, expectedSecret) {
	if (typeof secretHeader !== "string") return false;
	const actual = Buffer.from(secretHeader, "utf-8");
	const expected = Buffer.from(expectedSecret, "utf-8");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function startTelegramWebhook(opts) {
	const path = opts.path ?? "/telegram-webhook";
	const healthPath = opts.healthPath ?? "/healthz";
	const port = opts.port ?? 8787;
	const host = opts.host ?? "127.0.0.1";
	const secret = typeof opts.secret === "string" ? opts.secret.trim() : "";
	if (!secret) throw new Error("Telegram webhook mode requires a non-empty secret token. Set channels.telegram.webhookSecret in your config.");
	const runtime = opts.runtime ?? defaultRuntime;
	const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
	const bot = createTelegramBot({
		token: opts.token,
		runtime,
		proxyFetch: opts.fetch,
		config: opts.config,
		accountId: opts.accountId
	});
	await initializeTelegramWebhookBot({
		bot,
		runtime,
		abortSignal: opts.abortSignal
	});
	const handler = webhookCallback(bot, "callback", {
		secretToken: secret,
		onTimeout: "return",
		timeoutMilliseconds: TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS
	});
	if (diagnosticsEnabled) startDiagnosticHeartbeat(opts.config);
	const server = createServer((req, res) => {
		const respondText = (statusCode, text = "") => {
			if (res.headersSent || res.writableEnded) return;
			res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(text);
		};
		if (req.url === healthPath) {
			res.writeHead(200);
			res.end("ok");
			return;
		}
		if (req.url !== path || req.method !== "POST") {
			res.writeHead(404);
			res.end();
			return;
		}
		const startTime = Date.now();
		if (diagnosticsEnabled) logWebhookReceived({
			channel: "telegram",
			updateType: "telegram-post"
		});
		const secretHeader = resolveSingleHeaderValue(req.headers["x-telegram-bot-api-secret-token"]);
		if (!hasValidTelegramWebhookSecret(secretHeader, secret)) {
			res.shouldKeepAlive = false;
			res.setHeader("Connection", "close");
			respondText(401, "unauthorized");
			return;
		}
		(async () => {
			const body = await readJsonBodyWithLimit(req, {
				maxBytes: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
				timeoutMs: TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS,
				emptyObjectOnEmpty: false
			});
			if (!body.ok) {
				if (body.code === "PAYLOAD_TOO_LARGE") {
					respondText(413, body.error);
					return;
				}
				if (body.code === "REQUEST_BODY_TIMEOUT") {
					respondText(408, body.error);
					return;
				}
				if (body.code === "CONNECTION_CLOSED") {
					respondText(400, body.error);
					return;
				}
				respondText(400, body.error);
				return;
			}
			let replied = false;
			const reply = async (json) => {
				if (replied) return;
				replied = true;
				if (res.headersSent || res.writableEnded) return;
				res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
				res.end(json);
			};
			const unauthorized = async () => {
				if (replied) return;
				replied = true;
				respondText(401, "unauthorized");
			};
			await handler(body.value, reply, secretHeader, unauthorized);
			if (!replied) respondText(200);
			if (diagnosticsEnabled) logWebhookProcessed({
				channel: "telegram",
				updateType: "telegram-post",
				durationMs: Date.now() - startTime
			});
		})().catch((err) => {
			const errMsg = formatErrorMessage(err);
			if (diagnosticsEnabled) logWebhookError({
				channel: "telegram",
				updateType: "telegram-post",
				error: errMsg
			});
			runtime.log?.(`webhook handler failed: ${errMsg}`);
			respondText(500);
		});
	});
	await listenHttpServer({
		server,
		port,
		host
	});
	const boundAddress = server.address();
	const boundPort = boundAddress && typeof boundAddress !== "string" ? boundAddress.port : port;
	const publicUrl = resolveWebhookPublicUrl({
		configuredPublicUrl: opts.publicUrl,
		server,
		path,
		host,
		port
	});
	try {
		await withTelegramApiErrorLogging({
			operation: "setWebhook",
			runtime,
			fn: () => bot.api.setWebhook(publicUrl, {
				secret_token: secret,
				allowed_updates: resolveTelegramAllowedUpdates(),
				certificate: opts.webhookCertPath ? new InputFile(opts.webhookCertPath) : void 0
			})
		});
	} catch (err) {
		server.close();
		bot.stop();
		if (diagnosticsEnabled) stopDiagnosticHeartbeat();
		throw err;
	}
	runtime.log?.(`webhook local listener on http://${host}:${boundPort}${path}`);
	runtime.log?.(`webhook advertised to telegram on ${publicUrl}`);
	let shutDown = false;
	const shutdown = () => {
		if (shutDown) return;
		shutDown = true;
		withTelegramApiErrorLogging({
			operation: "deleteWebhook",
			runtime,
			fn: () => bot.api.deleteWebhook({ drop_pending_updates: false })
		}).catch(() => {});
		server.close();
		bot.stop();
		if (diagnosticsEnabled) stopDiagnosticHeartbeat();
	};
	if (opts.abortSignal) opts.abortSignal.addEventListener("abort", shutdown, { once: true });
	return {
		server,
		bot,
		stop: shutdown
	};
}
//#endregion
//#region extensions/telegram/src/monitor.ts
function createTelegramRunnerOptions(cfg) {
	return {
		sink: { concurrency: resolveAgentMaxConcurrent(cfg) },
		runner: {
			fetch: {
				timeout: 30,
				allowed_updates: resolveTelegramAllowedUpdates()
			},
			silent: true,
			maxRetryTime: 3600 * 1e3,
			retryInterval: "exponential"
		}
	};
}
function normalizePersistedUpdateId(value) {
	if (value === null) return null;
	if (!Number.isSafeInteger(value) || value < 0) return null;
	return value;
}
/** Check if error is a Grammy HttpError (used to scope unhandled rejection handling) */
const isGrammyHttpError = (err) => {
	if (!err || typeof err !== "object") return false;
	return err.name === "HttpError";
};
async function monitorTelegramProvider(opts = {}) {
	const log = opts.runtime?.error ?? console.error;
	let pollingSession;
	let execApprovalsHandler;
	const unregisterHandler = registerUnhandledRejectionHandler((err) => {
		const isNetworkError = isRecoverableTelegramNetworkError(err, { context: "polling" });
		const isTelegramPollingError = isTelegramPollingNetworkError(err);
		if (isGrammyHttpError(err) && isNetworkError && isTelegramPollingError) {
			log(`[telegram] Suppressed network error: ${formatErrorMessage(err)}`);
			return true;
		}
		const activeRunner = pollingSession?.activeRunner;
		if (isNetworkError && isTelegramPollingError && activeRunner && activeRunner.isRunning()) {
			pollingSession?.markForceRestarted();
			pollingSession?.abortActiveFetch();
			activeRunner.stop().catch(() => {});
			log(`[telegram] Restarting polling after unhandled network error: ${formatErrorMessage(err)}`);
			return true;
		}
		return false;
	});
	try {
		const cfg = opts.config ?? loadConfig();
		const account = resolveTelegramAccount({
			cfg,
			accountId: opts.accountId
		});
		const token = opts.token?.trim() || account.token;
		if (!token) throw new Error(`Telegram bot token missing for account "${account.accountId}" (set channels.telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`);
		const proxyFetch = opts.proxyFetch ?? (account.config.proxy ? makeProxyFetch(account.config.proxy) : void 0);
		execApprovalsHandler = new TelegramExecApprovalHandler({
			token,
			accountId: account.accountId,
			cfg,
			runtime: opts.runtime
		});
		await execApprovalsHandler.start();
		const persistedOffsetRaw = await readTelegramUpdateOffset({
			accountId: account.accountId,
			botToken: token
		});
		let lastUpdateId = normalizePersistedUpdateId(persistedOffsetRaw);
		if (persistedOffsetRaw !== null && lastUpdateId === null) log(`[telegram] Ignoring invalid persisted update offset (${String(persistedOffsetRaw)}); starting without offset confirmation.`);
		const persistUpdateId = async (updateId) => {
			const normalizedUpdateId = normalizePersistedUpdateId(updateId);
			if (normalizedUpdateId === null) {
				log(`[telegram] Ignoring invalid update_id value: ${String(updateId)}`);
				return;
			}
			if (lastUpdateId !== null && normalizedUpdateId <= lastUpdateId) return;
			lastUpdateId = normalizedUpdateId;
			try {
				await writeTelegramUpdateOffset({
					accountId: account.accountId,
					updateId: normalizedUpdateId,
					botToken: token
				});
			} catch (err) {
				(opts.runtime?.error ?? console.error)(`telegram: failed to persist update offset: ${String(err)}`);
			}
		};
		if (opts.useWebhook) {
			await startTelegramWebhook({
				token,
				accountId: account.accountId,
				config: cfg,
				path: opts.webhookPath,
				port: opts.webhookPort,
				secret: opts.webhookSecret ?? account.config.webhookSecret,
				host: opts.webhookHost ?? account.config.webhookHost,
				runtime: opts.runtime,
				fetch: proxyFetch,
				abortSignal: opts.abortSignal,
				publicUrl: opts.webhookUrl,
				webhookCertPath: opts.webhookCertPath
			});
			await waitForAbortSignal(opts.abortSignal);
			return;
		}
		pollingSession = new TelegramPollingSession({
			token,
			config: cfg,
			accountId: account.accountId,
			runtime: opts.runtime,
			proxyFetch,
			abortSignal: opts.abortSignal,
			runnerOptions: createTelegramRunnerOptions(cfg),
			getLastUpdateId: () => lastUpdateId,
			persistUpdateId,
			log
		});
		await pollingSession.runUntilAbort();
	} finally {
		await execApprovalsHandler?.stop().catch(() => {});
		unregisterHandler();
	}
}
//#endregion
//#region extensions/telegram/src/probe.ts
init_fetch_timeout();
const TELEGRAM_API_BASE = "https://api.telegram.org";
const probeFetcherCache = /* @__PURE__ */ new Map();
const MAX_PROBE_FETCHER_CACHE_SIZE = 64;
function resolveProbeOptions(proxyOrOptions) {
	if (!proxyOrOptions) return;
	if (typeof proxyOrOptions === "string") return { proxyUrl: proxyOrOptions };
	return proxyOrOptions;
}
function shouldUseProbeFetcherCache() {
	return !process.env.VITEST && true;
}
function buildProbeFetcherCacheKey(token, options) {
	const cacheIdentity = options?.accountId?.trim() || token;
	const cacheIdentityKind = options?.accountId?.trim() ? "account" : "token";
	const proxyKey = options?.proxyUrl?.trim() ?? "";
	const autoSelectFamily = options?.network?.autoSelectFamily;
	return `${cacheIdentityKind}:${cacheIdentity}::${proxyKey}::${typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default"}::${options?.network?.dnsResultOrder ?? "default"}`;
}
function setCachedProbeFetcher(cacheKey, fetcher) {
	probeFetcherCache.set(cacheKey, fetcher);
	if (probeFetcherCache.size > MAX_PROBE_FETCHER_CACHE_SIZE) {
		const oldestKey = probeFetcherCache.keys().next().value;
		if (oldestKey !== void 0) probeFetcherCache.delete(oldestKey);
	}
	return fetcher;
}
function resolveProbeFetcher(token, options) {
	const cacheKey = shouldUseProbeFetcherCache() ? buildProbeFetcherCacheKey(token, options) : null;
	if (cacheKey) {
		const cachedFetcher = probeFetcherCache.get(cacheKey);
		if (cachedFetcher) return cachedFetcher;
	}
	const proxyUrl = options?.proxyUrl?.trim();
	const resolved = resolveTelegramFetch(proxyUrl ? makeProxyFetch(proxyUrl) : void 0, { network: options?.network });
	if (cacheKey) return setCachedProbeFetcher(cacheKey, resolved);
	return resolved;
}
async function probeTelegram(token, timeoutMs, proxyOrOptions) {
	const started = Date.now();
	const timeoutBudgetMs = Math.max(1, Math.floor(timeoutMs));
	const deadlineMs = started + timeoutBudgetMs;
	const fetcher = resolveProbeFetcher(token, resolveProbeOptions(proxyOrOptions));
	const base = `${TELEGRAM_API_BASE}/bot${token}`;
	const retryDelayMs = Math.max(50, Math.min(1e3, Math.floor(timeoutBudgetMs / 5)));
	const resolveRemainingBudgetMs = () => Math.max(0, deadlineMs - Date.now());
	const result = {
		ok: false,
		status: null,
		error: null,
		elapsedMs: 0
	};
	try {
		let meRes = null;
		let fetchError = null;
		for (let i = 0; i < 3; i++) {
			const remainingBudgetMs = resolveRemainingBudgetMs();
			if (remainingBudgetMs <= 0) break;
			try {
				meRes = await fetchWithTimeout(`${base}/getMe`, {}, Math.max(1, Math.min(timeoutBudgetMs, remainingBudgetMs)), fetcher);
				break;
			} catch (err) {
				fetchError = err;
				if (i < 2) {
					const remainingAfterAttemptMs = resolveRemainingBudgetMs();
					if (remainingAfterAttemptMs <= 0) break;
					const delayMs = Math.min(retryDelayMs, remainingAfterAttemptMs);
					if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
			}
		}
		if (!meRes) throw fetchError ?? /* @__PURE__ */ new Error(`probe timed out after ${timeoutBudgetMs}ms`);
		const meJson = await meRes.json();
		if (!meRes.ok || !meJson?.ok) {
			result.status = meRes.status;
			result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
			return {
				...result,
				elapsedMs: Date.now() - started
			};
		}
		result.bot = {
			id: meJson.result?.id ?? null,
			username: meJson.result?.username ?? null,
			canJoinGroups: typeof meJson.result?.can_join_groups === "boolean" ? meJson.result?.can_join_groups : null,
			canReadAllGroupMessages: typeof meJson.result?.can_read_all_group_messages === "boolean" ? meJson.result?.can_read_all_group_messages : null,
			supportsInlineQueries: typeof meJson.result?.supports_inline_queries === "boolean" ? meJson.result?.supports_inline_queries : null
		};
		try {
			const webhookRemainingBudgetMs = resolveRemainingBudgetMs();
			if (webhookRemainingBudgetMs > 0) {
				const webhookRes = await fetchWithTimeout(`${base}/getWebhookInfo`, {}, Math.max(1, Math.min(timeoutBudgetMs, webhookRemainingBudgetMs)), fetcher);
				const webhookJson = await webhookRes.json();
				if (webhookRes.ok && webhookJson?.ok) result.webhook = {
					url: webhookJson.result?.url ?? null,
					hasCustomCert: webhookJson.result?.has_custom_certificate ?? null
				};
			}
		} catch {}
		result.ok = true;
		result.status = null;
		result.error = null;
		result.elapsedMs = Date.now() - started;
		return result;
	} catch (err) {
		return {
			...result,
			status: err instanceof Response ? err.status : result.status,
			error: err instanceof Error ? err.message : String(err),
			elapsedMs: Date.now() - started
		};
	}
}
//#endregion
export { auditTelegramGroupMembership, collectTelegramUnmentionedGroupIds, deleteMessageTelegram, editMessageReplyMarkupTelegram, editMessageTelegram, monitorTelegramProvider, pinMessageTelegram, probeTelegram, renameForumTopicTelegram, resolveTelegramToken, sendMessageTelegram, sendPollTelegram, sendTypingTelegram, unpinMessageTelegram };
