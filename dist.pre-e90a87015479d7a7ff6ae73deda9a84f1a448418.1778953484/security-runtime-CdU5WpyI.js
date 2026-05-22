import "./redact-CwdxH-4-.js";
import "./errors-C5Jbj3g5.js";
import "./fs-safe-defaults-azXCfv92.js";
import "./fs-safe-D4r8mUJk.js";
import { o as root } from "./secure-temp-dir-GC3bO7Qi.js";
import "./path-guards-DOGmBasP.js";
import "./replace-file-VPhXrtU-.js";
import "./fs-safe-advanced-cB4aSVpW.js";
import "./private-file-store-BFBFreLV.js";
import "./shared-tw4u3htx.js";
import "./ports-DMSLpyND.js";
import "./secure-random-DgXBJL-N.js";
import "./ssrf-CxdudCgU.js";
import "./sibling-temp-file-BDIZsl3U.js";
import "./runtime-shared-CYkloN98.js";
import { i as wrapExternalContent } from "./external-content-Dab4C3Qy.js";
import "./channel-access-compat-Boj7vJNT.js";
import "./channel-secret-collector-runtime-CWhR1tAT.js";
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
