import "./redact-R2-EdHUS.js";
import "./errors-VfATXfah.js";
import "./fs-safe-defaults-DsMJI6H_.js";
import "./fs-safe-DKdSS9ZL.js";
import { o as root } from "./secure-temp-dir-DP1EBfnW.js";
import "./path-guards-BiHQR6P-.js";
import "./replace-file-CPhhiRlN.js";
import "./fs-safe-advanced-BkM6Q-b8.js";
import "./private-file-store-BeCnJMlm.js";
import "./shared-D5MPvqgq.js";
import "./ports-r7ECRIFA.js";
import "./secure-random-BGeK471x.js";
import "./ssrf-COOL9as_.js";
import "./sibling-temp-file-lxzBazPz.js";
import "./runtime-shared-CCpEv4dS.js";
import { i as wrapExternalContent } from "./external-content-BDrXhlS4.js";
import "./channel-access-compat-CxLuLEz_.js";
import "./channel-secret-collector-runtime-Bbf1qbH2.js";
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
