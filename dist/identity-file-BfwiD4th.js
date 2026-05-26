import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as DEFAULT_IDENTITY_FILENAME } from "./workspace-DTx8zuCN.js";
import fs from "node:fs";
import path from "node:path";
//#region src/agents/identity-file.ts
const WRITABLE_IDENTITY_FIELDS = [
	["name", "Name"],
	["theme", "Theme"],
	["emoji", "Emoji"],
	["avatar", "Avatar"]
];
const RICH_IDENTITY_LABELS = new Set([
	"name",
	"creature",
	"vibe",
	"theme",
	"emoji",
	"avatar"
]);
const IDENTITY_PLACEHOLDER_VALUES = new Set([
	"pick something you like",
	"ai? robot? familiar? ghost in the machine? something weirder?",
	"how do you come across? sharp? warm? chaotic? calm?",
	"your signature - pick one that feels right",
	"workspace-relative path, http(s) url, or data uri"
]);
function normalizeIdentityValue(value) {
	let normalized = value.trim();
	normalized = normalized.replace(/^[*_]+|[*_]+$/g, "").trim();
	if (normalized.startsWith("(") && normalized.endsWith(")")) normalized = normalized.slice(1, -1).trim();
	normalized = normalized.replace(/[\u2013\u2014]/g, "-");
	return normalizeLowercaseStringOrEmpty(normalized.replace(/\s+/g, " "));
}
function isIdentityPlaceholder(value) {
	const normalized = normalizeIdentityValue(value);
	return IDENTITY_PLACEHOLDER_VALUES.has(normalized);
}
function parseIdentityMarkdown(content) {
	const identity = {};
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		const cleaned = line.trim().replace(/^\s*-\s*/, "");
		const colonIndex = cleaned.indexOf(":");
		if (colonIndex === -1) continue;
		const label = normalizeLowercaseStringOrEmpty(cleaned.slice(0, colonIndex).replace(/[*_]/g, ""));
		const value = cleaned.slice(colonIndex + 1).replace(/^[*_]+|[*_]+$/g, "").trim();
		if (!value) continue;
		if (isIdentityPlaceholder(value)) continue;
		if (label === "name") identity.name = value;
		if (label === "emoji") identity.emoji = value;
		if (label === "creature") identity.creature = value;
		if (label === "vibe") identity.vibe = value;
		if (label === "theme") identity.theme = value;
		if (label === "avatar") identity.avatar = value;
	}
	return identity;
}
function identityHasValues(identity) {
	return Boolean(identity.name || identity.emoji || identity.theme || identity.creature || identity.vibe || identity.avatar);
}
function buildIdentityLine(label, value) {
	return `- ${label}: ${value}`;
}
function matchesIdentityLabel(line, label) {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^\\s*-\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*:`, "i").test(line.trim());
}
function normalizeIdentityContent(content) {
	if (!content) return [];
	return content.replace(/\r\n/g, "\n").split("\n");
}
function resolveIdentityInsertIndex(lines) {
	let lastIdentityIndex = -1;
	for (const [index, line] of lines.entries()) {
		const cleaned = line.trim().replace(/^\s*-\s*/, "");
		const colonIndex = cleaned.indexOf(":");
		if (colonIndex === -1) continue;
		const label = normalizeLowercaseStringOrEmpty(cleaned.slice(0, colonIndex).replace(/[*_]/g, ""));
		if (RICH_IDENTITY_LABELS.has(label)) lastIdentityIndex = index;
	}
	if (lastIdentityIndex >= 0) return lastIdentityIndex + 1;
	const headingIndex = lines.findIndex((line) => line.trim().startsWith("#"));
	if (headingIndex === -1) return 0;
	let insertIndex = headingIndex + 1;
	while (insertIndex < lines.length && lines[insertIndex]?.trim() === "") insertIndex += 1;
	return insertIndex;
}
function mergeIdentityMarkdownContent(content, identity) {
	const lines = normalizeIdentityContent(content);
	const nextLines = lines.length > 0 ? [...lines] : ["# IDENTITY.md - Agent Identity", ""];
	for (const [field, label] of WRITABLE_IDENTITY_FIELDS) {
		const value = identity[field]?.trim();
		if (!value) continue;
		const matchingIndexes = nextLines.reduce((indexes, line, index) => {
			if (matchesIdentityLabel(line, label)) indexes.push(index);
			return indexes;
		}, []);
		if (matchingIndexes.length > 0) {
			const [firstIndex, ...duplicateIndexes] = matchingIndexes;
			nextLines[firstIndex] = buildIdentityLine(label, value);
			for (const duplicateIndex of duplicateIndexes.toReversed()) nextLines.splice(duplicateIndex, 1);
			continue;
		}
		const insertIndex = resolveIdentityInsertIndex(nextLines);
		nextLines.splice(insertIndex, 0, buildIdentityLine(label, value));
	}
	return nextLines.join("\n").replace(/\n*$/, "\n");
}
function loadIdentityFromFile(identityPath) {
	try {
		const parsed = parseIdentityMarkdown(fs.readFileSync(identityPath, "utf-8"));
		if (!identityHasValues(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}
function loadAgentIdentityFromWorkspace(workspace) {
	return loadIdentityFromFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME));
}
//#endregion
export { parseIdentityMarkdown as i, loadAgentIdentityFromWorkspace as n, mergeIdentityMarkdownContent as r, identityHasValues as t };
