import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as TOOL_DISPLAY_CONFIG, r as resolveToolDisplay } from "./tool-display-CN2B3x-5.js";
import "./identity-nYw-h8DL.js";
//#region src/channels/status-reactions.ts
const DEFAULT_EMOJIS = {
	queued: "👀",
	thinking: "🧠",
	tool: "🛠️",
	coding: "💻",
	web: "🌐",
	deploy: "🛫",
	build: "🏗️",
	concierge: "💁",
	done: "✅",
	error: "❌",
	stallSoft: "⏳",
	stallHard: "⚠️",
	compacting: "🗜️"
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
const DEPLOY_TOOL_TOKENS = [
	"fastlane",
	"deploy",
	"upload",
	"testflight",
	"ship",
	"release",
	"publish",
	"distribute"
];
const BUILD_TOOL_TOKENS = [
	"build",
	"compile",
	"xcode",
	"swift",
	"gradle",
	"cargo",
	"make",
	"cmake",
	"webpack",
	"vite",
	"tsc",
	"lint"
];
const CONCIERGE_TOOL_TOKENS = [
	"navigate",
	"click",
	"fill",
	"screenshot",
	"scroll",
	"page",
	"form",
	"puppeteer",
	"playwright",
	"selenium",
	"chromedp"
];
/**
* Resolve the appropriate emoji for a tool invocation.
*/
function resolveToolEmoji(toolName, emojis, emojiOverrides) {
	const normalized = normalizeOptionalLowercaseString(toolName) ?? "";
	if (!normalized) return emojis.tool;
	const category = DEPLOY_TOOL_TOKENS.some((token) => normalized.includes(token)) ? "deploy" : BUILD_TOOL_TOKENS.some((token) => normalized.includes(token)) ? "build" : CONCIERGE_TOOL_TOKENS.some((token) => normalized.includes(token)) ? "concierge" : WEB_TOOL_TOKENS.some((token) => normalized.includes(token)) ? "web" : CODING_TOOL_TOKENS.some((token) => normalized.includes(token)) ? "coding" : "tool";
	if (emojiOverrides?.[category] !== void 0) return emojis[category];
	if (Object.hasOwn(TOOL_DISPLAY_CONFIG.tools, normalized)) return resolveToolDisplay({ name: toolName }).emoji;
	if (category === "deploy") return emojis.deploy;
	if (category === "build") return emojis.build;
	if (category === "concierge") return emojis.concierge;
	if (category === "web") return emojis.web;
	if (category === "coding") return emojis.coding;
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
* - Defers reaction removals until final cleanup to avoid visible flicker on
*   platforms without atomic reaction replacement
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
	const activeEmojis = /* @__PURE__ */ new Set();
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
		if (stallSoftTimer) clearTimeout(stallSoftTimer);
		if (stallHardTimer) clearTimeout(stallHardTimer);
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
	async function removeActiveEmojis(options = {}) {
		if (!adapter.removeReaction) return;
		for (const emoji of Array.from(activeEmojis)) {
			if (emoji === options.keepEmoji) continue;
			try {
				await adapter.removeReaction(emoji);
			} catch (err) {
				if (onError) onError(err);
			} finally {
				activeEmojis.delete(emoji);
			}
		}
	}
	/**
	* Apply an emoji while keeping previous active-loop reactions visible.
	*/
	async function applyEmoji(newEmoji) {
		if (!enabled) return;
		try {
			if (!adapter.removeReaction || !activeEmojis.has(newEmoji)) await adapter.setReaction(newEmoji);
			activeEmojis.add(newEmoji);
			currentEmoji = newEmoji;
		} catch (err) {
			if (onError) onError(err);
		}
	}
	/**
	* Schedule an emoji change (debounced or immediate).
	*/
	function scheduleEmoji(emoji, options = {}) {
		if (!enabled || finished) return;
		if (emoji === currentEmoji || emoji === pendingEmoji) {
			if (!options.skipStallReset) resetStallTimers();
			return;
		}
		pendingEmoji = emoji;
		clearDebounceTimer();
		if (options.immediate) enqueue(async () => {
			await applyEmoji(emoji);
			pendingEmoji = "";
		});
		else debounceTimer = setTimeout(() => {
			debounceTimer = null;
			enqueue(async () => {
				await applyEmoji(emoji);
				pendingEmoji = "";
			});
		}, timing.debounceMs);
		if (!options.skipStallReset) resetStallTimers();
	}
	function setQueued() {
		scheduleEmoji(emojis.queued, { immediate: true });
	}
	function setThinking() {
		scheduleEmoji(emojis.thinking);
	}
	function setTool(toolName) {
		scheduleEmoji(resolveToolEmoji(toolName, emojis, params.emojis));
	}
	function setCompacting() {
		scheduleEmoji(emojis.compacting);
	}
	function cancelPending() {
		clearDebounceTimer();
		pendingEmoji = "";
	}
	function finishWithEmoji(emoji) {
		if (!enabled) return Promise.resolve();
		finished = true;
		clearAllTimers();
		return enqueue(async () => {
			await applyEmoji(emoji);
			await removeActiveEmojis({ keepEmoji: emoji });
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
		if (!enabled) return;
		clearAllTimers();
		finished = true;
		await enqueue(async () => {
			if (adapter.clearReaction) try {
				await adapter.clearReaction();
			} catch (err) {
				if (onError) onError(err);
			} finally {
				activeEmojis.clear();
			}
			else if (adapter.removeReaction) await removeActiveEmojis();
			currentEmoji = "";
			pendingEmoji = "";
		});
	}
	async function restoreInitial() {
		if (!enabled) return;
		const alreadyInitial = currentEmoji === initialEmoji;
		const pendingBeforeClear = pendingEmoji;
		const hadDebouncedPending = debounceTimer !== null;
		const hasExtraActiveEmoji = Array.from(activeEmojis).some((emoji) => emoji !== initialEmoji);
		clearAllTimers();
		if (alreadyInitial && (!pendingBeforeClear || hadDebouncedPending) && !hasExtraActiveEmoji) {
			pendingEmoji = "";
			return;
		}
		if (pendingBeforeClear === initialEmoji && !hadDebouncedPending) {
			await chainPromise;
			return;
		}
		await enqueue(async () => {
			await applyEmoji(initialEmoji);
			await removeActiveEmojis({ keepEmoji: initialEmoji });
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
export { DEFAULT_TIMING as a, createStatusReactionController as c, DEFAULT_EMOJIS as i, resolveToolEmoji as l, CODING_TOOL_TOKENS as n, DEPLOY_TOOL_TOKENS as o, CONCIERGE_TOOL_TOKENS as r, WEB_TOOL_TOKENS as s, BUILD_TOOL_TOKENS as t };
