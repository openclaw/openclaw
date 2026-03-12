//#region src/cron/parse.ts
const ISO_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T/;
function normalizeUtcIso(raw) {
	if (ISO_TZ_RE.test(raw)) return raw;
	if (ISO_DATE_RE.test(raw)) return `${raw}T00:00:00Z`;
	if (ISO_DATE_TIME_RE.test(raw)) return `${raw}Z`;
	return raw;
}
function parseAbsoluteTimeMs(input) {
	const raw = input.trim();
	if (!raw) return null;
	if (/^\d+$/.test(raw)) {
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0) return Math.floor(n);
	}
	const parsed = Date.parse(normalizeUtcIso(raw));
	return Number.isFinite(parsed) ? parsed : null;
}

//#endregion
//#region src/cron/stagger.ts
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 300 * 1e3;
function parseCronFields(expr) {
	return expr.trim().split(/\s+/).filter(Boolean);
}
function isRecurringTopOfHourCronExpr(expr) {
	const fields = parseCronFields(expr);
	if (fields.length === 5) {
		const [minuteField, hourField] = fields;
		return minuteField === "0" && hourField.includes("*");
	}
	if (fields.length === 6) {
		const [secondField, minuteField, hourField] = fields;
		return secondField === "0" && minuteField === "0" && hourField.includes("*");
	}
	return false;
}
function normalizeCronStaggerMs(raw) {
	const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
	if (!Number.isFinite(numeric)) return;
	return Math.max(0, Math.floor(numeric));
}
function resolveDefaultCronStaggerMs(expr) {
	return isRecurringTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : void 0;
}
function resolveCronStaggerMs(schedule) {
	const explicit = normalizeCronStaggerMs(schedule.staggerMs);
	if (explicit !== void 0) return explicit;
	const expr = schedule.expr;
	return resolveDefaultCronStaggerMs(typeof expr === "string" ? expr : "") ?? 0;
}

//#endregion
export { parseAbsoluteTimeMs as i, resolveCronStaggerMs as n, resolveDefaultCronStaggerMs as r, normalizeCronStaggerMs as t };