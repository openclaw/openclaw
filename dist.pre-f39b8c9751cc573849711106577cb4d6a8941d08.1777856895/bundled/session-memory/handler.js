import { v as resolveStateDir } from "../../paths-C1_Y0cDn.js";
import { t as createSubsystemLogger } from "../../subsystem-CgTF-J8V.js";
import { o as parseAgentSessionKey } from "../../session-key-utils-Dnbck33i.js";
import { h as toAgentStoreSessionKey, u as resolveAgentIdFromSessionKey } from "../../session-key-CTLAw4n4.js";
import { a as resolveAgentIdByWorkspacePath, x as resolveAgentWorkspaceDir } from "../../agent-scope-CzfWAE9r.js";
import { g as writeFileWithinRoot } from "../../fs-safe-CSAZtaEC.js";
import { i as hasInterSessionUserProvenance } from "../../input-provenance-DVjdbTIo.js";
import { t as generateSlugViaLLM } from "../../llm-slug-generator-4VKyTUow.js";
import { r as resolveHookConfig } from "../../config-C9w1xRD8.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region src/hooks/bundled/session-memory/transcript.ts
function extractTextMessageContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block;
		if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
	}
}
async function getRecentSessionContent(sessionFilePath, messageCount = 15) {
	try {
		const lines = (await fs.readFile(sessionFilePath, "utf-8")).trim().split("\n");
		const allMessages = [];
		for (const line of lines) try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) {
				const msg = entry.message;
				const role = msg.role;
				if ((role === "user" || role === "assistant") && "content" in msg && msg.content) {
					if (role === "user" && hasInterSessionUserProvenance(msg)) continue;
					const text = extractTextMessageContent(msg.content);
					if (text && !text.startsWith("/")) allMessages.push(`${role}: ${text}`);
				}
			}
		} catch {}
		return allMessages.slice(-messageCount).join("\n");
	} catch {
		return null;
	}
}
async function getRecentSessionContentWithResetFallback(sessionFilePath, messageCount = 15) {
	const primary = await getRecentSessionContent(sessionFilePath, messageCount);
	if (primary) return primary;
	try {
		const dir = path.dirname(sessionFilePath);
		const resetPrefix = `${path.basename(sessionFilePath)}.reset.`;
		const resetCandidates = (await fs.readdir(dir)).filter((name) => name.startsWith(resetPrefix)).toSorted();
		if (resetCandidates.length === 0) return primary;
		return await getRecentSessionContent(path.join(dir, resetCandidates[resetCandidates.length - 1]), messageCount) || primary;
	} catch {
		return primary;
	}
}
function stripResetSuffix(fileName) {
	const resetIndex = fileName.indexOf(".reset.");
	return resetIndex === -1 ? fileName : fileName.slice(0, resetIndex);
}
async function findPreviousSessionFile(params) {
	try {
		const files = await fs.readdir(params.sessionsDir);
		const fileSet = new Set(files);
		const baseFromReset = params.currentSessionFile ? stripResetSuffix(path.basename(params.currentSessionFile)) : void 0;
		if (baseFromReset && fileSet.has(baseFromReset)) return path.join(params.sessionsDir, baseFromReset);
		const trimmedSessionId = params.sessionId?.trim();
		if (trimmedSessionId) {
			const canonicalFile = `${trimmedSessionId}.jsonl`;
			if (fileSet.has(canonicalFile)) return path.join(params.sessionsDir, canonicalFile);
			const topicVariants = files.filter((name) => name.startsWith(`${trimmedSessionId}-topic-`) && name.endsWith(".jsonl") && !name.includes(".reset.")).toSorted().toReversed();
			if (topicVariants.length > 0) return path.join(params.sessionsDir, topicVariants[0]);
		}
		if (!params.currentSessionFile) return;
		const nonResetJsonl = files.filter((name) => name.endsWith(".jsonl") && !name.includes(".reset.")).toSorted().toReversed();
		if (nonResetJsonl.length > 0) return path.join(params.sessionsDir, nonResetJsonl[0]);
	} catch {}
}
//#endregion
//#region src/hooks/bundled/session-memory/handler.ts
/**
* Session memory hook handler
*
* Saves session context to memory when /new or /reset command is triggered
* Creates a new dated memory file with LLM-generated slug
*/
const log = createSubsystemLogger("hooks/session-memory");
function pickDateTimePart(parts, type) {
	return parts.find((part) => part.type === type)?.value;
}
function resolveLocalTimeZone() {
	const timeZone = process.env.TZ?.trim();
	if (!timeZone) return;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone }).format(/* @__PURE__ */ new Date());
		return timeZone;
	} catch {
		return;
	}
}
function formatLocalSessionTimestamp(date) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: resolveLocalTimeZone(),
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short"
	}).formatToParts(date);
	const year = pickDateTimePart(parts, "year") ?? String(date.getFullYear()).padStart(4, "0");
	const month = pickDateTimePart(parts, "month") ?? String(date.getMonth() + 1).padStart(2, "0");
	const day = pickDateTimePart(parts, "day") ?? String(date.getDate()).padStart(2, "0");
	const hour = pickDateTimePart(parts, "hour") ?? String(date.getHours()).padStart(2, "0");
	const minute = pickDateTimePart(parts, "minute") ?? String(date.getMinutes()).padStart(2, "0");
	const second = pickDateTimePart(parts, "second") ?? String(date.getSeconds()).padStart(2, "0");
	const timeZoneName = [...parts].toReversed().find((part) => part.type === "timeZoneName")?.value?.trim();
	return {
		date: `${year}-${month}-${day}`,
		time: `${hour}:${minute}:${second}`,
		timeSlug: `${hour}${minute}`,
		timeZoneName
	};
}
function resolveDisplaySessionKey(params) {
	if (!params.cfg || !params.workspaceDir) return params.sessionKey;
	const workspaceAgentId = resolveAgentIdByWorkspacePath(params.cfg, params.workspaceDir);
	const parsed = parseAgentSessionKey(params.sessionKey);
	if (!workspaceAgentId || !parsed || workspaceAgentId === parsed.agentId) return params.sessionKey;
	return toAgentStoreSessionKey({
		agentId: workspaceAgentId,
		requestKey: parsed.rest
	});
}
/**
* Save session context to memory when /new or /reset command is triggered
*/
const saveSessionToMemory = async (event) => {
	const isResetCommand = event.action === "new" || event.action === "reset";
	if (event.type !== "command" || !isResetCommand) return;
	try {
		log.debug("Hook triggered for reset/new command", { action: event.action });
		const context = event.context || {};
		const cfg = context.cfg;
		const contextWorkspaceDir = typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0 ? context.workspaceDir : void 0;
		const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
		const workspaceDir = contextWorkspaceDir || (cfg ? resolveAgentWorkspaceDir(cfg, agentId) : path.join(resolveStateDir(process.env, os.homedir), "workspace"));
		const displaySessionKey = resolveDisplaySessionKey({
			cfg,
			workspaceDir: contextWorkspaceDir,
			sessionKey: event.sessionKey
		});
		const memoryDir = path.join(workspaceDir, "memory");
		await fs.mkdir(memoryDir, { recursive: true });
		const localTimestamp = formatLocalSessionTimestamp(new Date(event.timestamp));
		const dateStr = localTimestamp.date;
		const sessionEntry = context.previousSessionEntry || context.sessionEntry || {};
		const currentSessionId = sessionEntry.sessionId;
		let currentSessionFile = sessionEntry.sessionFile || void 0;
		if (!currentSessionFile || currentSessionFile.includes(".reset.")) {
			const sessionsDirs = /* @__PURE__ */ new Set();
			if (currentSessionFile) sessionsDirs.add(path.dirname(currentSessionFile));
			sessionsDirs.add(path.join(workspaceDir, "sessions"));
			for (const sessionsDir of sessionsDirs) {
				const recoveredSessionFile = await findPreviousSessionFile({
					sessionsDir,
					currentSessionFile,
					sessionId: currentSessionId
				});
				if (!recoveredSessionFile) continue;
				currentSessionFile = recoveredSessionFile;
				log.debug("Found previous session file", { file: currentSessionFile });
				break;
			}
		}
		log.debug("Session context resolved", {
			sessionId: currentSessionId,
			sessionFile: currentSessionFile,
			hasCfg: Boolean(cfg)
		});
		const sessionFile = currentSessionFile || void 0;
		const hookConfig = resolveHookConfig(cfg, "session-memory");
		const messageCount = typeof hookConfig?.messages === "number" && hookConfig.messages > 0 ? hookConfig.messages : 15;
		let slug = null;
		let sessionContent = null;
		if (sessionFile) {
			sessionContent = await getRecentSessionContentWithResetFallback(sessionFile, messageCount);
			log.debug("Session content loaded", {
				length: sessionContent?.length ?? 0,
				messageCount
			});
			const allowLlmSlug = !(process.env.OPENCLAW_TEST_FAST === "1" || process.env.VITEST === "true" || process.env.VITEST === "1" || false) && hookConfig?.llmSlug !== false;
			if (sessionContent && cfg && allowLlmSlug) {
				log.debug("Calling generateSlugViaLLM...");
				slug = await generateSlugViaLLM({
					sessionContent,
					cfg
				});
				log.debug("Generated slug", { slug });
			}
		}
		if (!slug) {
			slug = localTimestamp.timeSlug;
			log.debug("Using fallback timestamp slug", { slug });
		}
		const filename = `${dateStr}-${slug}.md`;
		const memoryFilePath = path.join(memoryDir, filename);
		log.debug("Memory file path resolved", {
			filename,
			path: memoryFilePath.replace(os.homedir(), "~")
		});
		const timeStr = localTimestamp.time;
		const timeZoneSuffix = localTimestamp.timeZoneName ? ` ${localTimestamp.timeZoneName}` : "";
		const sessionId = sessionEntry.sessionId || "unknown";
		const source = context.commandSource || "unknown";
		const entryParts = [
			`# Session: ${dateStr} ${timeStr}${timeZoneSuffix}`,
			"",
			`- **Session Key**: ${displaySessionKey}`,
			`- **Session ID**: ${sessionId}`,
			`- **Source**: ${source}`,
			""
		];
		if (sessionContent) entryParts.push("## Conversation Summary", "", sessionContent, "");
		await writeFileWithinRoot({
			rootDir: memoryDir,
			relativePath: filename,
			data: entryParts.join("\n"),
			encoding: "utf-8"
		});
		log.debug("Memory file written successfully");
		const relPath = memoryFilePath.replace(os.homedir(), "~");
		log.info(`Session context saved to ${relPath}`);
	} catch (err) {
		if (err instanceof Error) log.error("Failed to save session memory", {
			errorName: err.name,
			errorMessage: err.message,
			stack: err.stack
		});
		else log.error("Failed to save session memory", { error: String(err) });
	}
};
//#endregion
export { saveSessionToMemory as default };
