import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import "./text-runtime-CFBwIeh_.js";
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
export { resolveSlackThreadTsValue as n, normalizeSlackThreadTsCandidate as t };
