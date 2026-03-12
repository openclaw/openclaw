import { s as resolveAgentWorkspaceDir } from "../../agent-scope-ET3-KDD1.js";
import { s as resolveStateDir } from "../../paths-MYHBPf85.js";
import { t as createSubsystemLogger } from "../../subsystem-CYLd4dcj.js";
import { l as resolveAgentIdFromSessionKey } from "../../session-key-CPPWn8gW.js";
import "../../workspace-PvhqUv3h.js";
import "../../model-selection-DOYvU3hc.js";
import "../../github-copilot-token-DyM1y5Pr.js";
import "../../env-DioSf1y0.js";
import "../../boolean-Ce2-qkSB.js";
import "../../dock-B066-9Rj.js";
import "../../tokens-BbMquAae.js";
import "../../pi-embedded-vtzKgCPR.js";
import "../../plugins-DUx2IkaN.js";
import "../../accounts-4SEfqy3O.js";
import "../../bindings-TAejNrPZ.js";
import "../../send-CuT_IAxo.js";
import "../../send-Daa6sK7I.js";
import "../../deliver-BSV7SUGt.js";
import "../../diagnostic-D9vs_fb5.js";
import "../../diagnostic-session-state-_tGY1a3B.js";
import "../../accounts-DhD7OMBH.js";
import "../../send-DZkT7Lin.js";
import "../../image-ops-D98Q4dLq.js";
import "../../pi-model-discovery-B1pl3ZAU.js";
import "../../message-channel-rHdyUBOJ.js";
import "../../pi-embedded-helpers-DLdc_PG7.js";
import "../../chrome-DNpJVmqn.js";
import "../../ssrf-GR1wTjsC.js";
import "../../frontmatter-CthhXKqf.js";
import "../../skills-D8Wcotgx.js";
import "../../path-alias-guards-Ck6h4R-2.js";
import "../../redact-BsXsyykh.js";
import "../../errors-kKzMhHcT.js";
import "../../fs-safe-D8h6zmZn.js";
import "../../store-BPoOdDyW.js";
import { O as hasInterSessionUserProvenance } from "../../sessions-BLHmBFe6.js";
import "../../accounts-CpA_IJ0G.js";
import "../../paths-6XrpQmMB.js";
import "../../tool-images-C4bZaIjc.js";
import "../../thinking-CJoHneR6.js";
import "../../image-DnmlghbV.js";
import "../../reply-prefix-DK2AzWrE.js";
import "../../manager-B8LQNjGO.js";
import "../../gemini-auth-BoOrasN3.js";
import "../../fetch-guard-2JREkJbB.js";
import "../../query-expansion-DuzwZ9c2.js";
import "../../retry-BL5RYsiN.js";
import "../../target-errors-DBatBG-G.js";
import "../../chunk-BhlcoTjA.js";
import "../../markdown-tables-CNQyTFcB.js";
import "../../local-roots-BetgXXEI.js";
import "../../ir-Ba_n_pb3.js";
import "../../render-loap2gRq.js";
import "../../commands-registry-BddqMTS2.js";
import "../../skill-commands-B6v3y3OE.js";
import "../../runner-BE6_rpZS.js";
import "../../fetch-B1nZSYJF.js";
import "../../channel-activity-D4_nz4fl.js";
import "../../tables-Brdg2O2u.js";
import "../../send-BUlQysvB.js";
import "../../outbound-attachment-Ccxd6mWr.js";
import "../../send-Dn1Z_z9F.js";
import "../../resolve-route-CYiczLHJ.js";
import "../../proxy-Bee2aKQk.js";
import "../../replies-BCK-SYzD.js";
import { generateSlugViaLLM } from "../../llm-slug-generator.js";
import { t as resolveHookConfig } from "../../config-BeIwBEE4.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { exec } from "node:child_process";

