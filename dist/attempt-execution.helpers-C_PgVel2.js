import { a as isSilentReplyText, i as isSilentReplyPrefixText, n as SILENT_REPLY_TOKEN, o as startsWithSilentToken, s as stripLeadingSilentToken } from "./tokens-CFv3Qu_v.js";
import { n as readClaudeCliFallbackSeed } from "./cli-session-history-D7YDatc9.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import readline from "node:readline";
//#region src/agents/command/attempt-execution.helpers.ts
/** Maximum number of JSONL records to inspect before giving up. */
const SESSION_FILE_MAX_RECORDS = 500;
const CLAUDE_PROJECTS_RELATIVE_DIR = path.join(".claude", "projects");
function normalizeClaudeCliSessionId(sessionId) {
	const trimmed = sessionId?.trim();
	if (!trimmed || trimmed.includes("\0") || trimmed.includes("/") || trimmed.includes("\\")) return;
	return trimmed;
}
async function jsonlFileHasAssistantMessage(filePath) {
	if (!filePath) return false;
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink() || !stat.isFile()) return false;
		const fh = await fs.open(filePath, "r");
		try {
			const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf-8" }) });
			let recordCount = 0;
			for await (const line of rl) {
				if (!line.trim()) continue;
				recordCount++;
				if (recordCount > SESSION_FILE_MAX_RECORDS) break;
				let obj;
				try {
					obj = JSON.parse(line);
				} catch {
					continue;
				}
				if ((obj?.message)?.role === "assistant") return true;
			}
			return false;
		} finally {
			await fh.close();
		}
	} catch {
		return false;
	}
}
/**
* Check whether a session transcript file exists and contains at least one
* assistant message, indicating that the SessionManager has flushed the
* initial user+assistant exchange to disk.
*/
async function sessionFileHasContent(sessionFile) {
	return await jsonlFileHasAssistantMessage(sessionFile);
}
async function claudeCliSessionTranscriptHasContent(params) {
	const sessionId = normalizeClaudeCliSessionId(params.sessionId);
	if (!sessionId) return false;
	const homeDir = params.homeDir?.trim() || process.env.HOME || os.homedir();
	const projectsDir = path.join(homeDir, CLAUDE_PROJECTS_RELATIVE_DIR);
	let projectEntries;
	try {
		projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of projectEntries) {
		if (!entry.isDirectory()) continue;
		if (await jsonlFileHasAssistantMessage(path.join(projectsDir, entry.name, `${sessionId}.jsonl`))) return true;
	}
	return false;
}
function resolveFallbackRetryPrompt(params) {
	if (!params.isFallbackRetry) return params.body;
	const prelude = params.priorContextPrelude?.trim();
	if (!params.sessionHasHistory && !prelude) return params.body;
	const retryMarked = `[Retry after the previous model attempt failed or timed out]\n\n${params.body}`;
	return prelude ? `${prelude}\n\n${retryMarked}` : retryMarked;
}
const CLAUDE_CLI_FALLBACK_PRELUDE_DEFAULT_CHAR_BUDGET = 8e3;
const CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS = 64;
function extractFallbackTurnText(message) {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (!block || typeof block !== "object") continue;
		const rec = block;
		if (typeof rec.text === "string") {
			parts.push(rec.text);
			continue;
		}
		if (rec.type === "tool_use" && typeof rec.name === "string") {
			parts.push(`(tool call: ${rec.name})`);
			continue;
		}
		if (rec.type === "tool_result") {
			const inner = typeof rec.content === "string" ? rec.content : void 0;
			if (inner) parts.push(`(tool result: ${inner})`);
			else parts.push("(tool result)");
		}
	}
	return parts.join("\n").trim();
}
function formatFallbackTurns(turns, remainingBudget) {
	if (turns.length === 0 || remainingBudget <= 0) return {
		text: "",
		consumed: 0
	};
	const lines = [];
	let consumed = 0;
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turn = turns[i];
		if (!turn || typeof turn !== "object") continue;
		const role = turn.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractFallbackTurnText(turn);
		if (!text) continue;
		const line = `${role}: ${text}`;
		if (consumed + line.length + 1 > remainingBudget) break;
		lines.push(line);
		consumed += line.length + 1;
	}
	lines.reverse();
	return {
		text: lines.join("\n"),
		consumed
	};
}
/**
* Format a previously-harvested Claude CLI session into a labeled prelude
* suitable for prepending to a fallback candidate's prompt. Behavior matches
* Claude Code's own resume strategy after compaction: prefer the explicit
* summary, then append the most recent turns up to a char budget.
*
* Returns an empty string when neither a summary nor any usable turn fits in
* the budget; callers can treat that as "no context to seed".
*/
function formatClaudeCliFallbackPrelude(seed, options) {
	const charBudget = Math.max(CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS, options?.charBudget ?? CLAUDE_CLI_FALLBACK_PRELUDE_DEFAULT_CHAR_BUDGET);
	const sections = ["## Prior session context (from claude-cli)"];
	let remaining = charBudget - 42;
	if (seed.summaryText) {
		const summarySection = `\nSummary of earlier conversation:\n${seed.summaryText}`;
		if (summarySection.length <= remaining) {
			sections.push(summarySection);
			remaining -= summarySection.length;
		} else {
			const slice = seed.summaryText.slice(0, Math.max(0, remaining - 64));
			const lastBreak = slice.lastIndexOf(" ");
			const trimmed = lastBreak > 0 ? slice.slice(0, lastBreak).trimEnd() : slice.trimEnd();
			sections.push(`\nSummary of earlier conversation (truncated):\n${trimmed} …`);
			remaining = 0;
		}
	}
	if (remaining > CLAUDE_CLI_FALLBACK_PRELUDE_MIN_TURN_CHARS && seed.recentTurns.length > 0) {
		const { text } = formatFallbackTurns(seed.recentTurns, remaining - 32);
		if (text) sections.push(`\nRecent turns:\n${text}`);
	}
	if (sections.length === 1) return "";
	return sections.join("\n");
}
/**
* Read the Claude CLI session pointed to by `cliSessionId` and format a
* fallback prelude. Returns `""` when no session file is found or when the
* harvested seed has no usable content.
*/
function buildClaudeCliFallbackContextPrelude(params) {
	const sessionId = params.cliSessionId?.trim();
	if (!sessionId) return "";
	const seed = readClaudeCliFallbackSeed({
		cliSessionId: sessionId,
		homeDir: params.homeDir
	});
	if (!seed) return "";
	return formatClaudeCliFallbackPrelude(seed, { charBudget: params.charBudget });
}
function createAcpVisibleTextAccumulator() {
	let pendingSilentPrefix = "";
	let visibleText = "";
	let rawVisibleText = "";
	const startsWithWordChar = (chunk) => /^[\p{L}\p{N}]/u.test(chunk);
	const resolveNextCandidate = (base, chunk) => {
		if (!base) return chunk;
		if (isSilentReplyText(base, "NO_REPLY") && !chunk.startsWith(base) && startsWithWordChar(chunk)) return chunk;
		if (chunk.startsWith(base) && chunk.length > base.length) return chunk;
		return `${base}${chunk}`;
	};
	const mergeVisibleChunk = (base, chunk) => {
		if (!base) return {
			rawText: chunk,
			delta: chunk
		};
		if (chunk.startsWith(base) && chunk.length > base.length) return {
			rawText: chunk,
			delta: chunk.slice(base.length)
		};
		return {
			rawText: `${base}${chunk}`,
			delta: chunk
		};
	};
	return {
		consume(chunk) {
			if (!chunk) return null;
			if (!visibleText) {
				const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
				const trimmedLeadCandidate = leadCandidate.trim();
				if (isSilentReplyText(trimmedLeadCandidate, "NO_REPLY") || isSilentReplyPrefixText(trimmedLeadCandidate, "NO_REPLY")) {
					pendingSilentPrefix = leadCandidate;
					return null;
				}
				if (startsWithSilentToken(trimmedLeadCandidate, "NO_REPLY")) {
					const stripped = stripLeadingSilentToken(leadCandidate, SILENT_REPLY_TOKEN);
					if (stripped) {
						pendingSilentPrefix = "";
						rawVisibleText = leadCandidate;
						visibleText = stripped;
						return {
							text: stripped,
							delta: stripped
						};
					}
					pendingSilentPrefix = leadCandidate;
					return null;
				}
				if (pendingSilentPrefix) {
					pendingSilentPrefix = "";
					rawVisibleText = leadCandidate;
					visibleText = leadCandidate;
					return {
						text: visibleText,
						delta: leadCandidate
					};
				}
			}
			const nextVisible = mergeVisibleChunk(rawVisibleText, chunk);
			rawVisibleText = nextVisible.rawText;
			if (!nextVisible.delta) return null;
			visibleText = `${visibleText}${nextVisible.delta}`;
			return {
				text: visibleText,
				delta: nextVisible.delta
			};
		},
		finalize() {
			return visibleText.trim();
		},
		finalizeRaw() {
			return visibleText;
		}
	};
}
//#endregion
export { sessionFileHasContent as a, resolveFallbackRetryPrompt as i, claudeCliSessionTranscriptHasContent as n, createAcpVisibleTextAccumulator as r, buildClaudeCliFallbackContextPrelude as t };
