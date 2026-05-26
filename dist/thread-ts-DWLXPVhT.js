import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-Ce59bOpy.js";
//#region extensions/slack/src/truncate.ts
function truncateSlackText(value, max) {
	const trimmed = value.trim();
	if (trimmed.length <= max) return trimmed;
	if (max <= 1) return trimmed.slice(0, max);
	return `${trimmed.slice(0, max - 1)}…`;
}
//#endregion
//#region extensions/slack/src/limits.ts
const SLACK_TEXT_LIMIT = 8e3;
//#endregion
//#region extensions/slack/src/thread-ts.ts
const SLACK_THREAD_TS_PATTERN = /^\d+\.\d+$/;
function normalizeSlackThreadTsCandidate(value) {
	if (typeof value !== "string") return;
	const normalized = normalizeOptionalString(value);
	return normalized && SLACK_THREAD_TS_PATTERN.test(normalized) ? normalized : void 0;
}
function resolveSlackThreadTsValue(params) {
	return normalizeSlackThreadTsCandidate(params.replyToId) ?? normalizeSlackThreadTsCandidate(params.threadId);
}
//#endregion
export { truncateSlackText as i, resolveSlackThreadTsValue as n, SLACK_TEXT_LIMIT as r, normalizeSlackThreadTsCandidate as t };
