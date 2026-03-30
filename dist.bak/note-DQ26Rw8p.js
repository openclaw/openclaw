import { g as visibleWidth } from "./entry.js";
import { r as stylePromptTitle } from "./prompt-style-wsroINzm.js";
import { note } from "@clack/prompts";

//#region src/terminal/note.ts
const URL_PREFIX_RE = /^(https?:\/\/|file:\/\/)/i;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const FILE_LIKE_RE = /^[a-zA-Z0-9._-]+$/;
function splitLongWord(word, maxLen) {
	if (maxLen <= 0) return [word];
	const chars = Array.from(word);
	const parts = [];
	for (let i = 0; i < chars.length; i += maxLen) parts.push(chars.slice(i, i + maxLen).join(""));
	return parts.length > 0 ? parts : [word];
}
function isCopySensitiveToken(word) {
	if (!word) return false;
	if (URL_PREFIX_RE.test(word)) return true;
	if (word.startsWith("/") || word.startsWith("~/") || word.startsWith("./") || word.startsWith("../")) return true;
	if (WINDOWS_DRIVE_RE.test(word) || word.startsWith("\\\\")) return true;
	if (word.includes("/") || word.includes("\\")) return true;
	return word.includes("_") && FILE_LIKE_RE.test(word);
}
function wrapLine(line, maxWidth) {
	if (line.trim().length === 0) return [line];
	const match = line.match(/^(\s*)([-*\u2022]\s+)?(.*)$/);
	const indent = match?.[1] ?? "";
	const bullet = match?.[2] ?? "";
	const content = match?.[3] ?? "";
	const firstPrefix = `${indent}${bullet}`;
	const nextPrefix = `${indent}${bullet ? " ".repeat(bullet.length) : ""}`;
	const firstWidth = Math.max(10, maxWidth - visibleWidth(firstPrefix));
	const nextWidth = Math.max(10, maxWidth - visibleWidth(nextPrefix));
	const words = content.split(/\s+/).filter(Boolean);
	const lines = [];
	let current = "";
	let prefix = firstPrefix;
	let available = firstWidth;
	for (const word of words) {
		if (!current) {
			if (visibleWidth(word) > available) {
				if (isCopySensitiveToken(word)) {
					current = word;
					continue;
				}
				const parts = splitLongWord(word, available);
				const first = parts.shift() ?? "";
				lines.push(prefix + first);
				prefix = nextPrefix;
				available = nextWidth;
				for (const part of parts) lines.push(prefix + part);
				continue;
			}
			current = word;
			continue;
		}
		const candidate = `${current} ${word}`;
		if (visibleWidth(candidate) <= available) {
			current = candidate;
			continue;
		}
		lines.push(prefix + current);
		prefix = nextPrefix;
		available = nextWidth;
		if (visibleWidth(word) > available) {
			if (isCopySensitiveToken(word)) {
				current = word;
				continue;
			}
			const parts = splitLongWord(word, available);
			const first = parts.shift() ?? "";
			lines.push(prefix + first);
			for (const part of parts) lines.push(prefix + part);
			current = "";
			continue;
		}
		current = word;
	}
	if (current || words.length === 0) lines.push(prefix + current);
	return lines;
}
function wrapNoteMessage(message, options = {}) {
	const columns = options.columns ?? process.stdout.columns ?? 80;
	const maxWidth = options.maxWidth ?? Math.max(40, Math.min(88, columns - 10));
	return message.split("\n").flatMap((line) => wrapLine(line, maxWidth)).join("\n");
}
function note$1(message, title) {
	note(wrapNoteMessage(message), stylePromptTitle(title));
}

//#endregion
export { note$1 as t };