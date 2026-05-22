import "./redact-CxqQQvmK.js";
import "./errors-ixwfrboQ.js";
import "./fs-safe-defaults-azXCfv92.js";
import "./fs-safe-D4r8mUJk.js";
import { o as root } from "./secure-temp-dir-GC3bO7Qi.js";
import "./path-guards-BptIujoz.js";
import "./replace-file-DfT5iHv1.js";
import "./fs-safe-advanced-BQymc1Ql.js";
import "./private-file-store-9NwvLNnb.js";
import "./shared-DlgDffIw.js";
import "./ports-pCrEY5_r.js";
import "./secure-random-B3BCLMBL.js";
import "./ssrf-lzTNq2GU.js";
import "./sibling-temp-file-CEO-rO9d.js";
import "./runtime-shared-CqL3furi.js";
import { i as wrapExternalContent } from "./external-content-CjyYcKYs.js";
import "./channel-access-compat-CbVs_A5Z.js";
import "./channel-secret-collector-runtime-BU6jbb5N.js";
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
//#region src/plugin-sdk/security-runtime.ts
/**
* @deprecated Broad public SDK barrel. Prefer focused security/SSRF/secret
* subpaths and avoid adding new imports here.
*/
async function openFileWithinRoot(params) {
	return await (await root(params.rootDir)).open(params.relativePath, {
		hardlinks: params.rejectHardlinks === false ? "allow" : "reject",
		nonBlockingRead: params.nonBlockingRead,
		symlinks: params.allowSymlinkTargetWithinRoot === true ? "follow-within-root" : "reject"
	});
}
async function writeFileFromPathWithinRoot(params) {
	await (await root(params.rootDir)).copyIn(params.relativePath, params.sourcePath, {
		mkdir: params.mkdir,
		sourceHardlinks: "reject"
	});
}
//#endregion
export { writeFileFromPathWithinRoot as n, buildUntrustedChannelMetadata as r, openFileWithinRoot as t };
