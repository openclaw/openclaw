import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import "./agent-scope-CtLXGcWm.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { o as isDiagnosticsEnabled } from "./diagnostic-events-BLgzARSp.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { i as emitAgentEvent } from "./agent-events-BuYtWSh4.js";
import { a as toAcpRuntimeError } from "./errors-BgH2aVJW.js";
import { o as isSessionIdentityPending, u as resolveSessionIdentityFromMeta } from "./session-identity-MDZT82Pf.js";
import { g as markDiagnosticSessionProgress } from "./diagnostic-DEgTYLXt.js";
import { c as markReplyPayloadAsTtsSupplement, o as isReplyPayloadStatusNotice } from "./reply-payload-CiT5mlcY.js";
import { s as hasOutboundReplyContent } from "./reply-payload-DMPQsrQC.js";
import { a as resolveAcpDispatchPolicyError, i as resolveAcpAgentPolicyError } from "./policy-NEiwKvt-.js";
import { a as generateSecureUuid } from "./secure-random-BxnbXS5x.js";
import { n as formatToolSummary, r as resolveToolDisplay } from "./tool-display-CN2B3x-5.js";
import { t as EmbeddedBlockChunker } from "./pi-embedded-block-chunker-BQzqF871.js";
import { i as shouldCleanTtsDirectiveText, t as resolveConfiguredTtsMode } from "./tts-config-WOpwhkHq.js";
import { t as createTtsDirectiveTextStreamCleaner } from "./directives-DiYOXJC0.js";
import { a as appendRecentHistoryImageContext, i as hasInboundMedia, n as resolveAgentTurnAttachments, r as resolveInlineAgentImageAttachments, t as loadAgentTurnMediaRuntime } from "./agent-turn-attachments-BM8XhuOm.js";
import { r as createBlockReplyPipeline } from "./block-reply-pipeline-rWq9jszq.js";
import { r as waitForReplyDispatcherIdle } from "./reply-dispatcher-DPt1UxjJ.js";
import { t as resolveRoutedDeliveryThreadId } from "./routed-delivery-thread-BH8x0lSi.js";
import { r as resolveEffectiveBlockStreamingConfig, t as clampPositiveInteger } from "./block-streaming-Czlty0lk.js";
import { r as prefixSystemMessage } from "./system-message-DcYqWFJX.js";
import { t as formatAcpRuntimeErrorText } from "./error-text-DpXwhmkW.js";
import { a as resolveAcpThreadSessionDetailLines } from "./session-identifiers-CYNMp_8N.js";
import { t as resolveStatusTtsSnapshot } from "./status-config-Cqgj59Dn.js";
//#region src/auto-reply/reply/acp-stream-settings.ts
const DEFAULT_ACP_STREAM_COALESCE_IDLE_MS = 350;
const DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS = 1800;
const DEFAULT_ACP_REPEAT_SUPPRESSION = true;
const DEFAULT_ACP_DELIVERY_MODE = "final_only";
const DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR = "paragraph";
const DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR_LIVE = "space";
const DEFAULT_ACP_MAX_OUTPUT_CHARS = 24e3;
const DEFAULT_ACP_MAX_SESSION_UPDATE_CHARS = 320;
const ACP_TAG_VISIBILITY_DEFAULTS = {
	agent_message_chunk: true,
	tool_call: false,
	tool_call_update: false,
	usage_update: false,
	available_commands_update: false,
	current_mode_update: false,
	config_option_update: false,
	session_info_update: false,
	plan: false,
	agent_thought_chunk: false
};
function clampBoolean(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function resolveAcpDeliveryMode(value) {
	if (value === "live" || value === "final_only") return value;
	return DEFAULT_ACP_DELIVERY_MODE;
}
function resolveAcpHiddenBoundarySeparator(value, fallback) {
	if (value === "none" || value === "space" || value === "newline" || value === "paragraph") return value;
	return fallback;
}
function resolveAcpStreamCoalesceIdleMs(cfg) {
	return clampPositiveInteger(cfg.acp?.stream?.coalesceIdleMs, DEFAULT_ACP_STREAM_COALESCE_IDLE_MS, {
		min: 0,
		max: 5e3
	});
}
function resolveAcpStreamMaxChunkChars(cfg) {
	return clampPositiveInteger(cfg.acp?.stream?.maxChunkChars, DEFAULT_ACP_STREAM_MAX_CHUNK_CHARS, {
		min: 50,
		max: 4e3
	});
}
function resolveAcpProjectionSettings(cfg) {
	const stream = cfg.acp?.stream;
	const deliveryMode = resolveAcpDeliveryMode(stream?.deliveryMode);
	const hiddenBoundaryFallback = deliveryMode === "live" ? DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR_LIVE : DEFAULT_ACP_HIDDEN_BOUNDARY_SEPARATOR;
	return {
		deliveryMode,
		hiddenBoundarySeparator: resolveAcpHiddenBoundarySeparator(stream?.hiddenBoundarySeparator, hiddenBoundaryFallback),
		repeatSuppression: clampBoolean(stream?.repeatSuppression, DEFAULT_ACP_REPEAT_SUPPRESSION),
		maxOutputChars: clampPositiveInteger(stream?.maxOutputChars, DEFAULT_ACP_MAX_OUTPUT_CHARS, {
			min: 1,
			max: 5e5
		}),
		maxSessionUpdateChars: clampPositiveInteger(stream?.maxSessionUpdateChars, DEFAULT_ACP_MAX_SESSION_UPDATE_CHARS, {
			min: 64,
			max: 8e3
		}),
		tagVisibility: stream?.tagVisibility ?? {}
	};
}
function resolveAcpStreamingConfig(params) {
	const resolved = resolveEffectiveBlockStreamingConfig({
		cfg: params.cfg,
		provider: params.provider,
		accountId: params.accountId,
		maxChunkChars: resolveAcpStreamMaxChunkChars(params.cfg),
		coalesceIdleMs: resolveAcpStreamCoalesceIdleMs(params.cfg)
	});
	if (params.deliveryMode === "live") return {
		chunking: {
			...resolved.chunking,
			minChars: 1
		},
		coalescing: {
			...resolved.coalescing,
			minChars: 1,
			joiner: ""
		}
	};
	return resolved;
}
function isAcpTagVisible(settings, tag) {
	if (!tag) return true;
	const override = settings.tagVisibility[tag];
	if (typeof override === "boolean") return override;
	if (Object.prototype.hasOwnProperty.call(ACP_TAG_VISIBILITY_DEFAULTS, tag)) return ACP_TAG_VISIBILITY_DEFAULTS[tag];
	return true;
}
//#endregion
//#region src/auto-reply/reply/acp-projector.ts
const ACP_BLOCK_REPLY_TIMEOUT_MS = 15e3;
const ACP_LIVE_IDLE_FLUSH_FLOOR_MS = 750;
const ACP_LIVE_IDLE_MIN_CHARS = 80;
const ACP_LIVE_SOFT_FLUSH_CHARS = 220;
const ACP_LIVE_HARD_FLUSH_CHARS = 480;
const TERMINAL_TOOL_STATUSES = new Set([
	"completed",
	"failed",
	"cancelled",
	"done",
	"error"
]);
const HIDDEN_BOUNDARY_TAGS = new Set(["tool_call", "tool_call_update"]);
function truncateText(input, maxChars) {
	if (input.length <= maxChars) return input;
	if (maxChars <= 1) return input.slice(0, maxChars);
	return `${input.slice(0, maxChars - 1)}…`;
}
function hashText(text) {
	return text.trim();
}
function normalizeToolStatus(status) {
	return normalizeOptionalLowercaseString(status) || void 0;
}
function resolveHiddenBoundarySeparatorText(mode) {
	if (mode === "space") return " ";
	if (mode === "newline") return "\n";
	if (mode === "paragraph") return "\n\n";
	return "";
}
function shouldInsertSeparator(params) {
	if (!params.separator) return false;
	if (!params.nextText) return false;
	const firstChar = params.nextText[0];
	if (typeof firstChar === "string" && /\s/.test(firstChar)) return false;
	const tail = params.previousTail ?? "";
	if (!tail) return false;
	if (params.separator === " " && /\s$/.test(tail)) return false;
	if ((params.separator === "\n" || params.separator === "\n\n") && tail.endsWith("\n")) return false;
	return true;
}
function shouldFlushLiveBufferOnBoundary(text) {
	if (!text) return false;
	if (text.length >= ACP_LIVE_HARD_FLUSH_CHARS) return true;
	if (text.endsWith("\n\n")) return true;
	if (/[.!?][)"'`]*\s$/.test(text)) return true;
	if (text.length >= ACP_LIVE_SOFT_FLUSH_CHARS && /\s$/.test(text)) return true;
	return false;
}
function shouldFlushLiveBufferOnIdle(text) {
	if (!text) return false;
	if (text.length >= ACP_LIVE_IDLE_MIN_CHARS) return true;
	if (/[.!?][)"'`]*$/.test(text.trimEnd())) return true;
	if (text.includes("\n")) return true;
	return false;
}
function renderToolSummaryText(event) {
	const detailParts = [];
	const title = normalizeOptionalString(event.title);
	if (title) detailParts.push(title);
	const status = normalizeOptionalString(event.status);
	if (status) detailParts.push(`status=${status}`);
	const fallback = normalizeOptionalString(event.text);
	if (detailParts.length === 0 && fallback) detailParts.push(fallback);
	return formatToolSummary(resolveToolDisplay({
		name: "tool_call",
		meta: detailParts.join(" · ") || "tool call"
	}));
}
function createAcpReplyProjector(params) {
	const settings = resolveAcpProjectionSettings(params.cfg);
	const streaming = resolveAcpStreamingConfig({
		cfg: params.cfg,
		provider: params.provider,
		accountId: params.accountId,
		deliveryMode: settings.deliveryMode
	});
	const createTurnBlockReplyPipeline = () => createBlockReplyPipeline({
		onBlockReply: async (payload) => {
			await params.deliver("block", payload);
		},
		timeoutMs: ACP_BLOCK_REPLY_TIMEOUT_MS,
		coalescing: settings.deliveryMode === "live" ? void 0 : streaming.coalescing
	});
	let blockReplyPipeline = createTurnBlockReplyPipeline();
	const chunker = new EmbeddedBlockChunker(streaming.chunking);
	const liveIdleFlushMs = Math.max(streaming.coalescing.idleMs, ACP_LIVE_IDLE_FLUSH_FLOOR_MS);
	let emittedOutputChars = 0;
	let truncationNoticeEmitted = false;
	let lastStatusHash;
	let lastToolHash;
	let lastUsageTuple;
	let lastVisibleOutputTail;
	let pendingHiddenBoundary = false;
	let liveBufferText = "";
	let finalOnlyOutputText = "";
	let liveIdleTimer;
	const pendingToolDeliveries = [];
	const toolLifecycleById = /* @__PURE__ */ new Map();
	const clearLiveIdleTimer = () => {
		if (!liveIdleTimer) return;
		clearTimeout(liveIdleTimer);
		liveIdleTimer = void 0;
	};
	const drainChunker = (force) => {
		if (settings.deliveryMode === "final_only" && !force) return;
		chunker.drain({
			force,
			emit: (chunk) => {
				blockReplyPipeline.enqueue({ text: chunk });
			}
		});
	};
	const flushLiveBuffer = (opts) => {
		if (settings.deliveryMode !== "live") return;
		if (!liveBufferText) return;
		if (opts?.idle && !shouldFlushLiveBufferOnIdle(liveBufferText)) return;
		const text = liveBufferText;
		liveBufferText = "";
		chunker.append(text);
		drainChunker(opts?.force === true);
	};
	const scheduleLiveIdleFlush = () => {
		if (settings.deliveryMode !== "live") return;
		if (liveIdleFlushMs <= 0 || !liveBufferText) return;
		clearLiveIdleTimer();
		liveIdleTimer = setTimeout(() => {
			flushLiveBuffer({
				force: true,
				idle: true
			});
			if (liveBufferText) scheduleLiveIdleFlush();
		}, liveIdleFlushMs);
	};
	const resetTurnState = () => {
		clearLiveIdleTimer();
		blockReplyPipeline.stop();
		blockReplyPipeline = createTurnBlockReplyPipeline();
		emittedOutputChars = 0;
		truncationNoticeEmitted = false;
		lastStatusHash = void 0;
		lastToolHash = void 0;
		lastUsageTuple = void 0;
		lastVisibleOutputTail = void 0;
		pendingHiddenBoundary = false;
		liveBufferText = "";
		finalOnlyOutputText = "";
		pendingToolDeliveries.length = 0;
		toolLifecycleById.clear();
	};
	const flushBufferedToolDeliveries = async (force) => {
		if (!(settings.deliveryMode === "final_only" && force)) return;
		for (const entry of pendingToolDeliveries.splice(0)) await params.deliver("tool", entry.payload, entry.meta);
	};
	const flush = async (force = false) => {
		if (settings.deliveryMode === "live") {
			clearLiveIdleTimer();
			flushLiveBuffer({ force: true });
		}
		await flushBufferedToolDeliveries(force);
		if (settings.deliveryMode === "final_only") {
			if (force && finalOnlyOutputText.trim().length > 0) {
				const text = finalOnlyOutputText;
				finalOnlyOutputText = "";
				await params.deliver("final", { text });
			}
		} else drainChunker(force);
		await blockReplyPipeline.flush({ force });
	};
	const emitSystemStatus = async (text, meta, opts) => {
		if (!params.shouldSendToolSummaries) return;
		const bounded = truncateText(text.trim(), settings.maxSessionUpdateChars);
		if (!bounded) return;
		const formatted = prefixSystemMessage(bounded);
		const hash = hashText(formatted);
		if (settings.repeatSuppression && opts?.dedupe !== false && lastStatusHash === hash) return;
		if (settings.deliveryMode === "final_only") pendingToolDeliveries.push({
			payload: { text: formatted },
			meta
		});
		else {
			await flush(true);
			await params.deliver("tool", { text: formatted }, meta);
		}
		lastStatusHash = hash;
	};
	const emitToolSummary = async (event) => {
		if (!params.shouldSendToolSummaries) return;
		if (!isAcpTagVisible(settings, event.tag)) return;
		const renderedToolSummary = renderToolSummaryText(event);
		const toolSummary = truncateText(renderedToolSummary, settings.maxSessionUpdateChars);
		const hash = hashText(renderedToolSummary);
		const toolCallId = normalizeOptionalString(event.toolCallId);
		const status = normalizeToolStatus(event.status);
		const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
		const isStart = status === "in_progress" || event.tag === "tool_call";
		if (settings.repeatSuppression) {
			if (toolCallId) {
				const state = toolLifecycleById.get(toolCallId) ?? {
					started: false,
					terminal: false
				};
				if (isTerminal && state.terminal) return;
				if (isStart && state.started) return;
				if (state.lastRenderedHash === hash) return;
				if (isStart) state.started = true;
				if (isTerminal) state.terminal = true;
				state.lastRenderedHash = hash;
				toolLifecycleById.set(toolCallId, state);
			} else if (lastToolHash === hash) return;
		}
		const deliveryMeta = {
			...event.tag ? { tag: event.tag } : {},
			...toolCallId ? { toolCallId } : {},
			...status ? { toolStatus: status } : {},
			allowEdit: Boolean(toolCallId && event.tag === "tool_call_update")
		};
		if (settings.deliveryMode === "final_only") pendingToolDeliveries.push({
			payload: { text: toolSummary },
			meta: deliveryMeta
		});
		else {
			await flush(true);
			await params.deliver("tool", { text: toolSummary }, deliveryMeta);
		}
		lastToolHash = hash;
	};
	const emitTruncationNotice = async () => {
		if (truncationNoticeEmitted) return;
		truncationNoticeEmitted = true;
		await emitSystemStatus("output truncated", { tag: "session_info_update" }, { dedupe: false });
	};
	const onEvent = async (event) => {
		params.onProgress?.();
		if (event.type === "text_delta") {
			if (event.stream && event.stream !== "output") return;
			if (!isAcpTagVisible(settings, event.tag)) return;
			let text = event.text;
			if (!text) return;
			if (pendingHiddenBoundary && shouldInsertSeparator({
				separator: resolveHiddenBoundarySeparatorText(settings.hiddenBoundarySeparator),
				previousTail: lastVisibleOutputTail,
				nextText: text
			})) text = `${resolveHiddenBoundarySeparatorText(settings.hiddenBoundarySeparator)}${text}`;
			pendingHiddenBoundary = false;
			if (emittedOutputChars >= settings.maxOutputChars) {
				await emitTruncationNotice();
				return;
			}
			const remaining = settings.maxOutputChars - emittedOutputChars;
			const accepted = remaining < text.length ? text.slice(0, remaining) : text;
			if (accepted.length > 0) {
				emittedOutputChars += accepted.length;
				lastVisibleOutputTail = accepted.slice(-1);
				if (settings.deliveryMode === "live") {
					liveBufferText += accepted;
					if (shouldFlushLiveBufferOnBoundary(liveBufferText)) {
						clearLiveIdleTimer();
						flushLiveBuffer({ force: true });
					} else scheduleLiveIdleFlush();
				} else finalOnlyOutputText += accepted;
			}
			if (accepted.length < text.length) await emitTruncationNotice();
			return;
		}
		if (event.type === "status") {
			if (!isAcpTagVisible(settings, event.tag)) return;
			if (event.tag === "usage_update" && settings.repeatSuppression) {
				const usageTuple = typeof event.used === "number" && typeof event.size === "number" ? `${event.used}/${event.size}` : hashText(event.text);
				if (usageTuple === lastUsageTuple) return;
				lastUsageTuple = usageTuple;
			}
			await emitSystemStatus(event.text, event.tag ? { tag: event.tag } : void 0, { dedupe: true });
			return;
		}
		if (event.type === "tool_call") {
			if (!isAcpTagVisible(settings, event.tag)) {
				if (event.tag && HIDDEN_BOUNDARY_TAGS.has(event.tag)) {
					const status = normalizeToolStatus(event.status);
					const isTerminal = status ? TERMINAL_TOOL_STATUSES.has(status) : false;
					pendingHiddenBoundary = pendingHiddenBoundary || event.tag === "tool_call" || isTerminal;
				}
				return;
			}
			await emitToolSummary(event);
			return;
		}
		if (event.type === "done" || event.type === "error") {
			await flush(true);
			resetTurnState();
		}
	};
	return {
		onEvent,
		flush
	};
}
//#endregion
//#region src/auto-reply/reply/dispatch-acp-delivery.ts
const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
const dispatchAcpTtsRuntimeLoader$1 = createLazyImportLoader(() => import("./dispatch-acp-tts.runtime.js"));
const channelPluginRuntimeLoader = createLazyImportLoader(() => import("./plugins-C54ejDC8.js"));
const messageActionRuntimeLoader = createLazyImportLoader(() => import("./message-action-runner-D8IlyXiu.js"));
function loadRouteReplyRuntime() {
	return routeReplyRuntimeLoader.load();
}
function loadDispatchAcpTtsRuntime$1() {
	return dispatchAcpTtsRuntimeLoader$1.load();
}
function loadChannelPluginRuntime() {
	return channelPluginRuntimeLoader.load();
}
function loadMessageActionRuntime() {
	return messageActionRuntimeLoader.load();
}
async function shouldTreatDeliveredTextAsVisible(params) {
	if (!normalizeOptionalString(params.text)) return false;
	if (params.kind === "final") return true;
	const channelId = normalizeOptionalLowercaseString(params.channel);
	if (!channelId) return false;
	const { getChannelPlugin } = await loadChannelPluginRuntime();
	const outbound = getChannelPlugin(channelId)?.outbound;
	const visibilityOverride = outbound?.shouldTreatDeliveredTextAsVisible ?? outbound?.shouldTreatRoutedTextAsVisible;
	if (visibilityOverride) return visibilityOverride({
		kind: params.kind,
		text: params.text
	});
	return false;
}
async function maybeApplyAcpTts(params) {
	if (params.skipTts) return params.payload;
	if (isReplyPayloadStatusNotice(params.payload)) return params.payload;
	const ttsStatus = resolveStatusTtsSnapshot({
		cfg: params.cfg,
		sessionAuto: params.ttsAuto,
		agentId: params.agentId,
		channelId: params.channel,
		accountId: params.accountId
	});
	if (!ttsStatus) return params.payload;
	if (ttsStatus.autoMode === "inbound" && !params.inboundAudio) return params.payload;
	if (params.kind !== "final" && resolveConfiguredTtsMode(params.cfg, {
		agentId: params.agentId,
		channelId: params.channel,
		accountId: params.accountId
	}) === "final") return params.payload;
	const { maybeApplyTtsToPayload } = await loadDispatchAcpTtsRuntime$1();
	return await maybeApplyTtsToPayload({
		payload: params.payload,
		cfg: params.cfg,
		channel: params.channel,
		kind: params.kind,
		inboundAudio: params.inboundAudio,
		ttsAuto: params.ttsAuto,
		agentId: params.agentId,
		accountId: params.accountId
	});
}
function createAcpDispatchDeliveryCoordinator(params) {
	const directChannel = normalizeOptionalLowercaseString(params.ctx.Provider ?? params.ctx.Surface);
	const routedChannel = normalizeOptionalLowercaseString(params.originatingChannel);
	const deliverySessionKey = normalizeOptionalString(params.sessionKey) ?? params.ctx.SessionKey;
	const resolvedAccountId = normalizeOptionalString(params.ctx.AccountId) ?? normalizeOptionalString(params.cfg.channels?.[routedChannel ?? directChannel ?? ""]?.defaultAccount);
	const state = {
		startedReplyLifecycle: false,
		accumulatedBlockText: "",
		accumulatedVisibleBlockText: "",
		accumulatedBlockTtsText: "",
		accumulatedFinalText: "",
		cleanBlockTtsDirectiveText: shouldCleanTtsDirectiveText({
			cfg: params.cfg,
			ttsAuto: params.sessionTtsAuto,
			agentId: params.agentId,
			channelId: params.ttsChannel,
			accountId: resolvedAccountId
		}) ? createTtsDirectiveTextStreamCleaner() : void 0,
		blockCount: 0,
		deliveredFinalReply: false,
		deliveredVisibleText: false,
		failedVisibleTextDelivery: false,
		queuedDirectVisibleTextDeliveries: 0,
		settledDirectVisibleText: false,
		routedCounts: {
			tool: 0,
			block: 0,
			final: 0
		},
		toolMessageByCallId: /* @__PURE__ */ new Map()
	};
	const settleDirectVisibleText = async () => {
		if (state.settledDirectVisibleText || state.queuedDirectVisibleTextDeliveries === 0) return;
		state.settledDirectVisibleText = true;
		await params.dispatcher.waitForIdle();
		const failedCounts = params.dispatcher.getFailedCounts();
		const failedVisibleCount = failedCounts.block + failedCounts.final;
		if (failedVisibleCount > 0) state.failedVisibleTextDelivery = true;
		if (state.queuedDirectVisibleTextDeliveries > failedVisibleCount) state.deliveredVisibleText = true;
	};
	const startReplyLifecycleOnce = async () => {
		if (state.startedReplyLifecycle) return;
		state.startedReplyLifecycle = true;
		if (params.suppressReplyLifecycle) return;
		Promise.resolve(params.onReplyStart?.()).catch((error) => {
			logVerbose(`dispatch-acp: reply lifecycle start failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	const tryEditToolMessage = async (payload, toolCallId) => {
		if (!params.shouldRouteToOriginating || !params.originatingChannel || !params.originatingTo) return false;
		const handle = state.toolMessageByCallId.get(toolCallId);
		if (!handle?.messageId) return false;
		const message = normalizeOptionalString(payload.text);
		if (!message) return false;
		try {
			const { runMessageAction } = await loadMessageActionRuntime();
			await runMessageAction({
				cfg: params.cfg,
				action: "edit",
				params: {
					channel: handle.channel,
					accountId: handle.accountId,
					to: handle.to,
					threadId: handle.threadId,
					messageId: handle.messageId,
					message
				},
				sessionKey: params.ctx.SessionKey,
				requesterAccountId: params.ctx.AccountId
			});
			state.routedCounts.tool += 1;
			return true;
		} catch (error) {
			logVerbose(`dispatch-acp: tool message edit failed for ${toolCallId}: ${formatErrorMessage(error)}`);
			return false;
		}
	};
	const deliver = async (kind, payload, meta) => {
		let visiblePayload = payload;
		const rawBlockText = kind === "block" ? normalizeOptionalString(payload.text) : void 0;
		if (rawBlockText) {
			const isStatusNotice = isReplyPayloadStatusNotice(payload);
			const joinsBufferedTtsDirective = state.cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
			if (!isStatusNotice) {
				if (state.accumulatedBlockText.length > 0) state.accumulatedBlockText += "\n";
				state.accumulatedBlockText += rawBlockText;
				if (state.accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) state.accumulatedBlockTtsText += "\n";
				state.accumulatedBlockTtsText += rawBlockText;
				state.blockCount += 1;
			}
			if (state.cleanBlockTtsDirectiveText && !isStatusNotice) {
				const text = state.cleanBlockTtsDirectiveText.push(rawBlockText);
				visiblePayload = {
					...payload,
					text: text.trim() ? text : void 0
				};
			}
			if (visiblePayload.text) {
				if (state.accumulatedVisibleBlockText.length > 0) state.accumulatedVisibleBlockText += "\n";
				state.accumulatedVisibleBlockText += visiblePayload.text;
			}
		}
		const isStatusNotice = isReplyPayloadStatusNotice(payload);
		const rawFinalText = kind === "final" && !isStatusNotice ? normalizeOptionalString(payload.text) : void 0;
		if (rawFinalText) {
			if (state.accumulatedFinalText.length > 0) state.accumulatedFinalText += "\n";
			state.accumulatedFinalText += rawFinalText;
		}
		if (hasOutboundReplyContent(visiblePayload, { trimText: true })) await startReplyLifecycleOnce();
		else return false;
		if (params.suppressUserDelivery) return false;
		const ttsPayload = await maybeApplyAcpTts({
			payload: visiblePayload,
			cfg: params.cfg,
			agentId: params.agentId,
			channel: params.ttsChannel,
			accountId: resolvedAccountId,
			kind,
			inboundAudio: params.inboundAudio,
			ttsAuto: params.sessionTtsAuto,
			skipTts: meta?.skipTts
		});
		if (params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo) {
			const toolCallId = normalizeOptionalString(meta?.toolCallId);
			if (kind === "tool" && meta?.allowEdit === true && toolCallId) {
				if (await tryEditToolMessage(ttsPayload, toolCallId)) return true;
			}
			const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
				channel: routedChannel,
				kind,
				text: ttsPayload.text,
				routed: true
			});
			const { routeReply } = await loadRouteReplyRuntime();
			const threadId = resolveRoutedDeliveryThreadId({
				ctx: params.ctx,
				sessionKey: deliverySessionKey
			});
			const result = await routeReply({
				payload: ttsPayload,
				channel: params.originatingChannel,
				to: params.originatingTo,
				sessionKey: deliverySessionKey,
				...deliverySessionKey !== params.ctx.SessionKey ? { policySessionKey: params.ctx.SessionKey } : {},
				accountId: resolvedAccountId,
				requesterSenderId: params.ctx.SenderId,
				requesterSenderName: params.ctx.SenderName,
				requesterSenderUsername: params.ctx.SenderUsername,
				requesterSenderE164: params.ctx.SenderE164,
				threadId,
				cfg: params.cfg,
				mirror: false
			});
			if (!result.ok) {
				if (tracksVisibleText) state.failedVisibleTextDelivery = true;
				logVerbose(`dispatch-acp: route-reply (acp/${kind}) failed: ${result.error ?? "unknown error"}`);
				return false;
			}
			if (kind === "tool" && meta?.toolCallId && result.messageId) state.toolMessageByCallId.set(meta.toolCallId, {
				channel: params.originatingChannel,
				accountId: resolvedAccountId,
				to: params.originatingTo,
				...threadId != null ? { threadId } : {},
				messageId: result.messageId
			});
			if (kind === "final") state.deliveredFinalReply = true;
			if (tracksVisibleText) state.deliveredVisibleText = true;
			state.routedCounts[kind] += 1;
			return true;
		}
		const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
			channel: directChannel,
			kind,
			text: ttsPayload.text,
			routed: false
		});
		const delivered = kind === "tool" ? params.dispatcher.sendToolResult(ttsPayload) : kind === "block" ? params.dispatcher.sendBlockReply(ttsPayload) : params.dispatcher.sendFinalReply(ttsPayload);
		if (kind === "final" && delivered) state.deliveredFinalReply = true;
		if (delivered && tracksVisibleText) {
			state.queuedDirectVisibleTextDeliveries += 1;
			state.settledDirectVisibleText = false;
		} else if (!delivered && tracksVisibleText) state.failedVisibleTextDelivery = true;
		if (kind === "block" && delivered) await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
		return delivered;
	};
	return {
		startReplyLifecycle: startReplyLifecycleOnce,
		deliver,
		getBlockCount: () => state.blockCount,
		getAccumulatedBlockText: () => state.accumulatedBlockText,
		getAccumulatedVisibleBlockText: () => state.accumulatedVisibleBlockText,
		getAccumulatedBlockTtsText: () => state.accumulatedBlockTtsText,
		getAccumulatedFinalText: () => state.accumulatedFinalText,
		settleVisibleText: settleDirectVisibleText,
		hasDeliveredFinalReply: () => state.deliveredFinalReply,
		hasDeliveredVisibleText: () => state.deliveredVisibleText,
		hasFailedVisibleTextDelivery: () => state.failedVisibleTextDelivery,
		getRoutedCounts: () => ({ ...state.routedCounts }),
		applyRoutedCounts: (counts) => {
			counts.tool += state.routedCounts.tool;
			counts.block += state.routedCounts.block;
			counts.final += state.routedCounts.final;
		}
	};
}
//#endregion
//#region src/auto-reply/reply/dispatch-acp.ts
const dispatchAcpManagerRuntimeLoader = createLazyImportLoader(() => import("./dispatch-acp-manager.runtime.js"));
const dispatchAcpSessionRuntimeLoader = createLazyImportLoader(() => import("./dispatch-acp-session.runtime.js"));
const dispatchAcpTtsRuntimeLoader = createLazyImportLoader(() => import("./dispatch-acp-tts.runtime.js"));
const dispatchAcpTranscriptRuntimeLoader = createLazyImportLoader(() => import("./dispatch-acp-transcript.runtime.js"));
function loadDispatchAcpManagerRuntime() {
	return dispatchAcpManagerRuntimeLoader.load();
}
function loadDispatchAcpSessionRuntime() {
	return dispatchAcpSessionRuntimeLoader.load();
}
function loadDispatchAcpTtsRuntime() {
	return dispatchAcpTtsRuntimeLoader.load();
}
function loadDispatchAcpTranscriptRuntime() {
	return dispatchAcpTranscriptRuntimeLoader.load();
}
function resolveFirstContextText(ctx, keys) {
	for (const key of keys) {
		const value = ctx[key];
		if (typeof value === "string") return value;
	}
	return "";
}
function resolveAcpPromptText(ctx) {
	return resolveFirstContextText(ctx, [
		"BodyForAgent",
		"BodyForCommands",
		"CommandBody",
		"RawBody",
		"Body"
	]).trim();
}
function resolveAcpRequestId(ctx) {
	const id = ctx.MessageSidFull ?? ctx.MessageSid ?? ctx.MessageSidFirst ?? ctx.MessageSidLast;
	if (typeof id === "string") {
		const normalizedId = normalizeOptionalString(id);
		if (normalizedId) return normalizedId;
	}
	if (typeof id === "number" || typeof id === "bigint") return String(id);
	return generateSecureUuid();
}
function resolveAcpTurnText(params) {
	if (params.sourceReplyDeliveryMode !== "message_tool_only") return params.promptText;
	const guidance = prefixSystemMessage([
		"Source channel delivery is private by default for this turn.",
		"Normal ACP final output will not be automatically posted to the source channel.",
		"To send visible output, use message(action=send). The target defaults to the current source channel."
	].join(" "));
	return params.promptText ? `${guidance}\n\n${params.promptText}` : guidance;
}
async function hasBoundConversationForSession(params) {
	const channel = normalizeOptionalLowercaseString(params.channelRaw) ?? "";
	if (!channel) return false;
	const accountId = normalizeOptionalLowercaseString(params.accountIdRaw) ?? "";
	const configuredDefaultAccountId = params.cfg.channels?.[channel]?.defaultAccount;
	const normalizedAccountId = accountId || normalizeOptionalLowercaseString(configuredDefaultAccountId) || "default";
	const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
	return getSessionBindingService().listBySession(params.sessionKey).some((binding) => {
		const bindingChannel = normalizeOptionalLowercaseString(binding.conversation.channel) ?? "";
		const bindingAccountId = normalizeOptionalLowercaseString(binding.conversation.accountId) ?? "";
		const conversationId = normalizeOptionalString(binding.conversation.conversationId) ?? "";
		return bindingChannel === channel && (bindingAccountId || "default") === normalizedAccountId && conversationId.length > 0;
	});
}
const ACP_STALE_BINDING_UNBIND_REASON = "acp-session-init-failed";
function isStaleSessionInitError(params) {
	if (params.code !== "ACP_SESSION_INIT_FAILED") return false;
	return /(ACP (session )?metadata is missing|missing ACP metadata|Session is not ACP-enabled|Resource not found)/i.test(params.message);
}
async function maybeUnbindStaleBoundConversations(params) {
	if (!isStaleSessionInitError(params.error)) return;
	try {
		const { getSessionBindingService } = await loadDispatchAcpManagerRuntime();
		const removed = await getSessionBindingService().unbind({
			targetSessionKey: params.targetSessionKey,
			reason: ACP_STALE_BINDING_UNBIND_REASON
		});
		if (removed.length > 0) logVerbose(`dispatch-acp: removed ${removed.length} stale bound conversation(s) for ${params.targetSessionKey} after ${params.error.code}: ${params.error.message}`);
	} catch (error) {
		logVerbose(`dispatch-acp: failed to unbind stale bound conversations for ${params.targetSessionKey}: ${formatErrorMessage(error)}`);
	}
}
async function finalizeAcpTurnOutput(params) {
	await params.delivery.settleVisibleText();
	let queuedFinal = params.delivery.hasDeliveredVisibleText() && !params.delivery.hasFailedVisibleTextDelivery();
	const ttsMode = resolveConfiguredTtsMode(params.cfg, {
		agentId: params.agentId,
		channelId: params.ttsChannel,
		accountId: params.ttsAccountId
	});
	const accumulatedVisibleBlockText = params.delivery.getAccumulatedVisibleBlockText();
	const accumulatedBlockTtsText = params.delivery.getAccumulatedBlockTtsText();
	const hasAccumulatedBlockText = accumulatedBlockTtsText.trim().length > 0;
	const ttsStatus = resolveStatusTtsSnapshot({
		cfg: params.cfg,
		sessionAuto: params.sessionTtsAuto,
		agentId: params.agentId,
		channelId: params.ttsChannel,
		accountId: params.ttsAccountId
	});
	const canAttemptFinalTts = ttsStatus != null && !(ttsStatus.autoMode === "inbound" && !params.inboundAudio);
	let finalMediaDelivered = false;
	if (ttsMode === "final" && hasAccumulatedBlockText && canAttemptFinalTts) try {
		const { maybeApplyTtsToPayload } = await loadDispatchAcpTtsRuntime();
		const ttsSyntheticReply = await maybeApplyTtsToPayload({
			payload: { text: accumulatedBlockTtsText },
			cfg: params.cfg,
			channel: params.ttsChannel,
			kind: "final",
			inboundAudio: params.inboundAudio,
			ttsAuto: params.sessionTtsAuto,
			agentId: params.agentId,
			accountId: params.ttsAccountId
		});
		if (ttsSyntheticReply.mediaUrl) {
			const delivered = await params.delivery.deliver("final", markReplyPayloadAsTtsSupplement({
				mediaUrl: ttsSyntheticReply.mediaUrl,
				audioAsVoice: ttsSyntheticReply.audioAsVoice,
				spokenText: accumulatedBlockTtsText,
				trustedLocalMedia: true
			}, accumulatedBlockTtsText, { visibleTextAlreadyDelivered: true }));
			queuedFinal = queuedFinal || delivered;
			finalMediaDelivered = delivered;
		}
	} catch (err) {
		logVerbose(`dispatch-acp: accumulated ACP block TTS failed: ${formatErrorMessage(err)}`);
	}
	if (ttsMode !== "all" && accumulatedVisibleBlockText.trim().length > 0 && !finalMediaDelivered && !params.delivery.hasDeliveredFinalReply() && (!params.delivery.hasDeliveredVisibleText() || params.delivery.hasFailedVisibleTextDelivery())) {
		const delivered = await params.delivery.deliver("final", { text: accumulatedVisibleBlockText }, { skipTts: true });
		queuedFinal = queuedFinal || delivered;
	}
	if (params.shouldEmitResolvedIdentityNotice) {
		const { readAcpSessionEntry } = await loadDispatchAcpSessionRuntime();
		const currentMeta = readAcpSessionEntry({
			cfg: params.cfg,
			sessionKey: params.sessionKey
		})?.acp;
		if (!isSessionIdentityPending(resolveSessionIdentityFromMeta(currentMeta))) {
			const resolvedDetails = resolveAcpThreadSessionDetailLines({
				sessionKey: params.sessionKey,
				meta: currentMeta
			});
			if (resolvedDetails.length > 0) {
				const delivered = await params.delivery.deliver("final", { text: prefixSystemMessage(["Session ids resolved.", ...resolvedDetails].join("\n")) });
				queuedFinal = queuedFinal || delivered;
			}
		}
	}
	return queuedFinal;
}
async function tryDispatchAcpReply(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!sessionKey || params.bypassForCommand) return null;
	const { getAcpSessionManager } = await loadDispatchAcpManagerRuntime();
	const acpManager = getAcpSessionManager();
	const acpResolution = acpManager.resolveSession({
		cfg: params.cfg,
		sessionKey
	});
	if (acpResolution.kind === "none") return null;
	const canonicalSessionKey = acpResolution.sessionKey;
	const acpAgentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
	const progressSessionKeys = isDiagnosticsEnabled(params.cfg) ? Array.from(new Set([
		params.ctx.SessionKey,
		sessionKey,
		canonicalSessionKey
	].map((key) => normalizeOptionalString(key)).filter((key) => Boolean(key)))) : [];
	const markAcpProgress = progressSessionKeys.length > 0 ? () => {
		for (const key of progressSessionKeys) markDiagnosticSessionProgress({ sessionKey: key });
	} : void 0;
	let queuedFinal = false;
	const delivery = createAcpDispatchDeliveryCoordinator({
		cfg: params.cfg,
		agentId: acpAgentId,
		ctx: params.ctx,
		dispatcher: params.dispatcher,
		inboundAudio: params.inboundAudio,
		sessionKey: canonicalSessionKey,
		sessionTtsAuto: params.sessionTtsAuto,
		ttsChannel: params.ttsChannel,
		suppressUserDelivery: params.suppressUserDelivery,
		suppressReplyLifecycle: params.suppressReplyLifecycle,
		shouldRouteToOriginating: params.shouldRouteToOriginating,
		originatingChannel: params.originatingChannel,
		originatingTo: params.originatingTo,
		onReplyStart: params.onReplyStart,
		abortSignal: params.abortSignal
	});
	const identityPendingBeforeTurn = isSessionIdentityPending(resolveSessionIdentityFromMeta(acpResolution.kind === "ready" ? acpResolution.meta : void 0));
	const shouldEmitResolvedIdentityNotice = !params.suppressUserDelivery && identityPendingBeforeTurn && (Boolean(params.ctx.MessageThreadId != null && (normalizeOptionalString(String(params.ctx.MessageThreadId)) ?? "")) || await hasBoundConversationForSession({
		cfg: params.cfg,
		sessionKey: canonicalSessionKey,
		channelRaw: params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider,
		accountIdRaw: params.ctx.AccountId
	}));
	const resolvedAcpAgent = acpResolution.kind === "ready" ? normalizeOptionalString(acpResolution.meta.agent) ?? normalizeOptionalString(params.cfg.acp?.defaultAgent) ?? resolveAgentIdFromSessionKey(canonicalSessionKey) : resolveAgentIdFromSessionKey(canonicalSessionKey);
	const normalizedDispatchChannel = normalizeOptionalLowercaseString(params.ctx.OriginatingChannel ?? params.ctx.Surface ?? params.ctx.Provider);
	const explicitDispatchAccountId = normalizeOptionalString(params.ctx.AccountId);
	const dispatchChannels = params.cfg.channels;
	const defaultDispatchAccount = normalizedDispatchChannel == null ? void 0 : dispatchChannels?.[normalizedDispatchChannel]?.defaultAccount;
	const effectiveDispatchAccountId = explicitDispatchAccountId ?? normalizeOptionalString(defaultDispatchAccount);
	const projector = createAcpReplyProjector({
		cfg: params.cfg,
		shouldSendToolSummaries: params.shouldSendToolSummaries,
		deliver: delivery.deliver,
		onProgress: markAcpProgress,
		provider: params.ctx.Surface ?? params.ctx.Provider,
		accountId: effectiveDispatchAccountId
	});
	const acpDispatchStartedAt = Date.now();
	try {
		const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
		if (dispatchPolicyError) throw dispatchPolicyError;
		if (acpResolution.kind === "stale") {
			await maybeUnbindStaleBoundConversations({
				targetSessionKey: canonicalSessionKey,
				error: acpResolution.error
			});
			const delivered = await delivery.deliver("final", {
				text: formatAcpRuntimeErrorText(acpResolution.error),
				isError: true
			});
			const counts = params.dispatcher.getQueuedCounts();
			delivery.applyRoutedCounts(counts);
			const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
			logVerbose(`acp-dispatch: session=${sessionKey} outcome=error code=${acpResolution.error.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`);
			params.recordProcessed("completed", { reason: `acp_error:${normalizeLowercaseStringOrEmpty(acpResolution.error.code)}` });
			params.markIdle("message_completed");
			return {
				queuedFinal: delivered,
				counts
			};
		}
		const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, resolvedAcpAgent);
		if (agentPolicyError) throw agentPolicyError;
		if (hasInboundMedia(params.ctx) && !params.ctx.MediaUnderstanding?.length) try {
			const { applyMediaUnderstanding } = await loadAgentTurnMediaRuntime();
			await applyMediaUnderstanding({
				ctx: params.ctx,
				cfg: params.cfg,
				agentDir: resolveAgentDir(params.cfg, acpAgentId),
				workspaceDir: resolveAgentWorkspaceDir(params.cfg, acpAgentId)
			});
		} catch (err) {
			logVerbose(`dispatch-acp: media understanding failed, proceeding with raw content: ${formatErrorMessage(err)}`);
		}
		const promptText = resolveAcpPromptText(params.ctx);
		const resolvedTurnAttachments = await resolveAgentTurnAttachments({
			ctx: params.ctx,
			cfg: params.cfg
		});
		const mediaAttachments = resolvedTurnAttachments.attachments;
		const inlineAttachments = resolveInlineAgentImageAttachments(params.images);
		const mediaAttachmentsAreOnlyRecentHistory = mediaAttachments.length > 0 && mediaAttachments.length === resolvedTurnAttachments.recentHistoryImages.length;
		const attachments = mediaAttachments.length > 0 && !(mediaAttachmentsAreOnlyRecentHistory && inlineAttachments.length > 0) ? mediaAttachments : inlineAttachments;
		const turnPromptText = attachments === mediaAttachments ? appendRecentHistoryImageContext({
			promptText,
			images: resolvedTurnAttachments.recentHistoryImages
		}) : promptText;
		if (!turnPromptText && attachments.length === 0) {
			const counts = params.dispatcher.getQueuedCounts();
			delivery.applyRoutedCounts(counts);
			params.recordProcessed("completed", { reason: "acp_empty_prompt" });
			params.markIdle("message_completed");
			return {
				queuedFinal: false,
				counts
			};
		}
		try {
			await delivery.startReplyLifecycle();
		} catch (error) {
			logVerbose(`dispatch-acp: start reply lifecycle failed: ${formatErrorMessage(error)}`);
		}
		await acpManager.runTurn({
			cfg: params.cfg,
			sessionKey: canonicalSessionKey,
			text: resolveAcpTurnText({
				promptText: turnPromptText,
				sourceReplyDeliveryMode: params.sourceReplyDeliveryMode
			}),
			attachments: attachments.length > 0 ? attachments : void 0,
			mode: "prompt",
			requestId: resolveAcpRequestId(params.ctx),
			...params.abortSignal ? { signal: params.abortSignal } : {},
			onEvent: async (event) => await projector.onEvent(event)
		});
		await projector.flush(true);
		if (params.abortSignal?.aborted) {
			const counts = params.dispatcher.getQueuedCounts();
			delivery.applyRoutedCounts(counts);
			params.recordProcessed("completed", { reason: "acp_aborted" });
			params.markIdle("message_aborted");
			return {
				queuedFinal,
				counts
			};
		}
		try {
			const { persistAcpDispatchTranscript } = await loadDispatchAcpTranscriptRuntime();
			await persistAcpDispatchTranscript({
				cfg: params.cfg,
				sessionKey: canonicalSessionKey,
				promptText: turnPromptText,
				finalText: delivery.getAccumulatedFinalText() || delivery.getAccumulatedBlockText(),
				meta: acpResolution.meta,
				threadId: params.ctx.MessageThreadId
			});
		} catch (error) {
			logVerbose(`dispatch-acp: transcript persistence failed for ${canonicalSessionKey}: ${formatErrorMessage(error)}`);
		}
		queuedFinal = await finalizeAcpTurnOutput({
			cfg: params.cfg,
			sessionKey: canonicalSessionKey,
			agentId: acpAgentId,
			delivery,
			inboundAudio: params.inboundAudio,
			sessionTtsAuto: params.sessionTtsAuto,
			ttsChannel: params.ttsChannel,
			ttsAccountId: effectiveDispatchAccountId,
			shouldEmitResolvedIdentityNotice
		}) || queuedFinal;
		const counts = params.dispatcher.getQueuedCounts();
		delivery.applyRoutedCounts(counts);
		const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
		const runId = normalizeOptionalString(params.runId);
		if (runId) emitAgentEvent({
			runId,
			sessionKey,
			stream: "lifecycle",
			data: {
				phase: "end",
				startedAt: acpDispatchStartedAt,
				endedAt: Date.now()
			}
		});
		logVerbose(`acp-dispatch: session=${sessionKey} outcome=ok latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`);
		params.recordProcessed("completed", { reason: "acp_dispatch" });
		params.markIdle("message_completed");
		return {
			queuedFinal,
			counts
		};
	} catch (err) {
		await projector.flush(true);
		const acpError = toAcpRuntimeError({
			error: err,
			fallbackCode: "ACP_TURN_FAILED",
			fallbackMessage: "ACP turn failed before completion."
		});
		await maybeUnbindStaleBoundConversations({
			targetSessionKey: canonicalSessionKey,
			error: acpError
		});
		const delivered = await delivery.deliver("final", {
			text: formatAcpRuntimeErrorText(acpError),
			isError: true
		});
		queuedFinal = queuedFinal || delivered;
		const counts = params.dispatcher.getQueuedCounts();
		delivery.applyRoutedCounts(counts);
		const acpStats = acpManager.getObservabilitySnapshot(params.cfg);
		const runId = normalizeOptionalString(params.runId);
		if (runId) emitAgentEvent({
			runId,
			sessionKey,
			stream: "lifecycle",
			data: {
				phase: "error",
				startedAt: acpDispatchStartedAt,
				endedAt: Date.now(),
				error: acpError.message
			}
		});
		logVerbose(`acp-dispatch: session=${sessionKey} outcome=error code=${acpError.code} latencyMs=${Date.now() - acpDispatchStartedAt} queueDepth=${acpStats.turns.queueDepth} activeRuntimes=${acpStats.runtimeCache.activeSessions}`);
		params.recordProcessed("completed", { reason: `acp_error:${normalizeLowercaseStringOrEmpty(acpError.code)}` });
		params.markIdle("message_completed");
		return {
			queuedFinal,
			counts
		};
	}
}
//#endregion
export { tryDispatchAcpReply };
