import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { r as openRootFile } from "./root-file-CqMcFM3J.js";
import "./agent-scope-EKUvJ3MC.js";
import { i as resolveAgentContextLimits } from "./agent-scope-config-BdqZvTnb.js";
import "./boundary-file-read-wgc2vgUM.js";
import { i as resolveUserTimezone } from "./date-time-OFfXKzFY.js";
import { n as resolveCronStyleNow } from "./current-time-CSyA_Rn7.js";
import fs from "node:fs";
import path from "node:path";
//#region src/auto-reply/reply/post-compaction-context.ts
const MAX_CONTEXT_CHARS = 1800;
const DEFAULT_POST_COMPACTION_SECTIONS = ["Session Startup", "Red Lines"];
const LEGACY_POST_COMPACTION_SECTIONS = ["Every Session", "Safety"];
function matchesSectionSet(sectionNames, expectedSections) {
	if (sectionNames.length !== expectedSections.length) return false;
	const counts = /* @__PURE__ */ new Map();
	for (const name of expectedSections) {
		const normalized = normalizeLowercaseStringOrEmpty(name);
		counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
	}
	for (const name of sectionNames) {
		const normalized = normalizeLowercaseStringOrEmpty(name);
		const count = counts.get(normalized);
		if (!count) return false;
		if (count === 1) counts.delete(normalized);
		else counts.set(normalized, count - 1);
	}
	return counts.size === 0;
}
function formatDateStamp(nowMs, timezone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(new Date(nowMs));
	const year = parts.find((p) => p.type === "year")?.value;
	const month = parts.find((p) => p.type === "month")?.value;
	const day = parts.find((p) => p.type === "day")?.value;
	if (year && month && day) return `${year}-${month}-${day}`;
	return new Date(nowMs).toISOString().slice(0, 10);
}
async function readPostCompactionContext(workspaceDir, options) {
	const cfg = options?.cfg;
	const agentId = options?.agentId;
	const effectiveNowMs = options?.nowMs;
	const agentsPath = path.join(workspaceDir, "AGENTS.md");
	try {
		const opened = await openRootFile({
			absolutePath: agentsPath,
			rootPath: workspaceDir,
			boundaryLabel: "workspace root"
		});
		if (!opened.ok) return null;
		const content = (() => {
			try {
				return fs.readFileSync(opened.fd, "utf-8");
			} finally {
				fs.closeSync(opened.fd);
			}
		})();
		const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
		const sectionNames = Array.isArray(configuredSections) ? configuredSections : DEFAULT_POST_COMPACTION_SECTIONS;
		if (sectionNames.length === 0) return null;
		const foundSectionNames = [];
		let sections = extractSections(content, sectionNames, foundSectionNames);
		const isDefaultSections = !Array.isArray(configuredSections) || matchesSectionSet(configuredSections, DEFAULT_POST_COMPACTION_SECTIONS);
		if (sections.length === 0 && isDefaultSections) sections = extractSections(content, LEGACY_POST_COMPACTION_SECTIONS, foundSectionNames);
		if (sections.length === 0) return null;
		const displayNames = foundSectionNames.length > 0 ? foundSectionNames : sectionNames;
		const resolvedNowMs = effectiveNowMs ?? Date.now();
		const dateStamp = formatDateStamp(resolvedNowMs, resolveUserTimezone(cfg?.agents?.defaults?.userTimezone));
		const maxContextChars = resolveAgentContextLimits(cfg, agentId)?.postCompactionMaxChars ?? MAX_CONTEXT_CHARS;
		const { timeLine } = resolveCronStyleNow(cfg ?? {}, resolvedNowMs);
		const combined = sections.join("\n\n").replaceAll("YYYY-MM-DD", dateStamp);
		const safeContent = combined.length > maxContextChars ? combined.slice(0, maxContextChars) + "\n...[truncated]..." : combined;
		return `[Post-compaction context refresh]

${isDefaultSections ? "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence. Run your Session Startup sequence - read the required files before responding to the user." : `Session was just compacted. The conversation summary above is a hint, NOT a substitute for your full startup sequence. Re-read the sections injected below (${displayNames.join(", ")}) and follow your configured startup procedure before responding to the user.`}\n\n${isDefaultSections ? "Critical rules from AGENTS.md:" : `Injected sections from AGENTS.md (${displayNames.join(", ")}):`}\n\n${safeContent}\n\n${timeLine}`;
	} catch {
		return null;
	}
}
/**
* Extract named sections from markdown content.
* Matches H2 (##) or H3 (###) headings case-insensitively.
* Skips content inside fenced code blocks.
* Captures until the next heading of same or higher level, or end of string.
*/
function extractSections(content, sectionNames, foundNames) {
	const results = [];
	const lines = content.split("\n");
	for (const name of sectionNames) {
		let sectionLines = [];
		let inSection = false;
		let sectionLevel = 0;
		let inCodeBlock = false;
		for (const line of lines) {
			if (line.trimStart().startsWith("```")) {
				inCodeBlock = !inCodeBlock;
				if (inSection) sectionLines.push(line);
				continue;
			}
			if (inCodeBlock) {
				if (inSection) sectionLines.push(line);
				continue;
			}
			const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);
			if (headingMatch) {
				const level = headingMatch[1].length;
				const headingText = headingMatch[2];
				if (!inSection) {
					if (normalizeLowercaseStringOrEmpty(headingText) === normalizeLowercaseStringOrEmpty(name)) {
						inSection = true;
						sectionLevel = level;
						sectionLines = [line];
						continue;
					}
				} else {
					if (level <= sectionLevel) break;
					sectionLines.push(line);
					continue;
				}
			}
			if (inSection) sectionLines.push(line);
		}
		if (sectionLines.length > 0) {
			results.push(sectionLines.join("\n").trim());
			foundNames?.push(name);
		}
	}
	return results;
}
//#endregion
export { readPostCompactionContext as n, extractSections as t };
