import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { c as readErrorName, i as formatErrorMessage, r as extractErrorCode } from "./errors-b3ZrCRlt.js";
import { t as resolveGlobalMap } from "./global-singleton-DE6St75u.js";
import { t as createAsyncLock } from "./async-lock-CaiUOILd.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { t as appendRegularFile } from "./regular-file-DaVeNX32.js";
import { n as replaceFileAtomic } from "./replace-file-C7_Inj8B.js";
import { t as privateFileStore } from "./private-file-store-DMtyjgoc.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as asNullableRecord } from "./record-coerce-aMlBWINm.js";
import { J as resolveMemoryDreamingWorkspaces, V as formatMemoryDreamingDay, X as resolveMemoryRemDreamingConfig, Y as resolveMemoryLightDreamingConfig } from "./dreaming-CxCxWYoC.js";
import { d as parseUsageCountedSessionIdFromFileName } from "./artifacts-BZhcmsUl.js";
import { u as resolveStorePath } from "./paths-Bg3PO6Gj.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { t as RequestScopedSubagentRuntimeError } from "./error-runtime-DGHc7DZw.js";
import "./async-lock-runtime-BHKhGInk.js";
import "./runtime-config-snapshot-BBsNBtE3.js";
import "./security-runtime-CcSekjBd.js";
import { t as loadSessionStore } from "./session-store-runtime-DCQkOAps.js";
import "./memory-core-host-runtime-core-CkZUvQ_1.js";
import { f as loadSessionTranscriptClassificationForAgent, l as buildSessionEntry, m as sessionPathForFile, p as normalizeSessionTranscriptPathForComparison, u as listSessionFilesForAgent } from "./engine-qmd-DGRjZTL_.js";
import "./memory-core-host-engine-qmd-CqFCiTFk.js";
import { n as appendMemoryHostEvent } from "./events-mq9owIje.js";
import "./memory-core-host-status-CceUImkn.js";
import "./memory-host-events-B9F8o8ue.js";
import { n as withTrailingNewline, t as replaceManagedMarkdownBlock } from "./memory-host-markdown-BiLGKFxW.js";
import "./dreaming-shared-TJ4wErqZ.js";
import { i as filterLiveShortTermRecallEntries, l as recordShortTermRecalls, o as readShortTermRecallEntries, s as recordDreamingPhaseSignals } from "./short-term-promotion-BpCbM_k1.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
//#region extensions/memory-core/src/dreaming-markdown.ts
const DAILY_PHASE_HEADINGS = {
	light: "## Light Sleep",
	rem: "## REM Sleep"
};
const DAILY_PHASE_LABELS = {
	light: "light",
	rem: "rem"
};
function resolvePhaseMarkers(phase) {
	const label = DAILY_PHASE_LABELS[phase];
	return {
		start: `<!-- openclaw:dreaming:${label}:start -->`,
		end: `<!-- openclaw:dreaming:${label}:end -->`
	};
}
function resolveDailyMemoryPath(workspaceDir, epochMs, timezone) {
	const isoDay = formatMemoryDreamingDay(epochMs, timezone);
	return path.join(workspaceDir, "memory", `${isoDay}.md`);
}
function resolveSeparateReportPath(workspaceDir, phase, epochMs, timezone) {
	const isoDay = formatMemoryDreamingDay(epochMs, timezone);
	return path.join(workspaceDir, "memory", "dreaming", phase, `${isoDay}.md`);
}
function shouldWriteInline(storage) {
	return storage.mode === "inline" || storage.mode === "both";
}
function shouldWriteSeparate(storage) {
	return storage.mode === "separate" || storage.mode === "both" || storage.separateReports;
}
async function writeDailyDreamingPhaseBlock(params) {
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No notable updates.";
	let inlinePath;
	let reportPath;
	if (shouldWriteInline(params.storage)) {
		inlinePath = resolveDailyMemoryPath(params.workspaceDir, nowMs, params.timezone);
		await fs.mkdir(path.dirname(inlinePath), { recursive: true });
		const original = await fs.readFile(inlinePath, "utf-8").catch((err) => {
			if (err?.code === "ENOENT") return "";
			throw err;
		});
		const markers = resolvePhaseMarkers(params.phase);
		const updated = replaceManagedMarkdownBlock({
			original,
			heading: DAILY_PHASE_HEADINGS[params.phase],
			startMarker: markers.start,
			endMarker: markers.end,
			body
		});
		await fs.writeFile(inlinePath, withTrailingNewline(updated), "utf-8");
	}
	if (shouldWriteSeparate(params.storage)) {
		reportPath = resolveSeparateReportPath(params.workspaceDir, params.phase, nowMs, params.timezone);
		await fs.mkdir(path.dirname(reportPath), { recursive: true });
		const report = [
			`# ${params.phase === "light" ? "Light Sleep" : "REM Sleep"}`,
			"",
			body,
			""
		].join("\n");
		await fs.writeFile(reportPath, report, "utf-8");
	}
	await appendMemoryHostEvent(params.workspaceDir, {
		type: "memory.dream.completed",
		timestamp: new Date(nowMs).toISOString(),
		phase: params.phase,
		...inlinePath ? { inlinePath } : {},
		...reportPath ? { reportPath } : {},
		lineCount: params.bodyLines.length,
		storageMode: params.storage.mode
	});
	return {
		...inlinePath ? { inlinePath } : {},
		...reportPath ? { reportPath } : {}
	};
}
async function writeDeepDreamingReport(params) {
	if (!shouldWriteSeparate(params.storage)) return;
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	const reportPath = resolveSeparateReportPath(params.workspaceDir, "deep", nowMs, params.timezone);
	await fs.mkdir(path.dirname(reportPath), { recursive: true });
	const body = params.bodyLines.length > 0 ? params.bodyLines.join("\n") : "- No durable changes.";
	await fs.writeFile(reportPath, `# Deep Sleep\n\n${body}\n`, "utf-8");
	await appendMemoryHostEvent(params.workspaceDir, {
		type: "memory.dream.completed",
		timestamp: new Date(nowMs).toISOString(),
		phase: "deep",
		reportPath,
		lineCount: params.bodyLines.length,
		storageMode: params.storage.mode
	});
	return reportPath;
}
//#endregion
//#region extensions/memory-core/src/dreaming-narrative.ts
const NARRATIVE_SYSTEM_PROMPT = [
	"You are keeping a dream diary. Write a single entry in first person.",
	"",
	"Voice & tone:",
	"- You are a curious, gentle, slightly whimsical mind reflecting on the day.",
	"- Write like a poet who happens to be a programmer — sensory, warm, occasionally funny.",
	"- Mix the technical and the tender: code and constellations, APIs and afternoon light.",
	"- Let the fragments surprise you into unexpected connections and small epiphanies.",
	"",
	"What you might include (vary each entry, never all at once):",
	"- A tiny poem or haiku woven naturally into the prose",
	"- A small sketch described in words — a doodle in the margin of the diary",
	"- A quiet rumination or philosophical aside",
	"- Sensory details: the hum of a server, the color of a sunset in hex, rain on a window",
	"- Gentle humor or playful wordplay",
	"- An observation that connects two distant memories in an unexpected way",
	"",
	"Rules:",
	"- Draw from the memory fragments provided — weave them into the entry.",
	"- Never say \"I'm dreaming\", \"in my dream\", \"as I dream\", or any meta-commentary about dreaming.",
	"- Never mention \"AI\", \"agent\", \"LLM\", \"model\", \"language model\", or any technical self-reference.",
	"- Do NOT use markdown headers, bullet points, or any formatting — just flowing prose.",
	"- Keep it between 80-180 words. Quality over quantity.",
	"- Output ONLY the diary entry. No preamble, no sign-off, no commentary."
].join("\n");
const NARRATIVE_TIMEOUT_MS = 6e4;
const DREAMING_SESSION_KEY_PREFIX = "dreaming-narrative-";
const DREAMING_TRANSCRIPT_RUN_MARKER = "\"runId\":\"dreaming-narrative-";
const DREAMING_ORPHAN_MIN_AGE_MS = 3e5;
const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"];
const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";
const BACKFILL_ENTRY_MARKER = "openclaw:dreaming:backfill-entry";
const DREAMS_FILE_LOCKS_KEY = Symbol.for("openclaw.memoryCore.dreamingNarrative.fileLocks");
const NARRATIVE_SESSION_LOCKS_KEY = Symbol.for("openclaw.memoryCore.dreamingNarrative.sessionLocks");
const dreamsFileLocks = resolveGlobalMap(DREAMS_FILE_LOCKS_KEY);
const narrativeSessionLocks = resolveGlobalMap(NARRATIVE_SESSION_LOCKS_KEY);
function isRequestScopedSubagentRuntimeError(err) {
	return err instanceof RequestScopedSubagentRuntimeError || err instanceof Error && err.name === "RequestScopedSubagentRuntimeError" && extractErrorCode(err) === "OPENCLAW_SUBAGENT_RUNTIME_REQUEST_SCOPE";
}
function formatFallbackWriteFailure(err) {
	const code = extractErrorCode(err);
	const name = readErrorName(err);
	if (code && name) return `code=${code} name=${name}`;
	if (code) return `code=${code}`;
	if (name) return `name=${name}`;
	return "unknown error";
}
function buildRequestScopedFallbackNarrative(data) {
	return data.snippets.map((value) => value.trim()).find((value) => value.length > 0) ?? (data.promotions ?? []).map((value) => value.trim()).find((value) => value.length > 0) ?? "A memory trace surfaced, but details were unavailable in this run.";
}
function buildNarrativeAttemptSessionKey(baseSessionKey, attempt) {
	return attempt === 0 ? baseSessionKey : `${baseSessionKey}-retry-${attempt}`;
}
function isConfiguredModelUnavailableNarrativeError(raw) {
	const message = raw.trim();
	if (!message) return false;
	if (/requested model may be(?: temporarily)? unavailable/i.test(message)) return true;
	if (/model unavailable/i.test(message)) return true;
	if (/no endpoints found for/i.test(message)) return true;
	if (/unknown model/i.test(message)) return true;
	if (/model(?:[_\-\s])?not(?:[_\-\s])?found/i.test(message)) return true;
	if (/\b404\b/.test(message) && /not(?:[_\-\s])?found/i.test(message)) return true;
	if (/not_found_error/i.test(message)) return true;
	if (/models\/[^\s]+ is not found/i.test(message)) return true;
	if (/model/i.test(message) && /does not exist/i.test(message)) return true;
	if (/unsupported model/i.test(message)) return true;
	if (/is not a valid model id/i.test(message)) return true;
	return false;
}
function formatNarrativeTerminalStatus(params) {
	const detail = params.error?.trim();
	return detail ? `status=${params.status} (${detail})` : `status=${params.status}`;
}
async function startNarrativeRunOrFallback(params) {
	try {
		return (await params.subagent.run({
			idempotencyKey: `${params.sessionKey}-${params.nowMs}`,
			sessionKey: params.sessionKey,
			message: params.message,
			...params.model ? { model: params.model } : {},
			extraSystemPrompt: NARRATIVE_SYSTEM_PROMPT,
			lane: `dreaming-narrative:${params.sessionKey}`,
			lightContext: true,
			deliver: false
		})).runId;
	} catch (runErr) {
		if (!isRequestScopedSubagentRuntimeError(runErr)) throw runErr;
		try {
			await appendNarrativeEntry({
				workspaceDir: params.workspaceDir,
				narrative: buildRequestScopedFallbackNarrative(params.data),
				nowMs: params.nowMs,
				timezone: params.timezone
			});
			params.logger.info(`memory-core: narrative generation used fallback for ${params.data.phase} phase because subagent runtime is request-scoped.`);
		} catch (fallbackErr) {
			params.logger.warn(`memory-core: narrative fallback failed for ${params.data.phase} phase (${formatFallbackWriteFailure(fallbackErr)})`);
		}
		return null;
	}
}
/**
* Build the deterministic subagent session key used for dream narratives.
*/
function buildNarrativeSessionKey(params) {
	const workspaceHash = createHash("sha1").update(params.workspaceDir).digest("hex").slice(0, 12);
	return `dreaming-narrative-${params.phase}-${workspaceHash}`;
}
function buildNarrativePrompt(data) {
	const lines = [];
	lines.push("Write a dream diary entry from these memory fragments:\n");
	for (const snippet of data.snippets.slice(0, 12)) lines.push(`- ${snippet}`);
	if (data.themes?.length) {
		lines.push("\nRecurring themes:");
		for (const theme of data.themes.slice(0, 6)) lines.push(`- ${theme}`);
	}
	if (data.promotions?.length) {
		lines.push("\nMemories that crystallized into something lasting:");
		for (const promo of data.promotions.slice(0, 5)) lines.push(`- ${promo}`);
	}
	return lines.join("\n");
}
function extractNarrativeText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
		const record = msg;
		if (record.role !== "assistant") continue;
		const content = record.content;
		if (typeof content === "string" && content.trim().length > 0) return content.trim();
		if (Array.isArray(content)) {
			const text = content.filter((part) => part && typeof part === "object" && !Array.isArray(part) && (part.type === "text" || part.type === "output_text") && typeof part.text === "string").map((part) => part.text).join("\n").trim();
			if (text.length > 0) return text;
		}
	}
	return null;
}
function formatNarrativeDate(epochMs, timezone) {
	const opts = {
		timeZone: timezone ?? process.env.TZ,
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
		timeZoneName: "short"
	};
	return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}
