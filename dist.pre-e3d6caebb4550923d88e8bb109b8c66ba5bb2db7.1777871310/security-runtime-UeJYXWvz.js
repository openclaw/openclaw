import "./redact-1fZUZMlV.js";
import "./errors-QN8rySzW.js";
import "./shared-C1xGX3xe.js";
import "./fs-safe-B3pr-X7V.js";
import "./ports-CqSt8m0s.js";
import "./ssrf-BUVRrita.js";
import "./secure-random-CGoq01ar.js";
import "./runtime-shared-CofDEvbN.js";
import { i as wrapExternalContent } from "./external-content-DyTL3ggw.js";
import "./dm-policy-shared-DAgHnxNz.js";
import "./channel-secret-collector-runtime-CWzBYGoV.js";
//#region src/security/channel-metadata.ts
const DEFAULT_MAX_CHARS = 800;
const DEFAULT_MAX_ENTRY_CHARS = 400;
function normalizeEntry(entry) {
	return entry.replace(/\s+/g, " ").trim();
}
function truncateText(value, maxChars) {
	if (maxChars <= 0) return "";
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function buildUntrustedChannelMetadata(params) {
	const deduped = params.entries.map((entry) => typeof entry === "string" ? normalizeEntry(entry) : "").filter((entry) => Boolean(entry)).map((entry) => truncateText(entry, DEFAULT_MAX_ENTRY_CHARS)).filter((entry, index, list) => list.indexOf(entry) === index);
	if (deduped.length === 0) return;
	const body = deduped.join("\n");
	return wrapExternalContent(truncateText(`${`UNTRUSTED channel metadata (${params.source})`}\n${`${params.label}:\n${body}`}`, params.maxChars ?? DEFAULT_MAX_CHARS), {
		source: "channel_metadata",
		includeWarning: false
	});
}
//#endregion
export { buildUntrustedChannelMetadata as t };
