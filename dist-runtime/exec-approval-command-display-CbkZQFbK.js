import { Si as GatewayClient, aa as ensureConfiguredAcpBindingSession, ca as deriveLastRoutePolicy, fl as GATEWAY_CLIENT_MODES, oa as resolveConfiguredAcpBindingRecord, pl as GATEWAY_CLIENT_NAMES, xi as resolveGatewayCredentialsWithSecretInputs, yi as buildGatewayConnectionDetails } from "./model-selection-BJ_ZbQnz.js";
import { U as resolveAgentIdFromSessionKey } from "./workspace-CwIhVocA.js";
import { n as createDraftStreamLoop } from "./native-command-session-targets-CObBQJCx.js";
//#region src/channels/status-reactions.ts
const DEFAULT_EMOJIS = {
	queued: "👀",
	thinking: "🤔",
	tool: "🔥",
	coding: "👨‍💻",
	web: "⚡",
	done: "👍",
	error: "😱",
	stallSoft: "🥱",
	stallHard: "😨",
	compacting: "✍"
};
const DEFAULT_TIMING = {
	debounceMs: 700,
	stallSoftMs: 1e4,
	stallHardMs: 3e4,
	doneHoldMs: 1500,
	errorHoldMs: 2500
};
const CODING_TOOL_TOKENS = [
	"exec",
	"process",
	"read",
	"write",
	"edit",
	"session_status",
	"bash"
];
const WEB_TOOL_TOKENS = [
	"web_search",
	"web-search",
	"web_fetch",
	"web-fetch",
	"browser"
];
/**
* Resolve the appropriate emoji for a tool invocation.
*/
function resolveToolEmoji(toolName, emojis) {
	const normalized = toolName?.trim().toLowerCase() ?? "";
	if (!normalized) {return emojis.tool;}
	if (WEB_TOOL_TOKENS.some((token) => normalized.includes(token))) {return emojis.web;}
	if (CODING_TOOL_TOKENS.some((token) => normalized.includes(token))) {return emojis.coding;}
	return emojis.tool;
}
/**
* Create a status reaction controller.
*
* Features:
* - Promise chain serialization (prevents concurrent API calls)
* - Debouncing (intermediate states debounce, terminal states are immediate)
* - Stall timers (soft/hard warnings on inactivity)
* - Terminal state protection (done/error mark finished, subsequent updates ignored)
*/
function createStatusReactionController(params) {
	const { enabled, adapter, initialEmoji, onError } = params;
	const emojis = {
		...DEFAULT_EMOJIS,
		queued: params.emojis?.queued ?? initialEmoji,
		...params.emojis
	};
	const timing = {
		...DEFAULT_TIMING,
		...params.timing
	};
	let currentEmoji = "";
	let pendingEmoji = "";
	let debounceTimer = null;
	let stallSoftTimer = null;
	let stallHardTimer = null;
	let finished = false;
	let chainPromise = Promise.resolve();
	const knownEmojis = new Set([
		initialEmoji,
		emojis.queued,
		emojis.thinking,
		emojis.tool,
		emojis.coding,
		emojis.web,
		emojis.done,
		emojis.error,
		emojis.stallSoft,
		emojis.stallHard,
		emojis.compacting
	]);
	/**
	* Serialize async operations to prevent race conditions.
	*/
	function enqueue(fn) {
		chainPromise = chainPromise.then(fn, fn);
		return chainPromise;
	}
	/**
	* Clear all timers.
	*/
	function clearAllTimers() {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (stallSoftTimer) {
			clearTimeout(stallSoftTimer);
			stallSoftTimer = null;
		}
		if (stallHardTimer) {
			clearTimeout(stallHardTimer);
			stallHardTimer = null;
		}
	}
	/**
	* Clear debounce timer only (used during phase transitions).
	*/
	function clearDebounceTimer() {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}
	/**
	* Reset stall timers (called on each phase change).
	*/
	function resetStallTimers() {
		if (stallSoftTimer) {clearTimeout(stallSoftTimer);}
		if (stallHardTimer) {clearTimeout(stallHardTimer);}
		stallSoftTimer = setTimeout(() => {
			scheduleEmoji(emojis.stallSoft, {
				immediate: true,
				skipStallReset: true
			});
		}, timing.stallSoftMs);
		stallHardTimer = setTimeout(() => {
			scheduleEmoji(emojis.stallHard, {
				immediate: true,
				skipStallReset: true
			});
		}, timing.stallHardMs);
	}
	/**
	* Apply an emoji: set new reaction and optionally remove old one.
	*/
	async function applyEmoji(newEmoji) {
		if (!enabled) {return;}
		try {
			const previousEmoji = currentEmoji;
			await adapter.setReaction(newEmoji);
			if (adapter.removeReaction && previousEmoji && previousEmoji !== newEmoji) {await adapter.removeReaction(previousEmoji);}
			currentEmoji = newEmoji;
		} catch (err) {
			if (onError) {onError(err);}
		}
	}
	/**
	* Schedule an emoji change (debounced or immediate).
	*/
	function scheduleEmoji(emoji, options = {}) {
		if (!enabled || finished) {return;}
		if (emoji === currentEmoji || emoji === pendingEmoji) {
			if (!options.skipStallReset) {resetStallTimers();}
			return;
		}
		pendingEmoji = emoji;
		clearDebounceTimer();
		if (options.immediate) {enqueue(async () => {
			await applyEmoji(emoji);
			pendingEmoji = "";
		});}
		else {debounceTimer = setTimeout(() => {
			enqueue(async () => {
				await applyEmoji(emoji);
				pendingEmoji = "";
			});
		}, timing.debounceMs);}
		if (!options.skipStallReset) {resetStallTimers();}
	}
	function setQueued() {
		scheduleEmoji(emojis.queued, { immediate: true });
	}
	function setThinking() {
		scheduleEmoji(emojis.thinking);
	}
	function setTool(toolName) {
		scheduleEmoji(resolveToolEmoji(toolName, emojis));
	}
	function setCompacting() {
		scheduleEmoji(emojis.compacting);
	}
	function cancelPending() {
		clearDebounceTimer();
		pendingEmoji = "";
	}
	function finishWithEmoji(emoji) {
		if (!enabled) {return Promise.resolve();}
		finished = true;
		clearAllTimers();
		return enqueue(async () => {
			await applyEmoji(emoji);
			pendingEmoji = "";
		});
	}
	function setDone() {
		return finishWithEmoji(emojis.done);
	}
	function setError() {
		return finishWithEmoji(emojis.error);
	}
	async function clear() {
		if (!enabled) {return;}
		clearAllTimers();
		finished = true;
		await enqueue(async () => {
			if (adapter.removeReaction) {
				const emojisToRemove = Array.from(knownEmojis);
				for (const emoji of emojisToRemove) {try {
					await adapter.removeReaction(emoji);
				} catch (err) {
					if (onError) onError(err);
				}}
			}
			currentEmoji = "";
			pendingEmoji = "";
		});
	}
	async function restoreInitial() {
		if (!enabled) {return;}
		clearAllTimers();
		await enqueue(async () => {
			await applyEmoji(initialEmoji);
			pendingEmoji = "";
		});
	}
	return {
		setQueued,
		setThinking,
		setTool,
		setCompacting,
		cancelPending,
		setDone,
		setError,
		clear,
		restoreInitial
	};
}
//#endregion
//#region src/channels/draft-stream-controls.ts
function createFinalizableDraftStreamControls(params) {
	const loop = createDraftStreamLoop({
		throttleMs: params.throttleMs,
		isStopped: params.isStopped,
		sendOrEditStreamMessage: params.sendOrEditStreamMessage
	});
	const update = (text) => {
		if (params.isStopped() || params.isFinal()) {return;}
		loop.update(text);
	};
	const stop = async () => {
		params.markFinal();
		await loop.flush();
	};
	const stopForClear = async () => {
		params.markStopped();
		loop.stop();
		await loop.waitForInFlight();
	};
	return {
		loop,
		update,
		stop,
		stopForClear
	};
}
function createFinalizableDraftStreamControlsForState(params) {
	return createFinalizableDraftStreamControls({
		throttleMs: params.throttleMs,
		isStopped: () => params.state.stopped,
		isFinal: () => params.state.final,
		markStopped: () => {
			params.state.stopped = true;
		},
		markFinal: () => {
			params.state.final = true;
		},
		sendOrEditStreamMessage: params.sendOrEditStreamMessage
	});
}
async function takeMessageIdAfterStop(params) {
	await params.stopForClear();
	const messageId = params.readMessageId();
	params.clearMessageId();
	return messageId;
}
async function clearFinalizableDraftMessage(params) {
	const messageId = await takeMessageIdAfterStop({
		stopForClear: params.stopForClear,
		readMessageId: params.readMessageId,
		clearMessageId: params.clearMessageId
	});
	if (!params.isValidMessageId(messageId)) {return;}
	try {
		await params.deleteMessage(messageId);
		params.onDeleteSuccess?.(messageId);
	} catch (err) {
		params.warn?.(`${params.warnPrefix}: ${err instanceof Error ? err.message : String(err)}`);
	}
}
function createFinalizableDraftLifecycle(params) {
	const controls = createFinalizableDraftStreamControlsForState({
		throttleMs: params.throttleMs,
		state: params.state,
		sendOrEditStreamMessage: params.sendOrEditStreamMessage
	});
	const clear = async () => {
		await clearFinalizableDraftMessage({
			stopForClear: controls.stopForClear,
			readMessageId: params.readMessageId,
			clearMessageId: params.clearMessageId,
			isValidMessageId: params.isValidMessageId,
			deleteMessage: params.deleteMessage,
			onDeleteSuccess: params.onDeleteSuccess,
			warn: params.warn,
			warnPrefix: params.warnPrefix
		});
	};
	return {
		...controls,
		clear
	};
}
//#endregion
//#region src/acp/persistent-bindings.route.ts
function resolveConfiguredAcpRoute(params) {
	const configuredBinding = resolveConfiguredAcpBindingRecord({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!configuredBinding) {return {
		configuredBinding: null,
		route: params.route
	};}
	const boundSessionKey = configuredBinding.record.targetSessionKey?.trim() ?? "";
	if (!boundSessionKey) {return {
		configuredBinding,
		route: params.route
	};}
	const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || params.route.agentId;
	return {
		configuredBinding,
		boundSessionKey,
		boundAgentId,
		route: {
			...params.route,
			sessionKey: boundSessionKey,
			agentId: boundAgentId,
			lastRoutePolicy: deriveLastRoutePolicy({
				sessionKey: boundSessionKey,
				mainSessionKey: params.route.mainSessionKey
			}),
			matchedBy: "binding.channel"
		}
	};
}
async function ensureConfiguredAcpRouteReady(params) {
	if (!params.configuredBinding) {return { ok: true };}
	const ensured = await ensureConfiguredAcpBindingSession({
		cfg: params.cfg,
		spec: params.configuredBinding.spec
	});
	if (ensured.ok) {return { ok: true };}
	return {
		ok: false,
		error: ensured.error ?? "unknown error"
	};
}
//#endregion
//#region src/gateway/connection-auth.ts
function toGatewayCredentialOptions(params) {
	return {
		cfg: params.cfg,
		env: params.env,
		explicitAuth: params.explicitAuth,
		urlOverride: params.urlOverride,
		urlOverrideSource: params.urlOverrideSource,
		modeOverride: params.modeOverride,
		includeLegacyEnv: params.includeLegacyEnv,
		localTokenPrecedence: params.localTokenPrecedence,
		localPasswordPrecedence: params.localPasswordPrecedence,
		remoteTokenPrecedence: params.remoteTokenPrecedence,
		remotePasswordPrecedence: params.remotePasswordPrecedence,
		remoteTokenFallback: params.remoteTokenFallback,
		remotePasswordFallback: params.remotePasswordFallback
	};
}
async function resolveGatewayConnectionAuth(params) {
	return await resolveGatewayCredentialsWithSecretInputs({
		config: params.config,
		...toGatewayCredentialOptions({
			...params,
			cfg: params.config
		})
	});
}
//#endregion
//#region src/gateway/operator-approvals-client.ts
async function createOperatorApprovalsGatewayClient(params) {
	const { url: gatewayUrl, urlSource } = buildGatewayConnectionDetails({
		config: params.config,
		url: params.gatewayUrl
	});
	const gatewayUrlOverrideSource = urlSource === "cli --url" ? "cli" : urlSource === "env OPENCLAW_GATEWAY_URL" ? "env" : void 0;
	const auth = await resolveGatewayConnectionAuth({
		config: params.config,
		env: process.env,
		urlOverride: gatewayUrlOverrideSource ? gatewayUrl : void 0,
		urlOverrideSource: gatewayUrlOverrideSource
	});
	return new GatewayClient({
		url: gatewayUrl,
		token: auth.token,
		password: auth.password,
		clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
		clientDisplayName: params.clientDisplayName,
		mode: GATEWAY_CLIENT_MODES.BACKEND,
		scopes: ["operator.approvals"],
		onEvent: params.onEvent,
		onHelloOk: params.onHelloOk,
		onConnectError: params.onConnectError,
		onClose: params.onClose
	});
}
//#endregion
//#region src/infra/exec-approval-command-display.ts
const UNICODE_FORMAT_CHAR_REGEX = /\p{Cf}/gu;
function formatCodePointEscape(char) {
	return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
}
function sanitizeExecApprovalDisplayText(commandText) {
	return commandText.replace(UNICODE_FORMAT_CHAR_REGEX, formatCodePointEscape);
}
function normalizePreview(commandText, commandPreview) {
	const previewRaw = commandPreview?.trim() ?? "";
	if (!previewRaw) {return null;}
	const preview = sanitizeExecApprovalDisplayText(previewRaw);
	if (preview === commandText) {return null;}
	return preview;
}
function resolveExecApprovalCommandDisplay(request) {
	const commandText = sanitizeExecApprovalDisplayText(request.command || (request.host === "node" && request.systemRunPlan ? request.systemRunPlan.commandText : ""));
	return {
		commandText,
		commandPreview: normalizePreview(commandText, request.commandPreview ?? (request.host === "node" ? request.systemRunPlan?.commandPreview ?? null : null))
	};
}
//#endregion
export { createFinalizableDraftLifecycle as a, createStatusReactionController as c, resolveConfiguredAcpRoute as i, createOperatorApprovalsGatewayClient as n, DEFAULT_EMOJIS as o, ensureConfiguredAcpRouteReady as r, DEFAULT_TIMING as s, resolveExecApprovalCommandDisplay as t };
