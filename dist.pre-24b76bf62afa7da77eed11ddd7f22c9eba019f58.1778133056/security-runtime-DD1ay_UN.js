import "./redact-1fZUZMlV.js";
import "./errors-QN8rySzW.js";
import "./shared-BwAOXrhs.js";
import "./fs-safe-BPY-vj85.js";
import "./ports-BzU2NVSf.js";
import "./ssrf-Cmvw-sAq.js";
import "./secure-random-DJM7QqXq.js";
import "./runtime-shared-CWEV2cku.js";
import { i as wrapExternalContent } from "./external-content-DKfTMdkw.js";
import "./dm-policy-shared-C7MlRVkr.js";
import "./channel-secret-collector-runtime-C8Cn45zI.js";
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
