import { x as DEFAULT_IDENTITY_FILENAME } from "./agent-scope-tkfLX5MZ.js";
import fs from "node:fs";
import path from "node:path";
//#region src/config/bindings.ts
function normalizeBindingType(binding) {
	return binding.type === "acp" ? "acp" : "route";
}
function isRouteBinding(binding) {
	return normalizeBindingType(binding) === "route";
}
function isAcpBinding(binding) {
	return normalizeBindingType(binding) === "acp";
}
function listConfiguredBindings(cfg) {
	return Array.isArray(cfg.bindings) ? cfg.bindings : [];
}
function listRouteBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isRouteBinding);
}
function listAcpBindings(cfg) {
	return listConfiguredBindings(cfg).filter(isAcpBinding);
}
//#endregion
//#region src/agents/identity-file.ts
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
	if (normalized.startsWith("(") && normalized.endsWith(")")) {normalized = normalized.slice(1, -1).trim();}
	normalized = normalized.replace(/[\u2013\u2014]/g, "-");
	normalized = normalized.replace(/\s+/g, " ").toLowerCase();
	return normalized;
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
		if (colonIndex === -1) {continue;}
		const label = cleaned.slice(0, colonIndex).replace(/[*_]/g, "").trim().toLowerCase();
		const value = cleaned.slice(colonIndex + 1).replace(/^[*_]+|[*_]+$/g, "").trim();
		if (!value) {continue;}
		if (isIdentityPlaceholder(value)) {continue;}
		if (label === "name") {identity.name = value;}
		if (label === "emoji") {identity.emoji = value;}
		if (label === "creature") {identity.creature = value;}
		if (label === "vibe") {identity.vibe = value;}
		if (label === "theme") {identity.theme = value;}
		if (label === "avatar") {identity.avatar = value;}
	}
	return identity;
}
function identityHasValues(identity) {
	return Boolean(identity.name || identity.emoji || identity.theme || identity.creature || identity.vibe || identity.avatar);
}
function loadIdentityFromFile(identityPath) {
	try {
		const parsed = parseIdentityMarkdown(fs.readFileSync(identityPath, "utf-8"));
		if (!identityHasValues(parsed)) {return null;}
		return parsed;
	} catch {
		return null;
	}
}
function loadAgentIdentityFromWorkspace(workspace) {
	return loadIdentityFromFile(path.join(workspace, DEFAULT_IDENTITY_FILENAME));
}
//#endregion
export { listAcpBindings as a, isRouteBinding as i, loadAgentIdentityFromWorkspace as n, listRouteBindings as o, parseIdentityMarkdown as r, identityHasValues as t };
