import { g as normalizeVerboseLevel, m as normalizeTraceLevel } from "./thinking-DNSlsULp.js";
//#region src/sessions/level-overrides.ts
const INVALID_VERBOSE_LEVEL_ERROR = "invalid verboseLevel (use \"on\"|\"off\"|\"full\")";
function parseVerboseOverride(raw) {
	if (raw === null) return {
		ok: true,
		value: null
	};
	if (raw === void 0) return {
		ok: true,
		value: void 0
	};
	if (typeof raw !== "string") return {
		ok: false,
		error: INVALID_VERBOSE_LEVEL_ERROR
	};
	const normalized = normalizeVerboseLevel(raw);
	if (!normalized) return {
		ok: false,
		error: INVALID_VERBOSE_LEVEL_ERROR
	};
	return {
		ok: true,
		value: normalized
	};
}
function applyVerboseOverride(entry, level) {
	if (level === void 0) return;
	if (level === null) {
		delete entry.verboseLevel;
		return;
	}
	entry.verboseLevel = level;
}
function parseTraceOverride(raw) {
	if (raw === null) return {
		ok: true,
		value: null
	};
	if (raw === void 0) return {
		ok: true,
		value: void 0
	};
	if (typeof raw !== "string") return {
		ok: false,
		error: "invalid traceLevel (use \"on\"|\"off\"|\"raw\")"
	};
	const normalized = normalizeTraceLevel(raw);
	if (!normalized) return {
		ok: false,
		error: "invalid traceLevel (use \"on\"|\"off\"|\"raw\")"
	};
	return {
		ok: true,
		value: normalized
	};
}
function applyTraceOverride(entry, level) {
	if (level === void 0) return;
	if (level === null) {
		delete entry.traceLevel;
		return;
	}
	entry.traceLevel = level;
}
//#endregion
export { parseVerboseOverride as i, applyVerboseOverride as n, parseTraceOverride as r, applyTraceOverride as t };
