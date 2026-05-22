import "./redact-Ey2piJyN.js";
import "./errors-D4wGeA6B.js";
import "./fs-safe-defaults-B7hUN42l.js";
import "./fs-safe-BIhMf0UI.js";
import { o as root } from "./secure-temp-dir-BA4Qt7HV.js";
import "./path-guards-CBe_wA_B.js";
import "./replace-file-Dr-OmBmA.js";
import "./fs-safe-advanced-CBe_wA_B.js";
import "./private-file-store-Dbf8cmWU.js";
import "./shared-_7y6LAJm.js";
import "./ports-CSHlVhz0.js";
import "./secure-random-B-x2FMyg.js";
import "./ssrf-DdDeGa5L.js";
import "./sibling-temp-file-CBe_wA_B.js";
import "./runtime-shared-C4pL6nSH.js";
import { i as wrapExternalContent } from "./external-content-BWPoz0BU.js";
import "./channel-access-compat-CcRkK0fg.js";
import "./channel-secret-collector-runtime-OKrLFeXT.js";
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