async function resolveDreamsPath(workspaceDir) {
	for (const name of DREAMS_FILENAMES) {
		const target = path.join(workspaceDir, name);
		try {
			await fs.access(target);
			return target;
		} catch (err) {
			if (err?.code !== "ENOENT") throw err;
		}
	}
	return path.join(workspaceDir, DREAMS_FILENAMES[0]);
}
async function readDreamsFile(dreamsPath) {
	try {
		return await fs.readFile(dreamsPath, "utf-8");
	} catch (err) {
		if (err?.code === "ENOENT") return "";
		throw err;
	}
}
function ensureDiarySection(existing) {
	if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) return existing;
	const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}\n${DIARY_END_MARKER}\n`;
	if (existing.trim().length === 0) return diarySection;
	return diarySection + "\n" + existing;
}
function replaceDiaryContent(existing, diaryContent) {
	const ensured = ensureDiarySection(existing);
	const startIdx = ensured.indexOf(DIARY_START_MARKER);
	const endIdx = ensured.indexOf(DIARY_END_MARKER);
	if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return ensured;
	const before = ensured.slice(0, startIdx + 38);
	const after = ensured.slice(endIdx);
	return before + (diaryContent.trim().length > 0 ? `\n${diaryContent.trim()}\n` : "\n") + after;
}
function splitDiaryBlocks(diaryContent) {
	return diaryContent.split(/\n---\n/).map((block) => block.trim()).filter((block) => block.length > 0);
}
function normalizeDiaryBlockFingerprint(block) {
	const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
	let dateLine = "";
	const bodyLines = [];
	for (const line of lines) {
		if (!dateLine && line.startsWith("*") && line.endsWith("*") && line.length > 2) {
			dateLine = line.slice(1, -1).trim();
			continue;
		}
		if (line.startsWith("<!--") || line.startsWith("#")) continue;
		bodyLines.push(line);
	}
	return `${dateLine.replace(/\s+/g, " ").trim()}\n${bodyLines.join("\n").replace(/[ \t]+\n/g, "\n").trim()}`;
}
function joinDiaryBlocks(blocks) {
	if (blocks.length === 0) return "";
	return blocks.map((block) => `---\n\n${block.trim()}\n`).join("\n");
}
function stripBackfillDiaryBlocks(existing) {
	const ensured = ensureDiarySection(existing);
	const startIdx = ensured.indexOf(DIARY_START_MARKER);
	const endIdx = ensured.indexOf(DIARY_END_MARKER);
	if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return {
		updated: ensured,
		removed: 0
	};
	const inner = ensured.slice(startIdx + 38, endIdx);
	const kept = [];
	let removed = 0;
	for (const block of splitDiaryBlocks(inner)) {
		if (block.includes(BACKFILL_ENTRY_MARKER)) {
			removed += 1;
			continue;
		}
		kept.push(block);
	}
	return {
		updated: replaceDiaryContent(ensured, joinDiaryBlocks(kept)),
		removed
	};
}
function formatBackfillDiaryDate(isoDay, _timezone) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
	if (!match) return isoDay;
	const [, year, month, day] = match;
	const opts = {
		timeZone: "UTC",
		year: "numeric",
		month: "long",
		day: "numeric"
	};
	const epochMs = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
	return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}
async function assertSafeDreamsPath(dreamsPath) {
	const stat = await fs.lstat(dreamsPath).catch((err) => {
		if (err.code === "ENOENT") return null;
		throw err;
	});
	if (!stat) return;
	if (stat.isSymbolicLink()) throw new Error("Refusing to write symlinked DREAMS.md");
	if (!stat.isFile()) throw new Error("Refusing to write non-file DREAMS.md");
}
async function writeDreamsFileAtomic(dreamsPath, content) {
	await assertSafeDreamsPath(dreamsPath);
	await replaceFileAtomic({
		filePath: dreamsPath,
		content,
		mode: 384,
		preserveExistingMode: true,
		tempPrefix: `${path.basename(dreamsPath)}.dreams`,
		throwOnCleanupError: true
	});
}
async function updateDreamsFile(params) {
	const dreamsPath = await resolveDreamsPath(params.workspaceDir);
	await fs.mkdir(path.dirname(dreamsPath), { recursive: true });
	let lockEntry = dreamsFileLocks.get(dreamsPath);
	if (!lockEntry) {
		lockEntry = {
			withLock: createAsyncLock(),
			refs: 0
		};
		dreamsFileLocks.set(dreamsPath, lockEntry);
	}
	lockEntry.refs += 1;
	try {
		return await lockEntry.withLock(async () => {
			const existing = await readDreamsFile(dreamsPath);
			const { content, result, shouldWrite = true } = await params.updater(existing, dreamsPath);
			if (shouldWrite) await writeDreamsFileAtomic(dreamsPath, content.endsWith("\n") ? content : `${content}\n`);
			return result;
		});
	} finally {
		lockEntry.refs -= 1;
		if (lockEntry.refs <= 0 && dreamsFileLocks.get(dreamsPath) === lockEntry) dreamsFileLocks.delete(dreamsPath);
	}
}
async function withNarrativeSessionLock(sessionKey, fn) {
	let lockEntry = narrativeSessionLocks.get(sessionKey);
	if (!lockEntry) {
		lockEntry = {
			withLock: createAsyncLock(),
			refs: 0
		};
		narrativeSessionLocks.set(sessionKey, lockEntry);
	}
	lockEntry.refs += 1;
	try {
		return await lockEntry.withLock(fn);
	} finally {
		lockEntry.refs -= 1;
		if (lockEntry.refs <= 0 && narrativeSessionLocks.get(sessionKey) === lockEntry) narrativeSessionLocks.delete(sessionKey);
	}
}
function buildBackfillDiaryEntry(params) {
	const dateStr = formatBackfillDiaryDate(params.isoDay, params.timezone);
	const marker = `<!-- ${BACKFILL_ENTRY_MARKER} day=${params.isoDay}${params.sourcePath ? ` source=${params.sourcePath}` : ""} -->`;
	const body = params.bodyLines.map((line) => line.trimEnd()).join("\n").trim();
	return [
		`*${dateStr}*`,
		marker,
		body
	].filter((part) => part.length > 0).join("\n\n");
}
async function writeBackfillDiaryEntries(params) {
	return await updateDreamsFile({
		workspaceDir: params.workspaceDir,
		updater: (existing, dreamsPath) => {
			const stripped = stripBackfillDiaryBlocks(existing);
			const startIdx = stripped.updated.indexOf(DIARY_START_MARKER);
			const endIdx = stripped.updated.indexOf(DIARY_END_MARKER);
			const nextBlocks = [...splitDiaryBlocks(startIdx >= 0 && endIdx > startIdx ? stripped.updated.slice(startIdx + 38, endIdx) : ""), ...params.entries.map((entry) => buildBackfillDiaryEntry({
				isoDay: entry.isoDay,
				bodyLines: entry.bodyLines,
				sourcePath: entry.sourcePath,
				timezone: params.timezone
			}))];
			return {
				content: replaceDiaryContent(stripped.updated, joinDiaryBlocks(nextBlocks)),
				result: {
					dreamsPath,
					written: params.entries.length,
					replaced: stripped.removed
				}
			};
		}
	});
}
async function removeBackfillDiaryEntries(params) {
	return await updateDreamsFile({
		workspaceDir: params.workspaceDir,
		updater: (existing, dreamsPath) => {
			const stripped = stripBackfillDiaryBlocks(existing);
			return {
				content: stripped.updated,
				result: {
					dreamsPath,
					removed: stripped.removed
				},
				shouldWrite: stripped.removed > 0 || existing.length > 0
			};
		}
	});
}
async function dedupeDreamDiaryEntries(params) {
	return await updateDreamsFile({
		workspaceDir: params.workspaceDir,
		updater: (existing, dreamsPath) => {
			const ensured = ensureDiarySection(existing);
			const startIdx = ensured.indexOf(DIARY_START_MARKER);
			const endIdx = ensured.indexOf(DIARY_END_MARKER);
			if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return {
				content: ensured,
				result: {
					dreamsPath,
					removed: 0,
					kept: 0
				},
				shouldWrite: false
			};
			const blocks = splitDiaryBlocks(ensured.slice(startIdx + 38, endIdx));
			const seen = /* @__PURE__ */ new Set();
			const keptBlocks = [];
			let removed = 0;
			for (const block of blocks) {
				const fingerprint = normalizeDiaryBlockFingerprint(block);
				if (seen.has(fingerprint)) {
					removed += 1;
					continue;
				}
				seen.add(fingerprint);
				keptBlocks.push(block);
			}
			return {
				content: replaceDiaryContent(ensured, joinDiaryBlocks(keptBlocks)),
				result: {
					dreamsPath,
					removed,
					kept: keptBlocks.length
				},
				shouldWrite: removed > 0
			};
		}
	});
}
function buildDiaryEntry(narrative, dateStr) {
	return `\n---\n\n*${dateStr}*\n\n${narrative}\n`;
}
async function appendNarrativeEntry(params) {
	const dateStr = formatNarrativeDate(params.nowMs, params.timezone);
	const entry = buildDiaryEntry(params.narrative, dateStr);
	return await updateDreamsFile({
		workspaceDir: params.workspaceDir,
		updater: (existing, dreamsPath) => {
			let updated;
			if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
				const endIdx = existing.lastIndexOf(DIARY_END_MARKER);
				updated = existing.slice(0, endIdx) + entry + "\n" + existing.slice(endIdx);
			} else if (existing.includes(DIARY_START_MARKER)) {
				const startIdx = existing.indexOf(DIARY_START_MARKER) + 38;
				updated = existing.slice(0, startIdx) + entry + "\n<!-- openclaw:dreaming:diary:end -->\n" + existing.slice(startIdx);
			} else {
				const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}${entry}\n${DIARY_END_MARKER}\n`;
				updated = existing.trim().length === 0 ? diarySection : `${diarySection}\n${existing}`;
			}
			return {
				content: updated,
				result: dreamsPath
			};
		}
	});
}
function normalizeComparablePath(pathname) {
	return process.platform === "win32" ? pathname.toLowerCase() : pathname;
}
async function normalizeSessionFileForComparison(params) {
	const trimmed = params.sessionFile.trim();
	if (!trimmed) return null;
	const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(params.sessionsDir, trimmed);
	try {
		return normalizeComparablePath(await fs.realpath(resolved));
	} catch {
		return normalizeComparablePath(path.resolve(resolved));
	}
}
function isDreamingSessionStoreKey(sessionKey) {
	const firstSeparator = sessionKey.indexOf(":");
	if (firstSeparator < 0) return sessionKey.startsWith(DREAMING_SESSION_KEY_PREFIX);
	const secondSeparator = sessionKey.indexOf(":", firstSeparator + 1);
	return (secondSeparator < 0 ? sessionKey : sessionKey.slice(secondSeparator + 1)).startsWith(DREAMING_SESSION_KEY_PREFIX);
}
async function normalizeSessionEntryPathForComparison(params) {
	const sessionFile = typeof params.entry?.sessionFile === "string" ? params.entry.sessionFile : "";
	if (sessionFile) return normalizeSessionFileForComparison({
		sessionsDir: params.sessionsDir,
		sessionFile
	});
	const sessionId = typeof params.entry?.sessionId === "string" ? params.entry.sessionId.trim() : "";
	if (!SAFE_SESSION_ID_RE.test(sessionId)) return null;
	return normalizeSessionFileForComparison({
		sessionsDir: params.sessionsDir,
		sessionFile: `${sessionId}.jsonl`
	});
}
async function scrubDreamingNarrativeArtifacts(logger) {
	const cfg = getRuntimeConfig();
	const agentsDir = path.join(resolveStateDir(), "agents");
	let agentEntries = [];
	try {
		agentEntries = await fs.readdir(agentsDir, { withFileTypes: true });
	} catch {
		return;
	}
	let prunedEntries = 0;
	let archivedOrphans = 0;
	for (const agentEntry of agentEntries) {
		if (!agentEntry.isDirectory()) continue;
		const storePath = resolveStorePath(cfg.session?.store, { agentId: agentEntry.name });
		const sessionsDir = path.dirname(storePath);
		let store;
		try {
			store = loadSessionStore(storePath);
		} catch {
			continue;
		}
		const referencedSessionFiles = /* @__PURE__ */ new Set();
		let needsStoreUpdate = false;
		for (const [key, entry] of Object.entries(store)) {
			const normalizedSessionFile = await normalizeSessionEntryPathForComparison({
				sessionsDir,
				entry
			});
			if (normalizedSessionFile) referencedSessionFiles.add(normalizedSessionFile);
			if (!isDreamingSessionStoreKey(key)) continue;
			if (!normalizedSessionFile || !await pathExists(normalizedSessionFile)) needsStoreUpdate = true;
		}
		if (needsStoreUpdate) {
			referencedSessionFiles.clear();
			prunedEntries += await updateSessionStore(storePath, async (lockedStore) => {
				let prunedForAgent = 0;
				for (const [key, entry] of Object.entries(lockedStore)) {
					const normalizedSessionFile = await normalizeSessionEntryPathForComparison({
						sessionsDir,
						entry
					});
					if (normalizedSessionFile) referencedSessionFiles.add(normalizedSessionFile);
					if (!isDreamingSessionStoreKey(key)) continue;
					if (!normalizedSessionFile || !await pathExists(normalizedSessionFile)) {
						delete lockedStore[key];
						prunedForAgent += 1;
					}
				}
				return prunedForAgent;
			});
		}
		let sessionFiles = [];
		try {
			sessionFiles = await fs.readdir(sessionsDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const fileEntry of sessionFiles) {
			if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
			const transcriptPath = path.join(sessionsDir, fileEntry.name);
			const normalizedTranscriptPath = await normalizeSessionFileForComparison({
				sessionsDir,
				sessionFile: fileEntry.name
			}) ?? normalizeComparablePath(transcriptPath);
			if (referencedSessionFiles.has(normalizedTranscriptPath)) continue;
			let stat;
			try {
				stat = await fs.stat(transcriptPath);
			} catch {
				continue;
			}
			if (Date.now() - stat.mtimeMs < DREAMING_ORPHAN_MIN_AGE_MS) continue;
			let content = "";
			try {
				content = await fs.readFile(transcriptPath, "utf-8");
			} catch {
				continue;
			}
			if (!content.includes(DREAMING_TRANSCRIPT_RUN_MARKER)) continue;
			const archivedPath = `${transcriptPath}.deleted.${Date.now()}`;
			try {
				await fs.rename(transcriptPath, archivedPath);
				archivedOrphans += 1;
			} catch {}
		}
	}
	if (prunedEntries > 0 || archivedOrphans > 0) logger.info(`memory-core: dreaming cleanup scrubbed ${prunedEntries} stale session entr${prunedEntries === 1 ? "y" : "ies"} and archived ${archivedOrphans} orphan transcript${archivedOrphans === 1 ? "" : "s"}.`);
}
async function generateAndAppendDreamNarrative(params) {
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	if (params.data.snippets.length === 0 && !params.data.promotions?.length) return;
	const sessionKey = buildNarrativeSessionKey({
		workspaceDir: params.workspaceDir,
		phase: params.data.phase
	});
	const message = buildNarrativePrompt(params.data);
	await withNarrativeSessionLock(sessionKey, async () => {
		const attempts = [];
		let successfulSessionKey = null;
		try {
			const attemptModels = params.model ? [params.model, void 0] : [void 0];
			for (const [attemptIndex, attemptModel] of attemptModels.entries()) {
				const attemptSessionKey = buildNarrativeAttemptSessionKey(sessionKey, attemptIndex);
				const attempt = {
					sessionKey: attemptSessionKey,
					runId: null
				};
				attempts.push(attempt);
				try {
					try {
						await params.subagent.deleteSession({ sessionKey: attemptSessionKey });
					} catch (preCleanupErr) {
						if (!isRequestScopedSubagentRuntimeError(preCleanupErr)) params.logger.warn(`memory-core: narrative pre-cleanup failed for ${params.data.phase} phase: ${formatErrorMessage(preCleanupErr)}`);
					}
					const runId = await startNarrativeRunOrFallback({
						subagent: params.subagent,
						sessionKey: attemptSessionKey,
						message,
						data: params.data,
						workspaceDir: params.workspaceDir,
						nowMs,
						timezone: params.timezone,
						model: attemptModel,
						logger: params.logger
					});
					if (!runId) return;
					attempt.runId = runId;
					const result = await params.subagent.waitForRun({
						runId,
						timeoutMs: NARRATIVE_TIMEOUT_MS
					});
					if (result.status === "ok") {
						successfulSessionKey = attemptSessionKey;
						break;
					}
					if (attemptModel && result.status === "error" && isConfiguredModelUnavailableNarrativeError(result.error ?? "")) {
						params.logger.warn(`memory-core: narrative generation ended with ${formatNarrativeTerminalStatus({
							status: result.status,
							error: result.error
						})} for ${params.data.phase} phase using configured model "${attemptModel}"; retrying with the session default.`);
						continue;
					}
					params.logger.warn(`memory-core: narrative generation ended with ${formatNarrativeTerminalStatus({
						status: result.status,
						error: result.error
					})} for ${params.data.phase} phase.`);
					return;
				} catch (err) {
					if (attemptModel && isConfiguredModelUnavailableNarrativeError(formatErrorMessage(err))) {
						params.logger.warn(`memory-core: narrative generation could not start with configured model "${attemptModel}" for ${params.data.phase} phase; retrying with the session default (${formatErrorMessage(err)}).`);
						continue;
					}
					throw err;
				}
			}
			if (!successfulSessionKey) return;
			const { messages } = await params.subagent.getSessionMessages({
				sessionKey: successfulSessionKey,
				limit: 5
			});
			const narrative = extractNarrativeText(messages);
			if (!narrative) {
				params.logger.warn(`memory-core: narrative generation produced no text for ${params.data.phase} phase.`);
				return;
			}
			await appendNarrativeEntry({
				workspaceDir: params.workspaceDir,
				narrative,
				nowMs,
				timezone: params.timezone
			});
			params.logger.info(`memory-core: dream diary entry written for ${params.data.phase} phase [workspace=${params.workspaceDir}].`);
		} catch (err) {
			params.logger.warn(`memory-core: narrative generation failed for ${params.data.phase} phase: ${formatErrorMessage(err)}`);
		} finally {
			const cleanedSessionKeys = /* @__PURE__ */ new Set();
			for (const attempt of attempts) {
				if (!attempt.runId || cleanedSessionKeys.has(attempt.sessionKey)) continue;
				cleanedSessionKeys.add(attempt.sessionKey);
				try {
					await params.subagent.deleteSession({ sessionKey: attempt.sessionKey });
				} catch (cleanupErr) {
					params.logger.warn(`memory-core: narrative session cleanup failed for ${params.data.phase} phase: ${formatErrorMessage(cleanupErr)}`);
				}
			}
			await scrubDreamingNarrativeArtifacts(params.logger).catch((scrubErr) => {
				params.logger.warn(`memory-core: dreaming cleanup scrub failed for ${params.data.phase} phase: ${formatErrorMessage(scrubErr)}`);
			});
		}
	});
}
const DETACHED_NARRATIVE_CONCURRENCY = 3;
let activeDetachedNarratives = 0;
const detachedNarrativeQueue = [];
function releaseDetachedNarrativeSlot() {
	activeDetachedNarratives -= 1;
	detachedNarrativeQueue.shift()?.();
}
async function acquireDetachedNarrativeSlot() {
	if (activeDetachedNarratives >= DETACHED_NARRATIVE_CONCURRENCY) await new Promise((resolve) => {
		detachedNarrativeQueue.push(resolve);
	});
	activeDetachedNarratives += 1;
}
function runDetachedDreamNarrative(params) {
	queueMicrotask(() => {
		(async () => {
			await acquireDetachedNarrativeSlot();
			try {
				await generateAndAppendDreamNarrative(params);
			} catch {} finally {
				releaseDetachedNarrativeSlot();
			}
		})();
	});
}
//#endregion
//#region extensions/memory-core/src/dreaming-phases.ts
const MEMORY_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_MEMORY_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i;
const DAILY_INGESTION_STATE_RELATIVE_PATH = path.join("memory", ".dreams", "daily-ingestion.json");
const DAILY_INGESTION_SCORE = .62;
const DAILY_INGESTION_MAX_SNIPPET_CHARS = 280;
const DAILY_INGESTION_MIN_SNIPPET_CHARS = 8;
const DAILY_INGESTION_MAX_CHUNK_LINES = 4;
const SESSION_INGESTION_STATE_RELATIVE_PATH = path.join("memory", ".dreams", "session-ingestion.json");
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const SESSION_INGESTION_SCORE = .58;
const SESSION_INGESTION_MAX_SNIPPET_CHARS = 280;
const SESSION_INGESTION_MIN_SNIPPET_CHARS = 12;
const SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP = 240;
const SESSION_INGESTION_MAX_MESSAGES_PER_FILE = 80;
const SESSION_INGESTION_MIN_MESSAGES_PER_FILE = 12;
const SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION = 4096;
const SESSION_INGESTION_MAX_TRACKED_SCOPES = 2048;
const SESSION_CHECKPOINT_TRANSCRIPT_FILENAME_RE = /\.checkpoint\..+\.jsonl$/i;
const GENERIC_DAY_HEADING_RE = /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;
const MANAGED_DAILY_DREAMING_BLOCKS = [{
	heading: "## Light Sleep",
	startMarker: "<!-- openclaw:dreaming:light:start -->",
	endMarker: "<!-- openclaw:dreaming:light:end -->"
}, {
	heading: "## REM Sleep",
	startMarker: "<!-- openclaw:dreaming:rem:start -->",
	endMarker: "<!-- openclaw:dreaming:rem:end -->"
}];
function calculateLookbackCutoffMs(nowMs, lookbackDays) {
	return nowMs - Math.max(0, lookbackDays) * 24 * 60 * 60 * 1e3;
}
function isDayWithinLookback(day, cutoffMs) {
	const dayMs = Date.parse(`${day}T23:59:59.999Z`);
	return Number.isFinite(dayMs) && dayMs >= cutoffMs;
}
function normalizeDailyListMarker(line) {
	return line.replace(/^\d+\.\s+/, "").replace(/^[-*+]\s+/, "").trim();
}
function normalizeDailyHeading(line) {
	const match = line.trim().match(/^#{1,6}\s+(.+)$/);
	if (!match) return null;
	const heading = match[1] ? normalizeDailyListMarker(match[1]) : "";
	if (!heading || DAILY_MEMORY_FILENAME_RE.test(heading) || isGenericDailyHeading(heading)) return null;
	return heading.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
}
function isGenericDailyHeading(heading) {
	const normalized = heading.trim().replace(/\s+/g, " ");
	if (!normalized) return true;
	const lower = normalized.toLowerCase();
	if (lower === "today" || lower === "yesterday" || lower === "tomorrow") return true;
	if (lower === "morning" || lower === "afternoon" || lower === "evening" || lower === "night") return true;
	return GENERIC_DAY_HEADING_RE.test(normalized);
}
function normalizeDailySnippet(line) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) return null;
	const withoutListMarker = normalizeDailyListMarker(trimmed);
	if (withoutListMarker.length < DAILY_INGESTION_MIN_SNIPPET_CHARS) return null;
	return withoutListMarker.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
}
const REM_REFLECTION_TAG_BLACKLIST = new Set([
	"assistant",
	"user",
	"system",
	"subagent",
	"the"
]);
function buildDailyChunkSnippet(heading, chunkLines, chunkKind) {
	const joiner = chunkKind === "list" ? "; " : " ";
	const body = chunkLines.join(joiner).trim();
	return (heading ? `${heading}: ${body}` : body).slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
}
function buildDailySnippetChunks(lines, limit) {
	const chunks = [];
	let activeHeading = null;
	let chunkLines = [];
	let chunkKind = null;
	let chunkStartLine = 0;
	let chunkEndLine = 0;
	const flushChunk = () => {
		if (chunkLines.length === 0) {
			chunkKind = null;
			chunkStartLine = 0;
			chunkEndLine = 0;
			return;
		}
		const snippet = buildDailyChunkSnippet(activeHeading, chunkLines, chunkKind);
		if (snippet.length >= DAILY_INGESTION_MIN_SNIPPET_CHARS) chunks.push({
			startLine: chunkStartLine,
			endLine: chunkEndLine,
			snippet
		});
		chunkLines = [];
		chunkKind = null;
		chunkStartLine = 0;
		chunkEndLine = 0;
	};
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (typeof line !== "string") continue;
		const heading = normalizeDailyHeading(line);
		if (heading) {
			flushChunk();
			activeHeading = heading;
			continue;
		}
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("<!--")) {
			flushChunk();
			continue;
		}
		const snippet = normalizeDailySnippet(line);
		if (!snippet) {
			flushChunk();
			continue;
		}
		const nextKind = /^([-*+]\s+|\d+\.\s+)/.test(trimmed) ? "list" : "paragraph";
		const nextChunkLines = chunkLines.length === 0 ? [snippet] : [...chunkLines, snippet];
		const candidateSnippet = buildDailyChunkSnippet(activeHeading, nextChunkLines, nextKind);
		if (chunkLines.length > 0 && (chunkKind !== nextKind || chunkLines.length >= DAILY_INGESTION_MAX_CHUNK_LINES || candidateSnippet.length > DAILY_INGESTION_MAX_SNIPPET_CHARS)) flushChunk();
		if (chunkLines.length === 0) {
			chunkStartLine = index + 1;
			chunkKind = nextKind;
		}
		chunkLines.push(snippet);
		chunkEndLine = index + 1;
		if (chunks.length >= limit) break;
	}
	flushChunk();
	return chunks.slice(0, limit);
}
function findManagedDailyDreamingHeadingIndex(lines, startIndex, heading) {
	for (let index = startIndex - 1; index >= 0; index -= 1) {
		const trimmed = lines[index]?.trim() ?? "";
		if (!trimmed) continue;
		return trimmed === heading ? index : null;
	}
	return null;
}
function isManagedDailyDreamingBoundary(line, blockByStartMarker) {
	const trimmed = line.trim();
	return /^#{1,6}\s+/.test(trimmed) || blockByStartMarker.has(trimmed);
}
function stripManagedDailyDreamingLines(lines) {
	const blockByStartMarker = new Map(MANAGED_DAILY_DREAMING_BLOCKS.map((block) => [block.startMarker, block]));
	const sanitized = [...lines];
	for (let index = 0; index < sanitized.length; index += 1) {
		const block = blockByStartMarker.get(sanitized[index]?.trim() ?? "");
		if (!block) continue;
		let stripUntilIndex = -1;
		for (let cursor = index + 1; cursor < sanitized.length; cursor += 1) {
			const line = sanitized[cursor];
			if ((line?.trim() ?? "") === block.endMarker) {
				stripUntilIndex = cursor;
				break;
			}
			if (line && isManagedDailyDreamingBoundary(line, blockByStartMarker)) {
				stripUntilIndex = cursor - 1;
				break;
			}
		}
		if (stripUntilIndex < index) continue;
		const startIndex = findManagedDailyDreamingHeadingIndex(lines, index, block.heading) ?? index;
		for (let cursor = startIndex; cursor <= stripUntilIndex; cursor += 1) sanitized[cursor] = "";
		index = stripUntilIndex;
	}
	return sanitized;
}
function entryWithinLookback(entry, cutoffMs) {
	if ((entry.recallDays ?? []).some((day) => isDayWithinLookback(day, cutoffMs))) return true;
	const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
	return Number.isFinite(lastRecalledAtMs) && lastRecalledAtMs >= cutoffMs;
}
function filterRecallEntriesWithinLookback(params) {
	const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
	return params.entries.filter((entry) => entryWithinLookback(entry, cutoffMs));
}
function parseDailyMemoryFileName(fileName) {
	const day = fileName.match(DAILY_MEMORY_FILENAME_RE)?.[1];
	return day ? {
		fileName,
		day,
		canonical: fileName.toLowerCase() === `${day}.md`
	} : null;
}
function compareDailyMemoryFilesByNewestDay(left, right) {
	const dayOrder = right.day.localeCompare(left.day);
	if (dayOrder !== 0) return dayOrder;
	if (left.canonical !== right.canonical) return left.canonical ? -1 : 1;
	return left.fileName.localeCompare(right.fileName);
}
function resolveWorkspaceMemoryRelativePath(workspaceDir, filePath) {
	const relativePath = path.relative(workspaceDir, filePath).replace(/\\/g, "/");
	if (relativePath && relativePath !== ".." && !relativePath.startsWith("../")) return relativePath;
	return `memory/${path.basename(filePath)}`;
}
function normalizeDailyIngestionState(raw) {
	const filesRaw = asNullableRecord(asNullableRecord(raw)?.files);
	if (!filesRaw) return {
		version: 1,
		files: {}
	};
	const files = {};
	for (const [key, value] of Object.entries(filesRaw)) {
		const file = asNullableRecord(value);
		if (!file || typeof key !== "string" || key.trim().length === 0) continue;
		const mtimeMs = Number(file.mtimeMs);
		const size = Number(file.size);
		if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) continue;
		const lastDreamingDayIngested = normalizeMemoryDay(file.lastDreamingDayIngested);
		files[key] = {
			mtimeMs: Math.floor(mtimeMs),
			size: Math.floor(size),
			...lastDreamingDayIngested ? { lastDreamingDayIngested } : {}
		};
	}
	return {
		version: 1,
		files
	};
}
function normalizeMemoryDay(value) {
	if (typeof value !== "string") return;
	const day = value.trim();
	return MEMORY_DAY_RE.test(day) ? day : void 0;
}
async function readDailyIngestionState(workspaceDir) {
	try {
		return normalizeDailyIngestionState(await privateFileStore(workspaceDir).readJsonIfExists(DAILY_INGESTION_STATE_RELATIVE_PATH));
	} catch (err) {
		if (err instanceof SyntaxError) return {
			version: 1,
			files: {}
		};
		throw err;
	}
}
async function writeDailyIngestionState(workspaceDir, state) {
	await privateFileStore(workspaceDir).writeJson(DAILY_INGESTION_STATE_RELATIVE_PATH, state, { trailingNewline: true });
}
function normalizeWorkspaceKey(workspaceDir) {
	const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function normalizeSessionIngestionState(raw) {
	const record = asNullableRecord(raw);
	const filesRaw = asNullableRecord(record?.files);
	const files = {};
	if (filesRaw) for (const [key, value] of Object.entries(filesRaw)) {
		const file = asNullableRecord(value);
		if (!file || key.trim().length === 0) continue;
		const mtimeMs = Number(file.mtimeMs);
		const size = Number(file.size);
		if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) continue;
		const lineCountRaw = Number(file.lineCount);
		const lastContentLineRaw = Number(file.lastContentLine);
		const lineCount = Number.isFinite(lineCountRaw) && lineCountRaw >= 0 ? Math.floor(lineCountRaw) : 0;
		const lastContentLine = Number.isFinite(lastContentLineRaw) && lastContentLineRaw >= 0 ? Math.floor(lastContentLineRaw) : 0;
		files[key] = {
			mtimeMs: Math.floor(mtimeMs),
			size: Math.floor(size),
			contentHash: typeof file.contentHash === "string" ? file.contentHash.trim() : "",
			lineCount,
			lastContentLine: Math.min(lineCount, lastContentLine)
		};
	}
	const seenMessagesRaw = asNullableRecord(record?.seenMessages);
	const seenMessages = {};
	if (seenMessagesRaw) for (const [scope, value] of Object.entries(seenMessagesRaw)) {
		if (scope.trim().length === 0 || !Array.isArray(value)) continue;
		const unique = [...new Set(value.filter((entry) => typeof entry === "string"))].map((entry) => entry.trim()).filter(Boolean).slice(-4096);
		if (unique.length > 0) seenMessages[scope] = unique;
	}
	return {
		version: 3,
		files,
		seenMessages
	};
}
async function readSessionIngestionState(workspaceDir) {
	try {
		return normalizeSessionIngestionState(await privateFileStore(workspaceDir).readJsonIfExists(SESSION_INGESTION_STATE_RELATIVE_PATH));
	} catch (err) {
		if (err instanceof SyntaxError) return {
			version: 3,
			files: {},
			seenMessages: {}
		};
		throw err;
	}
}
async function writeSessionIngestionState(workspaceDir, state) {
	await privateFileStore(workspaceDir).writeJson(SESSION_INGESTION_STATE_RELATIVE_PATH, state, { trailingNewline: true });
}
function trimTrackedSessionScopes(seenMessages) {
	const keys = Object.keys(seenMessages);
	if (keys.length <= SESSION_INGESTION_MAX_TRACKED_SCOPES) return seenMessages;
	const keep = new Set(keys.toSorted().slice(-2048));
	const next = {};
	for (const [scope, hashes] of Object.entries(seenMessages)) if (keep.has(scope)) next[scope] = hashes;
	return next;
}
function normalizeSessionCorpusSnippet(value) {
	return value.replace(/\s+/g, " ").trim().slice(0, SESSION_INGESTION_MAX_SNIPPET_CHARS);
}
function hashSessionMessageId(value) {
	return createHash("sha1").update(value).digest("hex");
}
function buildSessionScopeKey(agentId, absolutePath) {
	const fileName = path.basename(absolutePath);
	return `${agentId}:${parseUsageCountedSessionIdFromFileName(fileName) ?? fileName}`;
}
function mergeTrackedMessageHashes(existing, additions) {
	if (additions.length === 0) return existing;
	const seen = new Set(existing);
	const next = existing.slice();
	for (const hash of additions) if (!seen.has(hash)) {
		seen.add(hash);
		next.push(hash);
	}
	if (next.length <= SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION) return next;
	return next.slice(-4096);
}
function areStringArraysEqual(a, b) {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
	return true;
}
function buildSessionStateKey(agentId, absolutePath) {
	return `${agentId}:${sessionPathForFile(absolutePath)}`;
}
function isCheckpointSessionTranscriptPath(absolutePath) {
	return SESSION_CHECKPOINT_TRANSCRIPT_FILENAME_RE.test(path.basename(absolutePath));
}
function buildSessionRenderedLine(params) {
	return `[${`${params.agentId}/${params.sessionPath}#L${params.lineNumber}`}] ${params.snippet}`.slice(0, 344);
}
function resolveSessionAgentsForWorkspace(params) {
	const { cfg, workspaceDir, primaryWorkspaceDir } = params;
	if (!cfg) return [];
	const target = normalizeWorkspaceKey(workspaceDir);
	const match = resolveMemoryDreamingWorkspaces(cfg, {
		primaryWorkspaceDir,
		primaryAgentId: "main"
	}).find((entry) => normalizeWorkspaceKey(entry.workspaceDir) === target);
	if (!match) return [];
	return match.agentIds.filter((agentId, index, all) => agentId.trim().length > 0 && all.indexOf(agentId) === index).toSorted();
}
async function appendSessionCorpusLines(params) {
	if (params.lines.length === 0) return [];
	const relativePath = path.posix.join("memory", ".dreams", "session-corpus", `${params.day}.txt`);
	const absolutePath = path.join(params.workspaceDir, SESSION_CORPUS_RELATIVE_DIR, `${params.day}.txt`);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	let existing = "";
	try {
		existing = await fs.readFile(absolutePath, "utf-8");
	} catch (err) {
		if (err?.code !== "ENOENT") throw err;
	}
	const normalizedExisting = existing.replace(/\r\n/g, "\n");
	const existingLineCount = normalizedExisting.length === 0 ? 0 : normalizedExisting.endsWith("\n") ? normalizedExisting.slice(0, -1).split("\n").length : normalizedExisting.split("\n").length;
	await appendRegularFile({
		filePath: absolutePath,
		content: `${params.lines.map((entry) => entry.rendered).join("\n")}\n`,
		rejectSymlinkParents: true
	});
	return params.lines.map((entry, index) => {
		const lineNumber = existingLineCount + index + 1;
		return {
			path: relativePath,
			startLine: lineNumber,
			endLine: lineNumber,
			score: SESSION_INGESTION_SCORE,
			snippet: entry.snippet,
			source: "memory"
		};
	});
}
async function collectSessionIngestionBatches(params) {
	if (!params.cfg) return {
		batches: [],
		nextState: {
			version: 3,
			files: {},
			seenMessages: {}
		},
		changed: Object.keys(params.state.files).length > 0 || Object.keys(params.state.seenMessages).length > 0
	};
	const agentIds = resolveSessionAgentsForWorkspace({
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		primaryWorkspaceDir: params.primaryWorkspaceDir
	});
	const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
	const batchByDay = /* @__PURE__ */ new Map();
	const nextFiles = {};
	const nextSeenMessages = { ...params.state.seenMessages };
	let changed = false;
	const sessionFiles = [];
	for (const agentId of agentIds) {
		const files = await listSessionFilesForAgent(agentId);
		const transcriptClassification = files.length > 0 ? loadSessionTranscriptClassificationForAgent(agentId) : {
			dreamingNarrativeTranscriptPaths: /* @__PURE__ */ new Set(),
			cronRunTranscriptPaths: /* @__PURE__ */ new Set()
		};
		for (const absolutePath of files) {
			if (isCheckpointSessionTranscriptPath(absolutePath)) continue;
			const normalizedPath = normalizeSessionTranscriptPathForComparison(absolutePath);
			sessionFiles.push({
				agentId,
				absolutePath,
				generatedByDreamingNarrative: transcriptClassification.dreamingNarrativeTranscriptPaths.has(normalizedPath),
				generatedByCronRun: transcriptClassification.cronRunTranscriptPaths.has(normalizedPath),
				sessionPath: sessionPathForFile(absolutePath)
			});
		}
	}
	const sortedFiles = sessionFiles.toSorted((a, b) => {
		if (a.agentId !== b.agentId) return a.agentId.localeCompare(b.agentId);
		return a.sessionPath.localeCompare(b.sessionPath);
	});
	const totalCap = SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP;
	let remaining = totalCap;
	const perFileCap = Math.min(SESSION_INGESTION_MAX_MESSAGES_PER_FILE, Math.max(SESSION_INGESTION_MIN_MESSAGES_PER_FILE, Math.ceil(totalCap / Math.max(1, sortedFiles.length))));
	for (const file of sortedFiles) {
		if (remaining <= 0) break;
		const stateKey = buildSessionStateKey(file.agentId, file.absolutePath);
		const previous = params.state.files[stateKey];
		const stat = await fs.stat(file.absolutePath).catch((err) => {
			if (err?.code === "ENOENT") return null;
			throw err;
		});
		if (!stat) {
			if (previous) changed = true;
			continue;
		}
		const fingerprint = {
			mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)),
			size: Math.floor(Math.max(0, stat.size))
		};
		const cursorAtEnd = previous !== void 0 && previous.lastContentLine >= previous.lineCount;
		if (Boolean(previous) && previous.mtimeMs === fingerprint.mtimeMs && previous.size === fingerprint.size && previous.contentHash.length > 0 && cursorAtEnd) {
			nextFiles[stateKey] = previous;
			continue;
		}
		const entry = await buildSessionEntry(file.absolutePath, {
			generatedByDreamingNarrative: file.generatedByDreamingNarrative,
			generatedByCronRun: file.generatedByCronRun
		});
		if (!entry) continue;
		if (entry.generatedByDreamingNarrative || entry.generatedByCronRun) {
			nextFiles[stateKey] = {
				mtimeMs: fingerprint.mtimeMs,
				size: fingerprint.size,
				contentHash: entry.hash.trim(),
				lineCount: entry.lineMap.length,
				lastContentLine: entry.lineMap.length
			};
			if (!previous || previous.mtimeMs !== fingerprint.mtimeMs || previous.size !== fingerprint.size || previous.contentHash !== entry.hash.trim() || previous.lineCount !== entry.lineMap.length || previous.lastContentLine !== entry.lineMap.length) changed = true;
			continue;
		}
		const contentHash = entry.hash.trim();
		if (previous && previous.mtimeMs === fingerprint.mtimeMs && previous.size === fingerprint.size && previous.contentHash === contentHash && previous.lineCount === entry.lineMap.length && previous.lastContentLine >= previous.lineCount) {
			nextFiles[stateKey] = previous;
			continue;
		}
		const sessionScope = buildSessionScopeKey(file.agentId, file.absolutePath);
		const previousSeen = nextSeenMessages[sessionScope] ?? [];
		let seenSet = new Set(previousSeen);
		const newSeenHashes = [];
		const lines = entry.content.length > 0 ? entry.content.split("\n") : [];
		const lineCount = lines.length;
		let cursor = previous && previous.mtimeMs === fingerprint.mtimeMs && previous.size === fingerprint.size && previous.contentHash === contentHash && previous.lineCount === lineCount ? Math.max(0, Math.min(previous.lastContentLine, lineCount)) : 0;
		const fileCap = Math.max(1, Math.min(perFileCap, remaining));
		let fileCount = 0;
		let lastScannedContentLine = cursor;
		for (let index = cursor; index < lines.length; index += 1) {
			if (fileCount >= fileCap || remaining <= 0) break;
			lastScannedContentLine = index + 1;
			const snippet = normalizeSessionCorpusSnippet(lines[index] ?? "");
			if (snippet.length < SESSION_INGESTION_MIN_SNIPPET_CHARS) continue;
			const lineNumber = entry.lineMap[index] ?? index + 1;
			const messageTimestampMs = entry.messageTimestampsMs[index] ?? 0;
			const day = formatMemoryDreamingDay(messageTimestampMs > 0 ? messageTimestampMs : fingerprint.mtimeMs, params.timezone);
			if (!isDayWithinLookback(day, cutoffMs)) continue;
			const messageHash = hashSessionMessageId(`${sessionScope}\n${messageTimestampMs > 0 ? `ts:${Math.floor(messageTimestampMs)}` : `line:${lineNumber}`}\n${snippet}`);
			if (seenSet.has(messageHash)) continue;
			const rendered = buildSessionRenderedLine({
				agentId: file.agentId,
				sessionPath: file.sessionPath,
				lineNumber,
				snippet
			});
			const bucket = batchByDay.get(day) ?? [];
			bucket.push({
				day,
				snippet,
				rendered
			});
			batchByDay.set(day, bucket);
			seenSet.add(messageHash);
			newSeenHashes.push(messageHash);
			fileCount += 1;
			remaining -= 1;
		}
		if (lastScannedContentLine < cursor) lastScannedContentLine = cursor;
		cursor = Math.max(0, Math.min(lastScannedContentLine, lineCount));
		nextFiles[stateKey] = {
			mtimeMs: fingerprint.mtimeMs,
			size: fingerprint.size,
			contentHash,
			lineCount,
			lastContentLine: cursor
		};
		const mergedSeen = mergeTrackedMessageHashes(previousSeen, newSeenHashes);
		nextSeenMessages[sessionScope] = mergedSeen;
		if (!areStringArraysEqual(mergedSeen, previousSeen)) changed = true;
		if (!previous || previous.mtimeMs !== fingerprint.mtimeMs || previous.size !== fingerprint.size || previous.contentHash !== contentHash || previous.lineCount !== lineCount || previous.lastContentLine !== cursor) changed = true;
	}
	for (const [key, state] of Object.entries(params.state.files)) {
		if (!Object.hasOwn(nextFiles, key)) {
			changed = true;
			continue;
		}
		const next = nextFiles[key];
		if (!next || next.mtimeMs !== state.mtimeMs || next.size !== state.size) changed = true;
		if (next && typeof state.contentHash === "string" && state.contentHash.trim().length > 0 && next.contentHash !== state.contentHash) changed = true;
		if (!next || next.lineCount !== state.lineCount || next.lastContentLine !== state.lastContentLine) changed = true;
	}
	const trimmedSeenMessages = trimTrackedSessionScopes(nextSeenMessages);
	for (const [scope, hashes] of Object.entries(trimmedSeenMessages)) if (!areStringArraysEqual(params.state.seenMessages[scope] ?? [], hashes)) changed = true;
	for (const scope of Object.keys(params.state.seenMessages)) if (!Object.hasOwn(trimmedSeenMessages, scope)) changed = true;
	const batches = [];
	for (const day of [...batchByDay.keys()].toSorted()) {
		const lines = batchByDay.get(day) ?? [];
		if (lines.length === 0) continue;
		const results = await appendSessionCorpusLines({
			workspaceDir: params.workspaceDir,
			day,
			lines
		});
		if (results.length > 0) batches.push({
			day,
			results
		});
	}
	return {
		batches,
		nextState: {
			version: 3,
			files: nextFiles,
			seenMessages: trimmedSeenMessages
		},
		changed
	};
}
async function ingestSessionTranscriptSignals(params) {
	const state = await readSessionIngestionState(params.workspaceDir);
	const collected = await collectSessionIngestionBatches({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		primaryWorkspaceDir: params.primaryWorkspaceDir,
		lookbackDays: params.lookbackDays,
		nowMs: params.nowMs,
		timezone: params.timezone,
		state
	});
	const ingestionDayBucket = formatMemoryDreamingDay(params.nowMs, params.timezone);
	for (const batch of collected.batches) await recordShortTermRecalls({
		workspaceDir: params.workspaceDir,
		query: `__dreaming_sessions__:${batch.day}`,
		results: batch.results,
		signalType: "daily",
		dedupeByQueryPerDay: true,
		dayBucket: ingestionDayBucket,
		nowMs: params.nowMs,
		timezone: params.timezone
	});
	if (collected.changed) await writeSessionIngestionState(params.workspaceDir, collected.nextState);
}
async function collectDailyIngestionBatches(params) {
	const memoryDir = path.join(params.workspaceDir, "memory");
	const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
	const files = (await fs.readdir(memoryDir, { withFileTypes: true }).catch((err) => {
		if (err?.code === "ENOENT") return [];
		throw err;
	})).filter((entry) => entry.isFile()).map((entry) => {
		const file = parseDailyMemoryFileName(entry.name);
		if (!file) return null;
		if (!isDayWithinLookback(file.day, cutoffMs)) return null;
		return file;
	}).filter((entry) => entry !== null).toSorted(compareDailyMemoryFilesByNewestDay);
	const batches = [];
	const nextFiles = {};
	let changed = false;
	const totalCap = Math.max(20, params.limit * 4);
	const perFileCap = Math.max(6, Math.ceil(totalCap / Math.max(1, Math.max(files.length, 1))));
	let total = 0;
	for (const file of files) {
		const relativePath = `memory/${file.fileName}`;
		const filePath = path.join(memoryDir, file.fileName);
		const stat = await fs.stat(filePath).catch((err) => {
			if (err?.code === "ENOENT") return null;
			throw err;
		});
		if (!stat) continue;
		const fingerprint = {
			mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)),
			size: Math.floor(Math.max(0, stat.size))
		};
		nextFiles[relativePath] = fingerprint;
		const previous = params.state.files[relativePath];
		const unchanged = previous !== void 0 && previous.mtimeMs === fingerprint.mtimeMs && previous.size === fingerprint.size;
		const previousDreamingDay = normalizeMemoryDay(previous?.lastDreamingDayIngested);
		if (unchanged && previousDreamingDay === params.ingestionDreamingDay) {
			nextFiles[relativePath] = {
				...fingerprint,
				lastDreamingDayIngested: previousDreamingDay
			};
			continue;
		}
		changed = true;
		const raw = await fs.readFile(filePath, "utf-8").catch((err) => {
			if (err?.code === "ENOENT") return "";
			throw err;
		});
		if (!raw) continue;
		const chunks = buildDailySnippetChunks(stripManagedDailyDreamingLines(raw.split(/\r?\n/)), perFileCap);
		const results = [];
		for (const chunk of chunks) {
			results.push({
				path: relativePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				score: DAILY_INGESTION_SCORE,
				snippet: chunk.snippet,
				source: "memory"
			});
			if (results.length >= perFileCap || total + results.length >= totalCap) break;
		}
		if (results.length === 0) continue;
		batches.push({
			day: file.day,
			results
		});
		total += results.length;
		nextFiles[relativePath] = {
			...fingerprint,
			lastDreamingDayIngested: params.ingestionDreamingDay
		};
		if (total >= totalCap) break;
	}
	if (!changed) {
		const previousKeys = Object.keys(params.state.files);
		const nextKeys = Object.keys(nextFiles);
		if (previousKeys.length !== nextKeys.length || previousKeys.some((key) => !Object.hasOwn(nextFiles, key))) changed = true;
	}
	return {
		batches,
		nextState: {
			version: 1,
			files: nextFiles
		},
		changed
	};
}
async function ingestDailyMemorySignals(params) {
	const state = await readDailyIngestionState(params.workspaceDir);
	const ingestionDayBucket = formatMemoryDreamingDay(params.nowMs, params.timezone);
	const collected = await collectDailyIngestionBatches({
		workspaceDir: params.workspaceDir,
		lookbackDays: params.lookbackDays,
		limit: params.limit,
		nowMs: params.nowMs,
		ingestionDreamingDay: ingestionDayBucket,
		state
	});
	for (const batch of collected.batches) await recordShortTermRecalls({
		workspaceDir: params.workspaceDir,
		query: `__dreaming_daily__:${batch.day}`,
		results: batch.results,
		signalType: "daily",
		dedupeByQueryPerDay: true,
		dayBucket: ingestionDayBucket,
		nowMs: params.nowMs,
		timezone: params.timezone
	});
	if (collected.changed) await writeDailyIngestionState(params.workspaceDir, collected.nextState);
}
async function seedHistoricalDailyMemorySignals(params) {
	const normalizedPaths = [...new Set(params.filePaths.map((entry) => entry.trim()).filter(Boolean))];
	if (normalizedPaths.length === 0) return {
		importedFileCount: 0,
		importedSignalCount: 0,
		skippedPaths: []
	};
	const resolved = normalizedPaths.map((filePath) => {
		const fileName = path.basename(filePath);
		const file = parseDailyMemoryFileName(fileName);
		if (!file) return {
			filePath,
			fileName,
			relativePath: "",
			file: null
		};
		return {
			filePath,
			fileName,
			relativePath: resolveWorkspaceMemoryRelativePath(params.workspaceDir, filePath),
			file
		};
	}).toSorted((a, b) => {
		if (a.file && b.file) return compareDailyMemoryFilesByNewestDay(a.file, b.file);
		if (a.file) return -1;
		if (b.file) return 1;
		return a.filePath.localeCompare(b.filePath);
	});
	const valid = resolved.filter((entry) => Boolean(entry.file));
	const skippedPaths = resolved.filter((entry) => !entry.file).map((entry) => entry.filePath);
	const totalCap = Math.max(20, params.limit * 4);
	const perFileCap = Math.max(6, Math.ceil(totalCap / Math.max(1, valid.length)));
	let importedSignalCount = 0;
	let importedFileCount = 0;
	for (const entry of valid) {
		if (importedSignalCount >= totalCap) break;
		const raw = await fs.readFile(entry.filePath, "utf-8").catch((err) => {
			if (err?.code === "ENOENT") {
				skippedPaths.push(entry.filePath);
				return "";
			}
			throw err;
		});
		if (!raw) continue;
		const chunks = buildDailySnippetChunks(stripManagedDailyDreamingLines(raw.split(/\r?\n/)), perFileCap);
		const results = [];
		for (const chunk of chunks) {
			results.push({
				path: entry.relativePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				score: DAILY_INGESTION_SCORE,
				snippet: chunk.snippet,
				source: "memory"
			});
			if (results.length >= perFileCap || importedSignalCount + results.length >= totalCap) break;
		}
		if (results.length === 0) continue;
		await recordShortTermRecalls({
			workspaceDir: params.workspaceDir,
			query: `__dreaming_daily__:${entry.file.day}`,
			results,
			signalType: "daily",
			dedupeByQueryPerDay: true,
			dayBucket: formatMemoryDreamingDay(params.nowMs, params.timezone),
			nowMs: params.nowMs,
			timezone: params.timezone
		});
		importedSignalCount += results.length;
		importedFileCount += 1;
	}
	return {
		importedFileCount,
		importedSignalCount,
		skippedPaths
	};
}
function entryAverageScore(entry) {
	const signalCount = Math.max(0, Math.floor(entry.recallCount ?? 0) + Math.floor(entry.dailyCount ?? 0) + Math.floor(entry.groundedCount ?? 0));
	return signalCount > 0 ? Math.max(0, Math.min(1, entry.totalScore / signalCount)) : 0;
}
function tokenizeSnippet(snippet) {
	return new Set(snippet.toLowerCase().split(/[^a-z0-9]+/i).map((token) => token.trim()).filter(Boolean));
}
function jaccardSimilarity(left, right) {
	const leftTokens = tokenizeSnippet(left);
	const rightTokens = tokenizeSnippet(right);
	if (leftTokens.size === 0 || rightTokens.size === 0) return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0;
	let intersection = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
	const union = new Set([...leftTokens, ...rightTokens]).size;
	return union > 0 ? intersection / union : 0;
}
function dedupeEntries(entries, threshold) {
	const deduped = [];
	for (const entry of entries) {
		const duplicate = deduped.find((candidate) => candidate.path === entry.path && jaccardSimilarity(candidate.snippet, entry.snippet) >= threshold);
		if (duplicate) {
			if (entry.recallCount > duplicate.recallCount) duplicate.recallCount = entry.recallCount;
			duplicate.totalScore = Math.max(duplicate.totalScore, entry.totalScore);
			duplicate.maxScore = Math.max(duplicate.maxScore, entry.maxScore);
			duplicate.queryHashes = [...new Set([...duplicate.queryHashes, ...entry.queryHashes])];
			duplicate.recallDays = [...new Set([...duplicate.recallDays, ...entry.recallDays])].toSorted();
			duplicate.conceptTags = [...new Set([...duplicate.conceptTags, ...entry.conceptTags])];
			duplicate.lastRecalledAt = Date.parse(entry.lastRecalledAt) > Date.parse(duplicate.lastRecalledAt) ? entry.lastRecalledAt : duplicate.lastRecalledAt;
			continue;
		}
		deduped.push({ ...entry });
	}
	return deduped;
}
function buildLightDreamingBody(entries) {
	if (entries.length === 0) return ["- No notable updates."];
	const lines = [];
	for (const entry of entries) {
		const snippet = entry.snippet || "(no snippet captured)";
		lines.push(`- Candidate: ${snippet}`);
		lines.push(`  - confidence: ${entryAverageScore(entry).toFixed(2)}`);
		lines.push(`  - evidence: ${entry.path}:${entry.startLine}-${entry.endLine}`);
		lines.push(`  - recalls: ${entry.recallCount}`);
		lines.push(`  - status: staged`);
	}
	return lines;
}
function calculateCandidateTruthConfidence(entry) {
	const recallStrength = Math.min(1, Math.log1p(entry.recallCount) / Math.log1p(6));
	const averageScore = entryAverageScore(entry);
	const consolidation = Math.min(1, (entry.recallDays?.length ?? 0) / 3);
	const conceptual = Math.min(1, (entry.conceptTags?.length ?? 0) / 6);
	return Math.max(0, Math.min(1, averageScore * .45 + recallStrength * .25 + consolidation * .2 + conceptual * .1));
}
function selectRemCandidateTruths(entries, limit) {
	if (limit <= 0) return [];
	return dedupeEntries(entries.filter((entry) => !entry.promotedAt), .88).map((entry) => ({
		key: entry.key,
		snippet: entry.snippet || "(no snippet captured)",
		confidence: calculateCandidateTruthConfidence(entry),
		evidence: `${entry.path}:${entry.startLine}-${entry.endLine}`
	})).filter((entry) => entry.confidence >= .45).toSorted((a, b) => b.confidence - a.confidence || a.snippet.localeCompare(b.snippet)).slice(0, limit);
}
function buildRemReflections(entries, limit, minPatternStrength) {
	const tagStats = /* @__PURE__ */ new Map();
	for (const entry of entries) for (const tag of entry.conceptTags) {
		if (!tag || REM_REFLECTION_TAG_BLACKLIST.has(tag.toLowerCase())) continue;
		const stat = tagStats.get(tag) ?? {
			count: 0,
			evidence: /* @__PURE__ */ new Set()
		};
		stat.count += 1;
		stat.evidence.add(`${entry.path}:${entry.startLine}-${entry.endLine}`);
		tagStats.set(tag, stat);
	}
	const ranked = [...tagStats.entries()].map(([tag, stat]) => {
		return {
			tag,
			strength: Math.min(1, stat.count / Math.max(1, entries.length) * 2),
			stat
		};
	}).filter((entry) => entry.strength >= minPatternStrength).toSorted((a, b) => b.strength - a.strength || b.stat.count - a.stat.count || a.tag.localeCompare(b.tag)).slice(0, limit);
	if (ranked.length === 0) return ["- No strong patterns surfaced."];
	const lines = [];
	for (const entry of ranked) {
		lines.push(`- Theme: \`${entry.tag}\` kept surfacing across ${entry.stat.count} memories.`);
		lines.push(`  - confidence: ${entry.strength.toFixed(2)}`);
		lines.push(`  - evidence: ${[...entry.stat.evidence].slice(0, 3).join(", ")}`);
		lines.push(`  - note: reflection`);
	}
	return lines;
}
function previewRemDreaming(params) {
	const reflections = buildRemReflections(params.entries, params.limit, params.minPatternStrength);
	const candidateSelections = selectRemCandidateTruths(params.entries, Math.max(1, Math.min(3, params.limit)));
	const candidateTruths = candidateSelections.map((entry) => ({
		snippet: entry.snippet,
		confidence: entry.confidence,
		evidence: entry.evidence
	}));
	const candidateKeys = [...new Set(candidateSelections.map((entry) => entry.key))];
	const bodyLines = [
		"### Reflections",
		...reflections,
		"",
		"### Possible Lasting Truths",
		...candidateTruths.length > 0 ? candidateTruths.map((entry) => `- ${entry.snippet} [confidence=${entry.confidence.toFixed(2)} evidence=${entry.evidence}]`) : ["- No strong candidate truths surfaced."]
	];
	return {
		sourceEntryCount: params.entries.length,
		reflections,
		candidateTruths,
		candidateKeys,
		bodyLines
	};
}
async function runLightDreaming(params) {
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	await ingestDailyMemorySignals({
		workspaceDir: params.workspaceDir,
		lookbackDays: params.config.lookbackDays,
		limit: params.config.limit,
		nowMs,
		timezone: params.config.timezone
	});
	await ingestSessionTranscriptSignals({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		primaryWorkspaceDir: params.primaryWorkspaceDir,
		lookbackDays: params.config.lookbackDays,
		nowMs,
		timezone: params.config.timezone
	});
	const entries = dedupeEntries((await filterLiveShortTermRecallEntries({
		workspaceDir: params.workspaceDir,
		entries: filterRecallEntriesWithinLookback({
			entries: await readShortTermRecallEntries({
				workspaceDir: params.workspaceDir,
				nowMs
			}),
			nowMs,
			lookbackDays: params.config.lookbackDays
		})
	})).toSorted((a, b) => {
		const byTime = Date.parse(b.lastRecalledAt) - Date.parse(a.lastRecalledAt);
		if (byTime !== 0) return byTime;
		return b.recallCount - a.recallCount;
	}).slice(0, params.config.limit), params.config.dedupeSimilarity);
	const capped = entries.slice(0, params.config.limit);
	const bodyLines = buildLightDreamingBody(capped);
	await writeDailyDreamingPhaseBlock({
		workspaceDir: params.workspaceDir,
		phase: "light",
		bodyLines,
		nowMs,
		timezone: params.config.timezone,
		storage: params.config.storage
	});
	await recordDreamingPhaseSignals({
		workspaceDir: params.workspaceDir,
		phase: "light",
		keys: capped.map((entry) => entry.key),
		nowMs
	});
	if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") params.logger.info(`memory-core: light dreaming staged ${Math.min(entries.length, params.config.limit)} candidate(s) [workspace=${params.workspaceDir}].`);
	if (params.subagent && capped.length > 0) {
		const themes = [...new Set(capped.flatMap((e) => e.conceptTags).filter(Boolean))];
		const data = {
			phase: "light",
			snippets: capped.map((e) => e.snippet).filter(Boolean),
			...themes.length > 0 ? { themes } : {}
		};
		if (params.detachNarratives) runDetachedDreamNarrative({
			subagent: params.subagent,
			workspaceDir: params.workspaceDir,
			data,
			nowMs,
			timezone: params.config.timezone,
			model: params.config.execution?.model,
			logger: params.logger
		});
		else await generateAndAppendDreamNarrative({
			subagent: params.subagent,
			workspaceDir: params.workspaceDir,
			data,
			nowMs,
			timezone: params.config.timezone,
			model: params.config.execution?.model,
			logger: params.logger
		});
	}
}
async function runRemDreaming(params) {
	const nowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	await ingestDailyMemorySignals({
		workspaceDir: params.workspaceDir,
		lookbackDays: params.config.lookbackDays,
		limit: params.config.limit,
		nowMs,
		timezone: params.config.timezone
	});
	await ingestSessionTranscriptSignals({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		primaryWorkspaceDir: params.primaryWorkspaceDir,
		lookbackDays: params.config.lookbackDays,
		nowMs,
		timezone: params.config.timezone
	});
	const entries = await filterLiveShortTermRecallEntries({
		workspaceDir: params.workspaceDir,
		entries: filterRecallEntriesWithinLookback({
			entries: await readShortTermRecallEntries({
				workspaceDir: params.workspaceDir,
				nowMs
			}),
			nowMs,
			lookbackDays: params.config.lookbackDays
		})
	});
	const preview = previewRemDreaming({
		entries,
		limit: params.config.limit,
		minPatternStrength: params.config.minPatternStrength
	});
	await writeDailyDreamingPhaseBlock({
		workspaceDir: params.workspaceDir,
		phase: "rem",
		bodyLines: preview.bodyLines,
		nowMs,
		timezone: params.config.timezone,
		storage: params.config.storage
	});
	await recordDreamingPhaseSignals({
		workspaceDir: params.workspaceDir,
		phase: "rem",
		keys: preview.candidateKeys,
		nowMs
	});
	if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") params.logger.info(`memory-core: REM dreaming wrote reflections from ${entries.length} recent memory trace(s) [workspace=${params.workspaceDir}].`);
	if (params.subagent && entries.length > 0) {
		const snippets = preview.candidateTruths.map((t) => t.snippet).filter(Boolean);
		const themes = preview.reflections.filter((r) => !r.startsWith("- No strong") && !r.startsWith("  -"));
		const data = {
			phase: "rem",
			snippets: snippets.length > 0 ? snippets : entries.slice(0, 8).map((e) => e.snippet).filter(Boolean),
			...themes.length > 0 ? { themes } : {}
		};
		if (params.detachNarratives) runDetachedDreamNarrative({
			subagent: params.subagent,
			workspaceDir: params.workspaceDir,
			data,
			nowMs,
			timezone: params.config.timezone,
			model: params.config.execution?.model,
			logger: params.logger
		});
		else await generateAndAppendDreamNarrative({
			subagent: params.subagent,
			workspaceDir: params.workspaceDir,
			data,
			nowMs,
			timezone: params.config.timezone,
			model: params.config.execution?.model,
			logger: params.logger
		});
	}
}
async function runDreamingSweepPhases(params) {
	const sweepNowMs = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
	const light = resolveMemoryLightDreamingConfig({
		pluginConfig: params.pluginConfig,
		cfg: params.cfg
	});
	if (light.enabled && light.limit > 0) await runLightDreaming({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		config: light,
		logger: params.logger,
		subagent: params.subagent,
		nowMs: sweepNowMs,
		detachNarratives: params.detachNarratives
	});
	const rem = resolveMemoryRemDreamingConfig({
		pluginConfig: params.pluginConfig,
		cfg: params.cfg
	});
	if (rem.enabled && rem.limit > 0) await runRemDreaming({
		workspaceDir: params.workspaceDir,
		cfg: params.cfg,
		config: rem,
		logger: params.logger,
		subagent: params.subagent,
		nowMs: sweepNowMs,
		detachNarratives: params.detachNarratives
	});
}
//#endregion
export { dedupeDreamDiaryEntries as a, runDetachedDreamNarrative as c, seedHistoricalDailyMemorySignals as i, writeBackfillDiaryEntries as l, previewRemDreaming as n, generateAndAppendDreamNarrative as o, runDreamingSweepPhases as r, removeBackfillDiaryEntries as s, filterRecallEntriesWithinLookback as t, writeDeepDreamingReport as u };