//#region src/hooks/bundled/session-memory/handler.ts
/**
* Session memory hook handler
*
* Saves session context to memory when /new or /reset command is triggered
* Creates a new dated memory file with LLM-generated slug
*/
const execAsync = promisify(exec);
const log = createSubsystemLogger("hooks/session-memory");
/**
* Read recent messages from session file for slug generation
*/
async function getRecentSessionContent(sessionFilePath, messageCount = 15) {
	try {
		const lines = (await fs.readFile(sessionFilePath, "utf-8")).trim().split("\n");
		const allMessages = [];
		for (const line of lines) try {
			const entry = JSON.parse(line);
			if (entry.type === "message" && entry.message) {
				const msg = entry.message;
				const role = msg.role;
				if ((role === "user" || role === "assistant") && msg.content) {
					if (role === "user" && hasInterSessionUserProvenance(msg)) continue;
					const text = Array.isArray(msg.content) ? msg.content.find((c) => c.type === "text")?.text : msg.content;
					if (text && !text.startsWith("/")) allMessages.push(`${role}: ${text}`);
				}
			}
		} catch {}
		return allMessages.slice(-messageCount).join("\n");
	} catch {
		return null;
	}
}
/**
* Try the active transcript first; if /new already rotated it,
* fallback to the latest .jsonl.reset.* sibling.
*/
async function getRecentSessionContentWithResetFallback(sessionFilePath, messageCount = 15) {
	const primary = await getRecentSessionContent(sessionFilePath, messageCount);
	if (primary) return primary;
	try {
		const dir = path.dirname(sessionFilePath);
		const resetPrefix = `${path.basename(sessionFilePath)}.reset.`;
		const resetCandidates = (await fs.readdir(dir)).filter((name) => name.startsWith(resetPrefix)).toSorted();
		if (resetCandidates.length === 0) return primary;
		const latestResetPath = path.join(dir, resetCandidates[resetCandidates.length - 1]);
		const fallback = await getRecentSessionContent(latestResetPath, messageCount);
		if (fallback) log.debug("Loaded session content from reset fallback", {
			sessionFilePath,
			latestResetPath
		});
		return fallback || primary;
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
		const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
		const workspaceDir = cfg ? resolveAgentWorkspaceDir(cfg, agentId) : path.join(resolveStateDir(process.env, os.homedir), "workspace");
		const memoryDir = path.join(workspaceDir, "memory");
		await fs.mkdir(memoryDir, { recursive: true });
		const now = new Date(event.timestamp);
		const dateStr = now.toISOString().split("T")[0];
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
			slug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "").slice(0, 4);
			log.debug("Using fallback timestamp slug", { slug });
		}
		const filename = `${dateStr}-${slug}.md`;
		const memoryFilePath = path.join(memoryDir, filename);
		log.debug("Memory file path resolved", {
			filename,
			path: memoryFilePath.replace(os.homedir(), "~")
		});
		try {
			const extractScript = path.join(workspaceDir, "tools", "extract-memories.py");
			await fs.access(extractScript);
			const sessionId = currentSessionId || path.basename(sessionFile || "").replace(".jsonl", "");
			if (sessionId) {
				const { stdout } = await execAsync(`python3 "${extractScript}" --session "${sessionId}"`, {
					timeout: 12e4,
					cwd: workspaceDir
				});
				log.info("Structured extraction completed", {
					sessionId,
					stdout: stdout.slice(0, 200)
				});
				return;
			}
		} catch (extractErr) {
			log.warn("Structured extraction failed, falling back to raw excerpts", { error: extractErr instanceof Error ? extractErr.message : String(extractErr) });
		}
		const timeStr = now.toISOString().split("T")[1].split(".")[0];
		const sessionId = sessionEntry.sessionId || "unknown";
		const source = context.commandSource || "unknown";
		const entryParts = [
			`# Session: ${dateStr} ${timeStr} UTC`,
			"",
			`- **Session Key**: ${event.sessionKey}`,
			`- **Session ID**: ${sessionId}`,
			`- **Source**: ${source}`,
			""
		];
		if (sessionContent) entryParts.push("## Conversation Summary", "", sessionContent, "");
		const entry = entryParts.join("\n");
		await fs.writeFile(memoryFilePath, entry, "utf-8");
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