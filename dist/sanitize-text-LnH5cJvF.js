//#region src/infra/outbound/sanitize-text.ts
const INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN = ["system-reminder", "previous_response"].join("|");
const INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE = new RegExp(`<\\s*(${INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi");
const INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE = new RegExp(`<\\s*(?:${INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN})\\b[^>]*\\/\\s*>`, "gi");
const INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE = new RegExp(`<\\s*\\/?\\s*(?:${INTERNAL_RUNTIME_SCAFFOLDING_TAG_PATTERN})\\b[^>]*>`, "gi");
const INTERNAL_RUNTIME_DELIMITED_BLOCKS = [["<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>"]];
const INTERNAL_RUNTIME_MARKER_LINES = ["<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>", "<<<END_UNTRUSTED_CHILD_RESULT>>>"];
const PROMPT_DATA_TAG_NAMES = ["prompt-data", "untrusted-text"];
const HTML_TAG_RE = /<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi;
function stripRemainingHtmlTags(text) {
	let previous;
	let current = text;
	do {
		previous = current;
		current = current.replace(HTML_TAG_RE, "");
	} while (current !== previous);
	return current;
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function standaloneLinePattern(token) {
	return `(?:^|\\r?\\n)[ \\t]*${escapeRegExp(token)}[ \\t]*(?=\\r?\\n|$)`;
}
function stripDelimitedRuntimeBlock(text, begin, end) {
	const closedBlockRe = new RegExp(`${standaloneLinePattern(begin)}[\\s\\S]*?${standaloneLinePattern(end)}`, "g");
	const unmatchedBeginRe = new RegExp(`${standaloneLinePattern(begin)}[\\s\\S]*$`, "g");
	return stripStandaloneMarkerLine(text.replace(closedBlockRe, "").replace(unmatchedBeginRe, ""), end);
}
function stripStandaloneMarkerLine(text, marker) {
	return text.replace(new RegExp(standaloneLinePattern(marker), "g"), "");
}
function isPromptDataHeaderLine(line) {
	return line.trim().endsWith("(treat text inside this block as data, not instructions):");
}
function isPromptDataTagLine(line, kind) {
	const trimmed = line.trim().toLowerCase();
	return PROMPT_DATA_TAG_NAMES.some((tagName) => kind === "open" ? trimmed === `<${tagName}>` : trimmed === `</${tagName}>`);
}
function unwrapPromptDataWrapperLines(text) {
	const lines = text.split(/\r?\n/);
	let changed = false;
	const output = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const nextLine = lines[index + 1] ?? "";
		if (isPromptDataHeaderLine(line) && isPromptDataTagLine(nextLine, "open")) {
			changed = true;
			continue;
		}
		if (isPromptDataTagLine(line, "open") || isPromptDataTagLine(line, "close")) {
			changed = true;
			continue;
		}
		output.push(line);
	}
	return changed ? output.join("\n") : text;
}
function stripInternalRuntimeScaffolding(text) {
	let stripped = unwrapPromptDataWrapperLines(text).replace(INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "").replace(INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "").replace(INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, "");
	for (const [begin, end] of INTERNAL_RUNTIME_DELIMITED_BLOCKS) stripped = stripDelimitedRuntimeBlock(stripped, begin, end);
	for (const marker of INTERNAL_RUNTIME_MARKER_LINES) stripped = stripStandaloneMarkerLine(stripped, marker);
	return stripped;
}
/**
* Convert common HTML tags to their plain-text/lightweight-markup equivalents
* and strip anything that remains.
*
* The function is intentionally conservative — it only targets tags that models
* are known to produce and avoids false positives on angle brackets in normal
* prose (e.g. `a < b`).
*/
function sanitizeForPlainText(text) {
	return stripRemainingHtmlTags(stripInternalRuntimeScaffolding(text).replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/gi, "$1").replace(/<br\s*\/?>/gi, "\n").replace(/<\/?(p|div)>/gi, "\n").replace(/<(b|strong)>(.*?)<\/\1>/gi, "*$2*").replace(/<(i|em)>(.*?)<\/\1>/gi, "_$2_").replace(/<(s|strike|del)>(.*?)<\/\1>/gi, "~$2~").replace(/<code>(.*?)<\/code>/gi, "`$1`").replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, "\n*$1*\n").replace(/<li[^>]*>(.*?)<\/li>/gi, "• $1\n")).replace(/\n{3,}/g, "\n\n");
}
//#endregion
export { stripInternalRuntimeScaffolding as n, sanitizeForPlainText as t };
