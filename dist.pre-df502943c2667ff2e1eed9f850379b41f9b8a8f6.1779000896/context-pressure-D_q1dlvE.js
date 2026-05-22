import { t as createSubsystemLogger } from "./subsystem-CwZgZA6E.js";
import { a as enqueueSystemEvent } from "./system-events-B4ot3XuJ.js";
//#region src/auto-reply/continuation/context-pressure.ts
const log = createSubsystemLogger("continuation/context-pressure");
const DEFAULT_CONTEXT_PRESSURE_THRESHOLD = .8;
/**
* Per-session dedup state: the last band that fired.
* Reset when a new lifecycle begins (e.g., after compaction).
*
* Absence (`!map.has(sessionKey)`) means the session has never fired —
* it replaces the prior `-1` magic sentinel.
*/
const lastFiredBand = /* @__PURE__ */ new Map();
/**
* Resolve which pressure band the current ratio falls into.
* Returns 0 if below all bands.
*/
function resolveContextPressureBand(ratio, threshold, earlyWarningBand) {
	if (!Number.isFinite(ratio) || ratio < 0 || !Number.isFinite(threshold) || threshold <= 0) return 0;
	const thresholdPct = Math.round(threshold * 100);
	const earlyWarningMultiplier = earlyWarningBand ?? 0;
	const earlyWarningThreshold = Number.isFinite(earlyWarningMultiplier) && earlyWarningMultiplier > 0 ? threshold * earlyWarningMultiplier : 0;
	const pressureBands = [
		...earlyWarningThreshold > 0 ? [{
			threshold: earlyWarningThreshold,
			band: Math.round(earlyWarningThreshold * 100)
		}] : [],
		{
			threshold,
			band: thresholdPct
		},
		...threshold < .9 ? [{
			threshold: .9,
			band: 90
		}] : [],
		...Math.max(threshold, .9) < .95 ? [{
			threshold: .95,
			band: 95
		}] : []
	];
	let band = 0;
	for (const candidate of pressureBands) if (ratio >= candidate.threshold) band = candidate.band;
	return band;
}
function buildContextPressureEvent(params) {
	if (params.postCompaction) return `[system:context-pressure] Post-compaction: ${params.percentUsed}% context consumed (${params.tokensK}k/${params.windowK}k tokens). Session was compacted. Working state may need rehydration.`;
	const urgency = params.band >= 95 ? "COMPACTION IMMINENT — evacuate working state now. Use CONTINUE_DELEGATE to dispatch shards or write critical state to memory files immediately." : params.band >= 90 ? "Context window nearly full — strongly consider evacuating working state via CONTINUE_DELEGATE or memory files." : "Consider evacuating working state to memory files or delegating remaining work.";
	return `[system:context-pressure] ${params.percentUsed}% of context window consumed (${params.tokensK}k / ${params.windowK}k tokens). ${urgency}`;
}
function checkSessionContextPressure(params) {
	const { sessionEntry, sessionKey, contextPressureThreshold, contextWindowTokens, earlyWarningBand, postCompaction = false } = params;
	const threshold = contextPressureThreshold ?? (postCompaction ? DEFAULT_CONTEXT_PRESSURE_THRESHOLD : void 0);
	if (threshold == null || threshold <= 0 || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0 || sessionEntry.totalTokens == null || !Number.isFinite(sessionEntry.totalTokens) || sessionEntry.totalTokens <= 0 || !postCompaction && sessionEntry.totalTokensFresh === false) return {
		fired: false,
		band: 0
	};
	const ratio = Math.max(0, sessionEntry.totalTokens / contextWindowTokens);
	const band = resolveContextPressureBand(ratio, threshold, earlyWarningBand);
	if (!postCompaction && band === 0 && ratio < threshold) {
		if (log.isEnabled("debug")) log.debug(`[context-pressure:noop] reason=below-threshold ratio=${Math.round(ratio * 100)}% threshold=${Math.round(threshold * 100)}% rawRatio=${ratio.toFixed(4)} rawThreshold=${threshold.toFixed(4)} session=${sessionKey}`);
		return {
			fired: false,
			band: 0
		};
	}
	const previous = sessionEntry.lastContextPressureBand;
	if (!postCompaction && previous !== void 0 && band === previous) {
		if (log.isEnabled("debug")) log.debug(`[context-pressure:noop] reason=band-dedup band=${band} previous=${previous} ratio=${Math.round(ratio * 100)}% session=${sessionKey}`);
		return {
			fired: false,
			band
		};
	}
	const percentUsed = Math.round(ratio * 100);
	const tokensK = Math.round(sessionEntry.totalTokens / 1e3);
	const windowK = Math.round(contextWindowTokens / 1e3);
	const eventText = buildContextPressureEvent({
		percentUsed,
		tokensK,
		windowK,
		band,
		postCompaction
	});
	const logMessage = `[context-pressure:fire]${postCompaction ? " post-compaction" : ""} band=${band} previous=${previous ?? "none"} ratio=${percentUsed}% tokens=${tokensK}k/${windowK}k session=${sessionKey}`;
	if (postCompaction) log.info(logMessage);
	else log.warn(logMessage);
	enqueueSystemEvent(eventText, {
		sessionKey,
		trusted: true
	});
	sessionEntry.lastContextPressureBand = band;
	return {
		fired: true,
		band
	};
}
function checkTokenContextPressure(params) {
	const { sessionKey, totalTokens, contextWindow, threshold, earlyWarningBand, postCompaction = false } = params;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(totalTokens)) {
		if (log.isEnabled("debug")) log.debug(`[context-pressure:noop] reason=window-zero contextWindow=${contextWindow} session=${sessionKey}`);
		return null;
	}
	const ratio = totalTokens / contextWindow;
	const percentUsed = Math.round(ratio * 100);
	if (postCompaction) {
		const band = resolveContextPressureBand(ratio, threshold, earlyWarningBand);
		lastFiredBand.set(sessionKey, band);
		const eventText = buildContextPressureEvent({
			percentUsed,
			tokensK: Math.round(totalTokens / 1e3),
			windowK: Math.round(contextWindow / 1e3),
			band,
			postCompaction: true
		});
		log.info(`[context-pressure:fire] post-compaction band=${band} ratio=${percentUsed}% session=${sessionKey}`);
		return eventText;
	}
	const band = resolveContextPressureBand(ratio, threshold, earlyWarningBand);
	if (band === 0 && ratio < threshold) {
		if (log.isEnabled("debug")) log.debug(`[context-pressure:noop] reason=below-threshold ratio=${percentUsed}% threshold=${Math.round(threshold * 100)}% rawRatio=${ratio.toFixed(4)} rawThreshold=${threshold.toFixed(4)} session=${sessionKey}`);
		return null;
	}
	const previous = lastFiredBand.get(sessionKey);
	if (!(previous === void 0) && band === previous) {
		if (log.isEnabled("debug")) log.debug(`[context-pressure:noop] reason=band-dedup band=${band} previous=${previous} ratio=${percentUsed}% session=${sessionKey}`);
		return null;
	}
	lastFiredBand.set(sessionKey, band);
	const eventText = buildContextPressureEvent({
		percentUsed,
		tokensK: Math.round(totalTokens / 1e3),
		windowK: Math.round(contextWindow / 1e3),
		band
	});
	log.info(`[context-pressure:fire] band=${band} previous=${previous ?? "none"} ratio=${percentUsed}% session=${sessionKey}`);
	return eventText;
}
function checkContextPressure(params) {
	if ("sessionEntry" in params) return checkSessionContextPressure(params);
	return checkTokenContextPressure(params);
}
/**
* Clear pressure dedup state for a session. Call after compaction completes
* so the post-compaction lifecycle can fire fresh bands.
*/
function clearContextPressureState(sessionKey) {
	lastFiredBand.delete(sessionKey);
}
//#endregion
export { clearContextPressureState as n, checkContextPressure as t };
