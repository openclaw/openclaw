import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
//#region src/cli/parse-duration.ts
const DURATION_MULTIPLIERS = {
	ms: 1,
	s: 1e3,
	m: 6e4,
	h: 36e5,
	d: 864e5
};
function invalidDuration(raw, reason) {
	const value = raw.trim() ? `"${raw}"` : "empty value";
	const prefix = reason ? `Invalid duration (${reason}): ${value}.` : `Invalid duration: ${value}.`;
	return /* @__PURE__ */ new Error(`${prefix} Use values like 500ms, 30s, 5m, 2h, or 1h30m.`);
}
function parseDurationMs(raw, opts) {
	const trimmed = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw) ?? "");
	if (!trimmed) throw invalidDuration(raw, "empty");
	const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
	if (single) {
		const value = Number(single[1]);
		if (!Number.isFinite(value) || value < 0) throw invalidDuration(raw);
		const unit = single[2] ?? opts?.defaultUnit ?? "ms";
		const ms = Math.round(value * DURATION_MULTIPLIERS[unit]);
		if (!Number.isFinite(ms)) throw invalidDuration(raw);
		return ms;
	}
	let totalMs = 0;
	let consumed = 0;
	for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)) {
		const [full, valueRaw, unitRaw] = match;
		const index = match.index ?? -1;
		if (!full || !valueRaw || !unitRaw || index < 0) throw invalidDuration(raw);
		if (index !== consumed) throw invalidDuration(raw, "each composite segment needs a unit");
		const value = Number(valueRaw);
		if (!Number.isFinite(value) || value < 0) throw invalidDuration(raw);
		const multiplier = DURATION_MULTIPLIERS[unitRaw];
		if (!multiplier) throw invalidDuration(raw);
		totalMs += value * multiplier;
		consumed += full.length;
	}
	if (consumed !== trimmed.length || consumed === 0) throw invalidDuration(raw);
	const ms = Math.round(totalMs);
	if (!Number.isFinite(ms)) throw invalidDuration(raw);
	return ms;
}
//#endregion
export { parseDurationMs as t };
