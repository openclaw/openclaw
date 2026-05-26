import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { t as resolveAgentSessionDirs } from "./session-dirs-Dmxb0Dxh.js";
import { c as hasInternalRuntimeContext, u as stripInternalRuntimeContext } from "./internal-runtime-context-DWxvZFcB.js";
import { t as note } from "./note-Dg2Luaaq.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/commands/doctor-session-transcripts.ts
function parseTranscriptEntries(raw) {
	const entries = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed);
		} catch {
			return [];
		}
	}
	return entries;
}
function getEntryId(entry) {
	return typeof entry.id === "string" && entry.id.trim() ? entry.id : null;
}
function getParentId(entry) {
	return typeof entry.parentId === "string" && entry.parentId.trim() ? entry.parentId : null;
}
function getMessage(entry) {
	return entry.message && typeof entry.message === "object" && !Array.isArray(entry.message) ? entry.message : null;
}
function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return content.map((part) => part && typeof part === "object" && typeof part.text === "string" ? part.text : "").join("") || null;
}
function selectActivePath(entries) {
	const sessionEntries = entries.filter((entry) => entry.type !== "session");
	const leaf = sessionEntries.at(-1);
	const leafId = leaf ? getEntryId(leaf) : null;
	if (!leaf || !leafId) return null;
	const byId = /* @__PURE__ */ new Map();
	for (const entry of sessionEntries) {
		const id = getEntryId(entry);
		if (id) byId.set(id, entry);
	}
	const active = [];
	const seen = /* @__PURE__ */ new Set();
	let current = leaf;
	while (current) {
		const id = getEntryId(current);
		if (!id || seen.has(id)) return null;
		seen.add(id);
		active.unshift(current);
		const parentId = getParentId(current);
		current = parentId ? byId.get(parentId) : void 0;
	}
	return active;
}
function hasBrokenPromptRewriteBranch(entries, activePath) {
	const activeIds = new Set(activePath.map(getEntryId).filter((id) => Boolean(id)));
	const activeUserByParentAndText = /* @__PURE__ */ new Set();
	for (const entry of activePath) {
		const id = getEntryId(entry);
		const message = getMessage(entry);
		if (!id || message?.role !== "user") continue;
		const text = textFromContent(message.content);
		if (text !== null) activeUserByParentAndText.add(`${getParentId(entry) ?? ""}\0${text.trim()}`);
	}
	for (const entry of entries) {
		const id = getEntryId(entry);
		if (!id || activeIds.has(id)) continue;
		const message = getMessage(entry);
		if (message?.role !== "user") continue;
		const text = textFromContent(message.content);
		if (!text || !hasInternalRuntimeContext(text)) continue;
		const visibleText = stripInternalRuntimeContext(text).trim();
		if (visibleText && activeUserByParentAndText.has(`${getParentId(entry) ?? ""}\0${visibleText}`)) return true;
	}
	return false;
}
async function writeActiveTranscript(params) {
	const header = params.entries.find((entry) => entry.type === "session");
	if (!header) throw new Error("missing session header");
	const backupPath = `${params.filePath}.pre-doctor-branch-repair-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.bak`;
	await fs.copyFile(params.filePath, backupPath);
	const next = [header, ...params.activePath].map((entry) => JSON.stringify(entry)).join("\n");
	await fs.writeFile(params.filePath, `${next}\n`, "utf-8");
	return backupPath;
}
async function repairBrokenSessionTranscriptFile(params) {
	try {
		const entries = parseTranscriptEntries(await fs.readFile(params.filePath, "utf-8"));
		const activePath = selectActivePath(entries);
		if (!activePath) return {
			filePath: params.filePath,
			broken: false,
			repaired: false,
			originalEntries: entries.length,
			activeEntries: 0,
			reason: "no active branch"
		};
		if (!hasBrokenPromptRewriteBranch(entries, activePath)) return {
			filePath: params.filePath,
			broken: false,
			repaired: false,
			originalEntries: entries.length,
			activeEntries: activePath.length
		};
		if (!params.shouldRepair) return {
			filePath: params.filePath,
			broken: true,
			repaired: false,
			originalEntries: entries.length,
			activeEntries: activePath.length
		};
		const backupPath = await writeActiveTranscript({
			filePath: params.filePath,
			entries,
			activePath
		});
		return {
			filePath: params.filePath,
			broken: true,
			repaired: true,
			originalEntries: entries.length,
			activeEntries: activePath.length,
			backupPath
		};
	} catch (err) {
		return {
			filePath: params.filePath,
			broken: false,
			repaired: false,
			originalEntries: 0,
			activeEntries: 0,
			reason: String(err)
		};
	}
}
async function listSessionTranscriptFiles(sessionDirs) {
	const files = [];
	for (const sessionsDir of sessionDirs) {
		let entries = [];
		try {
			entries = await fs.readdir(sessionsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(sessionsDir, entry.name));
	}
	return files.toSorted((a, b) => a.localeCompare(b));
}
async function noteSessionTranscriptHealth(params) {
	const shouldRepair = params?.shouldRepair === true;
	let sessionDirs = params?.sessionDirs;
	try {
		sessionDirs ??= await resolveAgentSessionDirs(resolveStateDir(process.env));
	} catch (err) {
		note(`- Failed to inspect session transcripts: ${String(err)}`, "Session transcripts");
		return;
	}
	const files = await listSessionTranscriptFiles(sessionDirs);
	if (files.length === 0) return;
	const results = [];
	for (const filePath of files) results.push(await repairBrokenSessionTranscriptFile({
		filePath,
		shouldRepair
	}));
	const broken = results.filter((result) => result.broken);
	if (broken.length === 0) return;
	const repairedCount = broken.filter((result) => result.repaired).length;
	const lines = [`- Found ${broken.length} transcript file${broken.length === 1 ? "" : "s"} with duplicated prompt-rewrite branches.`, ...broken.slice(0, 20).map((result) => {
		const backup = result.backupPath ? ` backup=${shortenHomePath(result.backupPath)}` : "";
		const status = result.repaired ? "repaired" : "needs repair";
		return `- ${shortenHomePath(result.filePath)} ${status} entries=${result.originalEntries}->${result.activeEntries + 1}${backup}`;
	})];
	if (broken.length > 20) lines.push(`- ...and ${broken.length - 20} more.`);
	if (!shouldRepair) lines.push("- Run \"openclaw doctor --fix\" to rewrite affected files to their active branch.");
	else if (repairedCount > 0) lines.push(`- Repaired ${repairedCount} transcript file${repairedCount === 1 ? "" : "s"}.`);
	note(lines.join("\n"), "Session transcripts");
}
//#endregion
export { noteSessionTranscriptHealth };
