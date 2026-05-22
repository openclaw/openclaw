import "./redact-BWh2xM0E.js";
import "./errors-D0hgXIu9.js";
import "./fs-safe-defaults-PMwkNo6J.js";
import "./fs-safe-Cwlcdma7.js";
import { o as root } from "./secure-temp-dir-JZ25IoOE.js";
import "./path-guards-DzWLExYo.js";
import "./replace-file-BFpDvZ2t.js";
import "./fs-safe-advanced-CHqIq_-e.js";
import "./private-file-store-CLeDfR27.js";
import "./shared-ClIYHag2.js";
import "./ports-Du8hP9h1.js";
import "./ssrf-DX8ajhwl.js";
import "./sibling-temp-file-DaUzRf94.js";
import "./runtime-shared-xmdBHXi2.js";
import { i as wrapExternalContent } from "./external-content-CJBVNNkq.js";
import "./dm-policy-shared-CLOIwDKb.js";
import "./channel-secret-collector-runtime-0alWa-1i.js";
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
