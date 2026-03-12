import "./paths-B4BZAPZh.js";
import { B as theme, S as shortenHomePath, y as resolveUserPath } from "./utils-BKDT474X.js";
import "./agent-scope-D8K2SjR7.js";
import { f as defaultRuntime } from "./subsystem-LTWJBEIv.js";
import "./openclaw-root-PhSD0wUu.js";
import "./exec-NrPPwdAe.js";
import { zt as loadConfig } from "./model-selection-DILdVnl8.js";
import "./github-copilot-token-nncItI8D.js";
import "./boolean-Wzu0-e0P.js";
import "./env-BqIeOdP-.js";
import "./host-env-security-lcjXF83D.js";
import { r as VERSION } from "./env-vars-Duxu9t5m.js";
import "./manifest-registry-BvFf4Q1K.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-C0KMGsnJ.js";
import { r as isKnownCoreToolId } from "./tool-catalog-BWgva5h1.js";
import "./ip-DK-vcRii.js";
import "./tailnet-kbXXH7kK.js";
import "./ws-zZ6eXqMi.js";
import { t as resolveGatewayCredentialsFromConfig } from "./credentials-xxcK5iF5.js";
import { t as GatewayClient } from "./client-xAUDLDK2.js";
import { t as buildGatewayConnectionDetails } from "./call-BP56BqJF.js";
import "./pairing-token-BdLe8Jtz.js";
import { t as formatDocsLink } from "./links-_OmPhBsv.js";
import { t as isMainModule } from "./is-main-5zOPZwgv.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-B0c7j49x.js";
import { t as DANGEROUS_ACP_TOOLS } from "./dangerous-tools-C7EgfHCY.js";
import { n as inheritOptionFromParent } from "./command-options-Duxj7LwL.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as readline$1 from "node:readline";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";

//#region src/acp/client.ts
const SAFE_AUTO_APPROVE_TOOL_IDS = new Set([
	"read",
	"search",
	"web_search",
	"memory_search"
]);
const TRUSTED_SAFE_TOOL_ALIASES = new Set(["search"]);
const READ_TOOL_PATH_KEYS = [
	"path",
	"file_path",
	"filePath"
];
const TOOL_NAME_MAX_LENGTH = 128;
const TOOL_NAME_PATTERN = /^[a-z0-9._-]+$/;
const TOOL_KIND_BY_ID = new Map([
	["read", "read"],
	["search", "search"],
	["web_search", "search"],
	["memory_search", "search"]
]);
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function readFirstStringValue(source, keys) {
	if (!source) return;
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
}
function normalizeToolName(value) {
	const normalized = value.trim().toLowerCase();
	if (!normalized || normalized.length > TOOL_NAME_MAX_LENGTH) return;
	if (!TOOL_NAME_PATTERN.test(normalized)) return;
	return normalized;
}
function parseToolNameFromTitle(title) {
	if (!title) return;
	const head = title.split(":", 1)[0]?.trim();
	if (!head) return;
	return normalizeToolName(head);
}
function resolveToolKindForPermission(toolName) {
	if (!toolName) return;
	return TOOL_KIND_BY_ID.get(toolName) ?? "other";
}
function resolveToolNameForPermission(params) {
	const toolCall = params.toolCall;
	const toolMeta = asRecord(toolCall?._meta);
	const rawInput = asRecord(toolCall?.rawInput);
	const fromMeta = readFirstStringValue(toolMeta, [
		"toolName",
		"tool_name",
		"name"
	]);
	const fromRawInput = readFirstStringValue(rawInput, [
		"tool",
		"toolName",
		"tool_name",
		"name"
	]);
	const fromTitle = parseToolNameFromTitle(toolCall?.title);
	return normalizeToolName(fromMeta ?? fromRawInput ?? fromTitle ?? "");
}
function extractPathFromToolTitle(toolTitle, toolName) {
	if (!toolTitle) return;
	const separator = toolTitle.indexOf(":");
	if (separator < 0) return;
	const tail = toolTitle.slice(separator + 1).trim();
	if (!tail) return;
	const keyedMatch = tail.match(/(?:^|,\s*)(?:path|file_path|filePath)\s*:\s*([^,]+)/);
	if (keyedMatch?.[1]) return keyedMatch[1].trim();
	if (toolName === "read") return tail;
}
function resolveToolPathCandidate(params, toolName, toolTitle) {
	const fromRawInput = readFirstStringValue(asRecord(params.toolCall?.rawInput), READ_TOOL_PATH_KEYS);
	const fromTitle = extractPathFromToolTitle(toolTitle, toolName);
	return fromRawInput ?? fromTitle;
}
function resolveAbsoluteScopedPath(value, cwd) {
	let candidate = value.trim();
	if (!candidate) return;
	if (candidate.startsWith("file://")) try {
		const parsed = new URL(candidate);
		candidate = decodeURIComponent(parsed.pathname || "");
	} catch {
		return;
	}
	if (candidate === "~") candidate = homedir();
	else if (candidate.startsWith("~/")) candidate = path.join(homedir(), candidate.slice(2));
	return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
}
function isPathWithinRoot(candidatePath, root) {
	const relative = path.relative(root, candidatePath);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function isReadToolCallScopedToCwd(params, toolName, toolTitle, cwd) {
	if (toolName !== "read") return false;
	const rawPath = resolveToolPathCandidate(params, toolName, toolTitle);
	if (!rawPath) return false;
	const absolutePath = resolveAbsoluteScopedPath(rawPath, cwd);
	if (!absolutePath) return false;
	return isPathWithinRoot(absolutePath, path.resolve(cwd));
}
function shouldAutoApproveToolCall(params, toolName, toolTitle, cwd) {
	const isTrustedToolId = typeof toolName === "string" && (isKnownCoreToolId(toolName) || TRUSTED_SAFE_TOOL_ALIASES.has(toolName));
	if (!toolName || !isTrustedToolId || !SAFE_AUTO_APPROVE_TOOL_IDS.has(toolName)) return false;
	if (toolName === "read") return isReadToolCallScopedToCwd(params, toolName, toolTitle, cwd);
	return true;
}
function pickOption(options, kinds) {
	for (const kind of kinds) {
		const match = options.find((option) => option.kind === kind);
		if (match) return match;
	}
}
function selectedPermission(optionId) {
	return { outcome: {
		outcome: "selected",
		optionId
	} };
}
function cancelledPermission() {
	return { outcome: { outcome: "cancelled" } };
}
function promptUserPermission(toolName, toolTitle) {
	if (!process.stdin.isTTY || !process.stderr.isTTY) {
		console.error(`[permission denied] ${toolName ?? "unknown"}: non-interactive terminal`);
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		let settled = false;
		const rl = readline$1.createInterface({
			input: process.stdin,
			output: process.stderr
		});
		const finish = (approved) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			rl.close();
			resolve(approved);
		};
		const timeout = setTimeout(() => {
			console.error(`\n[permission timeout] denied: ${toolName ?? "unknown"}`);
			finish(false);
		}, 3e4);
		const label = toolTitle ? toolName ? `${toolTitle} (${toolName})` : toolTitle : toolName ?? "unknown tool";
		rl.question(`\n[permission] Allow "${label}"? (y/N) `, (answer) => {
			const approved = answer.trim().toLowerCase() === "y";
			console.error(`[permission ${approved ? "approved" : "denied"}] ${toolName ?? "unknown"}`);
			finish(approved);
		});
	});
}
async function resolvePermissionRequest(params, deps = {}) {
	const log = deps.log ?? ((line) => console.error(line));
	const prompt = deps.prompt ?? promptUserPermission;
	const cwd = deps.cwd ?? process.cwd();
	const options = params.options ?? [];
	const toolTitle = params.toolCall?.title ?? "tool";
	const toolName = resolveToolNameForPermission(params);
	const toolKind = resolveToolKindForPermission(toolName);
	if (options.length === 0) {
		log(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
		return cancelledPermission();
	}
	const allowOption = pickOption(options, ["allow_once", "allow_always"]);
	const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
	const autoApproveAllowed = shouldAutoApproveToolCall(params, toolName, toolTitle, cwd);
	if (!(!toolName || !autoApproveAllowed || DANGEROUS_ACP_TOOLS.has(toolName))) {
		const option = allowOption ?? options[0];
		if (!option) {
			log(`[permission cancelled] ${toolName}: no selectable options`);
			return cancelledPermission();
		}
		log(`[permission auto-approved] ${toolName} (${toolKind ?? "unknown"})`);
		return selectedPermission(option.optionId);
	}
	log(`\n[permission requested] ${toolTitle}${toolName ? ` (${toolName})` : ""}${toolKind ? ` [${toolKind}]` : ""}`);
	const approved = await prompt(toolName, toolTitle);
	if (approved && allowOption) return selectedPermission(allowOption.optionId);
	if (!approved && rejectOption) return selectedPermission(rejectOption.optionId);
	log(`[permission cancelled] ${toolName ?? "unknown"}: missing ${approved ? "allow" : "reject"} option`);
	return cancelledPermission();
}
function toArgs(value) {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}
function buildServerArgs(opts) {
	const args = ["acp", ...toArgs(opts.serverArgs)];
	if (opts.serverVerbose && !args.includes("--verbose") && !args.includes("-v")) args.push("--verbose");
	return args;
}
function resolveSelfEntryPath() {
	try {
		const here = fileURLToPath(import.meta.url);
		const candidate = path.resolve(path.dirname(here), "..", "entry.js");
		if (fs.existsSync(candidate)) return candidate;
	} catch {}
	const argv1 = process.argv[1]?.trim();
	if (argv1) return path.isAbsolute(argv1) ? argv1 : path.resolve(process.cwd(), argv1);
	return null;
}
function printSessionUpdate(notification) {
	const update = notification.update;
	if (!("sessionUpdate" in update)) return;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			if (update.content?.type === "text") process.stdout.write(update.content.text);
			return;
		case "tool_call":
			console.log(`\n[tool] ${update.title} (${update.status})`);
			return;
		case "tool_call_update":
			if (update.status) console.log(`[tool update] ${update.toolCallId}: ${update.status}`);
			return;
		case "available_commands_update": {
			const names = update.availableCommands?.map((cmd) => `/${cmd.name}`).join(" ");
			if (names) console.log(`\n[commands] ${names}`);
			return;
		}
		default: return;
	}
}
async function createAcpClient(opts = {}) {
	const cwd = opts.cwd ?? process.cwd();
	const log = Boolean(opts.verbose) ? (msg) => console.error(`[acp-client] ${msg}`) : () => {};
	ensureOpenClawCliOnPath();
	const serverArgs = buildServerArgs(opts);
	const entryPath = resolveSelfEntryPath();
	const serverCommand = opts.serverCommand ?? (entryPath ? process.execPath : "openclaw");
	const effectiveArgs = opts.serverCommand || !entryPath ? serverArgs : [entryPath, ...serverArgs];
	log(`spawning: ${serverCommand} ${effectiveArgs.join(" ")}`);
	const agent = spawn(serverCommand, effectiveArgs, {
		stdio: [
			"pipe",
			"pipe",
			"inherit"
		],
		cwd
	});
	if (!agent.stdin || !agent.stdout) throw new Error("Failed to create ACP stdio pipes");
	const client = new ClientSideConnection(() => ({
		sessionUpdate: async (params) => {
			printSessionUpdate(params);
		},
		requestPermission: async (params) => {
			return resolvePermissionRequest(params, { cwd });
		}
	}), ndJsonStream(Writable.toWeb(agent.stdin), Readable.toWeb(agent.stdout)));
	log("initializing");
	await client.initialize({
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: {
			fs: {
				readTextFile: true,
				writeTextFile: true
			},
			terminal: true
		},
		clientInfo: {
			name: "openclaw-acp-client",
			version: "1.0.0"
		}
	});
	log("creating session");
	return {
		client,
		agent,
		sessionId: (await client.newSession({
			cwd,
			mcpServers: []
		})).sessionId
	};
}
async function runAcpClientInteractive(opts = {}) {
	const { client, agent, sessionId } = await createAcpClient(opts);
	const rl = readline$1.createInterface({
		input: process.stdin,
		output: process.stdout
	});
	console.log("OpenClaw ACP client");
	console.log(`Session: ${sessionId}`);
	console.log("Type a prompt, or \"exit\" to quit.\n");
	const prompt = () => {
		rl.question("> ", async (input) => {
			const text = input.trim();
			if (!text) {
				prompt();
				return;
			}
			if (text === "exit" || text === "quit") {
				agent.kill();
				rl.close();
				process.exit(0);
			}
			try {
				const response = await client.prompt({
					sessionId,
					prompt: [{
						type: "text",
						text
					}]
				});
				console.log(`\n[${response.stopReason}]\n`);
			} catch (err) {
				console.error(`\n[error] ${String(err)}\n`);
			}
			prompt();
		});
	};
	prompt();
	agent.on("exit", (code) => {
		console.log(`\nAgent exited with code ${code ?? 0}`);
		rl.close();
		process.exit(code ?? 0);
	});
}

//#endregion
//#region src/acp/secret-file.ts
function readSecretFromFile(filePath, label) {
	const resolvedPath = resolveUserPath(filePath.trim());
	if (!resolvedPath) throw new Error(`${label} file path is empty.`);
	let raw = "";
	try {
		raw = fs.readFileSync(resolvedPath, "utf8");
	} catch (err) {
		throw new Error(`Failed to read ${label} file at ${resolvedPath}: ${String(err)}`, { cause: err });
	}
	const secret = raw.trim();
	if (!secret) throw new Error(`${label} file at ${resolvedPath} is empty.`);
	return secret;
}

//#endregion
//#region src/infra/fixed-window-rate-limit.ts
function createFixedWindowRateLimiter(params) {
	const maxRequests = Math.max(1, Math.floor(params.maxRequests));
	const windowMs = Math.max(1, Math.floor(params.windowMs));
	const now = params.now ?? Date.now;
	let count = 0;
	let windowStartMs = 0;
	return {
		consume() {
			const nowMs = now();
			if (nowMs - windowStartMs >= windowMs) {
				windowStartMs = nowMs;
				count = 0;
			}
			if (count >= maxRequests) return {
				allowed: false,
				retryAfterMs: Math.max(0, windowStartMs + windowMs - nowMs),
				remaining: 0
			};
			count += 1;
			return {
				allowed: true,
				retryAfterMs: 0,
				remaining: Math.max(0, maxRequests - count)
			};
		},
		reset() {
			count = 0;
			windowStartMs = 0;
		}
	};
}

//#endregion
//#region src/acp/commands.ts
function getAvailableCommands() {
	return [
		{
			name: "help",
			description: "Show help and common commands."
		},
		{
			name: "commands",
			description: "List available commands."
		},
		{
			name: "status",
			description: "Show current status."
		},
		{
			name: "context",
			description: "Explain context usage (list|detail|json).",
			input: { hint: "list | detail | json" }
		},
		{
			name: "whoami",
			description: "Show sender id (alias: /id)."
		},
		{
			name: "id",
			description: "Alias for /whoami."
		},
		{
			name: "subagents",
			description: "List or manage sub-agents."
		},
		{
			name: "config",
			description: "Read or write config (owner-only)."
		},
		{
			name: "debug",
			description: "Set runtime-only overrides (owner-only)."
		},
		{
			name: "usage",
			description: "Toggle usage footer (off|tokens|full)."
		},
		{
			name: "stop",
			description: "Stop the current run."
		},
		{
			name: "restart",
			description: "Restart the gateway (if enabled)."
		},
		{
			name: "dock-telegram",
			description: "Route replies to Telegram."
		},
		{
			name: "dock-discord",
			description: "Route replies to Discord."
		},
		{
			name: "dock-slack",
			description: "Route replies to Slack."
		},
		{
			name: "activation",
			description: "Set group activation (mention|always)."
		},
		{
			name: "send",
			description: "Set send mode (on|off|inherit)."
		},
		{
			name: "reset",
			description: "Reset the session (/new)."
		},
		{
			name: "new",
			description: "Reset the session (/reset)."
		},
		{
			name: "think",
			description: "Set thinking level (off|minimal|low|medium|high|xhigh)."
		},
		{
			name: "verbose",
			description: "Set verbose mode (on|full|off)."
		},
		{
			name: "reasoning",
			description: "Toggle reasoning output (on|off|stream)."
		},
		{
			name: "elevated",
			description: "Toggle elevated mode (on|off)."
		},
		{
			name: "model",
			description: "Select a model (list|status|<name>)."
		},
		{
			name: "queue",
			description: "Adjust queue mode and options."
		},
		{
			name: "bash",
			description: "Run a host command (if enabled)."
		},
		{
			name: "compact",
			description: "Compact the session history."
		}
	];
}

//#endregion
//#region src/acp/event-mapper.ts
const INLINE_CONTROL_ESCAPE_MAP = {
	"\0": "\\0",
	"\r": "\\r",
	"\n": "\\n",
	"	": "\\t",
	"\v": "\\v",
	"\f": "\\f",
	"\u2028": "\\u2028",
	"\u2029": "\\u2029"
};
function escapeInlineControlChars(value) {
	let escaped = "";
	for (const char of value) {
		const codePoint = char.codePointAt(0);
		if (codePoint === void 0) {
			escaped += char;
			continue;
		}
		if (!(codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint === 8232 || codePoint === 8233)) {
			escaped += char;
			continue;
		}
		const mapped = INLINE_CONTROL_ESCAPE_MAP[char];
		if (mapped) {
			escaped += mapped;
			continue;
		}
		escaped += codePoint <= 255 ? `\\x${codePoint.toString(16).padStart(2, "0")}` : `\\u${codePoint.toString(16).padStart(4, "0")}`;
	}
	return escaped;
}
function escapeResourceTitle(value) {
	return escapeInlineControlChars(value).replace(/[()[\]]/g, (char) => `\\${char}`);
}
function extractTextFromPrompt(prompt, maxBytes) {
	const parts = [];
	let totalBytes = 0;
	for (const block of prompt) {
		let blockText;
		if (block.type === "text") blockText = block.text;
		else if (block.type === "resource") {
			const resource = block.resource;
			if (resource?.text) blockText = resource.text;
		} else if (block.type === "resource_link") {
			const title = block.title ? ` (${escapeResourceTitle(block.title)})` : "";
			const uri = block.uri ? escapeInlineControlChars(block.uri) : "";
			blockText = uri ? `[Resource link${title}] ${uri}` : `[Resource link${title}]`;
		}
		if (blockText !== void 0) {
			if (maxBytes !== void 0) {
				const separatorBytes = parts.length > 0 ? 1 : 0;
				totalBytes += separatorBytes + Buffer.byteLength(blockText, "utf-8");
				if (totalBytes > maxBytes) throw new Error(`Prompt exceeds maximum allowed size of ${maxBytes} bytes`);
			}
			parts.push(blockText);
		}
	}
	return parts.join("\n");
}
function extractAttachmentsFromPrompt(prompt) {
	const attachments = [];
	for (const block of prompt) {
		if (block.type !== "image") continue;
		const image = block;
		if (!image.data || !image.mimeType) continue;
		attachments.push({
			type: "image",
			mimeType: image.mimeType,
			content: image.data
		});
	}
	return attachments;
}
function formatToolTitle(name, args) {
	const base = name ?? "tool";
	if (!args || Object.keys(args).length === 0) return base;
	return `${base}: ${Object.entries(args).map(([key, value]) => {
		const raw = typeof value === "string" ? value : JSON.stringify(value);
		return `${key}: ${raw.length > 100 ? `${raw.slice(0, 100)}...` : raw}`;
	}).join(", ")}`;
}
function inferToolKind(name) {
	if (!name) return "other";
	const normalized = name.toLowerCase();
	if (normalized.includes("read")) return "read";
	if (normalized.includes("write") || normalized.includes("edit")) return "edit";
	if (normalized.includes("delete") || normalized.includes("remove")) return "delete";
	if (normalized.includes("move") || normalized.includes("rename")) return "move";
	if (normalized.includes("search") || normalized.includes("find")) return "search";
	if (normalized.includes("exec") || normalized.includes("run") || normalized.includes("bash")) return "execute";
	if (normalized.includes("fetch") || normalized.includes("http")) return "fetch";
	return "other";
}

//#endregion
//#region src/acp/meta.ts
function readString(meta, keys) {
	if (!meta) return;
	for (const key of keys) {
		const value = meta[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
}
function readBool(meta, keys) {
	if (!meta) return;
	for (const key of keys) {
		const value = meta[key];
		if (typeof value === "boolean") return value;
	}
}
function readNumber(meta, keys) {
	if (!meta) return;
	for (const key of keys) {
		const value = meta[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
}

//#endregion
//#region src/acp/session-mapper.ts
function parseSessionMeta(meta) {
	if (!meta || typeof meta !== "object") return {};
	const record = meta;
	return {
		sessionKey: readString(record, [
			"sessionKey",
			"session",
			"key"
		]),
		sessionLabel: readString(record, ["sessionLabel", "label"]),
		resetSession: readBool(record, ["resetSession", "reset"]),
		requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
		prefixCwd: readBool(record, ["prefixCwd"])
	};
}
async function resolveSessionKey(params) {
	const requestedLabel = params.meta.sessionLabel ?? params.opts.defaultSessionLabel;
	const requestedKey = params.meta.sessionKey ?? params.opts.defaultSessionKey;
	const requireExisting = params.meta.requireExisting ?? params.opts.requireExistingSession ?? false;
	if (params.meta.sessionLabel) {
		const resolved = await params.gateway.request("sessions.resolve", { label: params.meta.sessionLabel });
		if (!resolved?.key) throw new Error(`Unable to resolve session label: ${params.meta.sessionLabel}`);
		return resolved.key;
	}
	if (params.meta.sessionKey) {
		if (!requireExisting) return params.meta.sessionKey;
		const resolved = await params.gateway.request("sessions.resolve", { key: params.meta.sessionKey });
		if (!resolved?.key) throw new Error(`Session key not found: ${params.meta.sessionKey}`);
		return resolved.key;
	}
	if (requestedLabel) {
		const resolved = await params.gateway.request("sessions.resolve", { label: requestedLabel });
		if (!resolved?.key) throw new Error(`Unable to resolve session label: ${requestedLabel}`);
		return resolved.key;
	}
	if (requestedKey) {
		if (!requireExisting) return requestedKey;
		const resolved = await params.gateway.request("sessions.resolve", { key: requestedKey });
		if (!resolved?.key) throw new Error(`Session key not found: ${requestedKey}`);
		return resolved.key;
	}
	return params.fallbackKey;
}
async function resetSessionIfNeeded(params) {
	if (!(params.meta.resetSession ?? params.opts.resetSession ?? false)) return;
	await params.gateway.request("sessions.reset", { key: params.sessionKey });
}

//#endregion
//#region src/acp/session.ts
const DEFAULT_MAX_SESSIONS = 5e3;
const DEFAULT_IDLE_TTL_MS = 1440 * 60 * 1e3;
function createInMemorySessionStore(options = {}) {
	const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
	const idleTtlMs = Math.max(1e3, options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
	const now = options.now ?? Date.now;
	const sessions = /* @__PURE__ */ new Map();
	const runIdToSessionId = /* @__PURE__ */ new Map();
	const touchSession = (session, nowMs) => {
		session.lastTouchedAt = nowMs;
	};
	const removeSession = (sessionId) => {
		const session = sessions.get(sessionId);
		if (!session) return false;
		if (session.activeRunId) runIdToSessionId.delete(session.activeRunId);
		session.abortController?.abort();
		sessions.delete(sessionId);
		return true;
	};
	const reapIdleSessions = (nowMs) => {
		const idleBefore = nowMs - idleTtlMs;
		for (const [sessionId, session] of sessions.entries()) {
			if (session.activeRunId || session.abortController) continue;
			if (session.lastTouchedAt > idleBefore) continue;
			removeSession(sessionId);
		}
	};
	const evictOldestIdleSession = () => {
		let oldestSessionId = null;
		let oldestLastTouchedAt = Number.POSITIVE_INFINITY;
		for (const [sessionId, session] of sessions.entries()) {
			if (session.activeRunId || session.abortController) continue;
			if (session.lastTouchedAt >= oldestLastTouchedAt) continue;
			oldestLastTouchedAt = session.lastTouchedAt;
			oldestSessionId = sessionId;
		}
		if (!oldestSessionId) return false;
		return removeSession(oldestSessionId);
	};
	const createSession = (params) => {
		const nowMs = now();
		const sessionId = params.sessionId ?? randomUUID();
		const existingSession = sessions.get(sessionId);
		if (existingSession) {
			existingSession.sessionKey = params.sessionKey;
			existingSession.cwd = params.cwd;
			touchSession(existingSession, nowMs);
			return existingSession;
		}
		reapIdleSessions(nowMs);
		if (sessions.size >= maxSessions && !evictOldestIdleSession()) throw new Error(`ACP session limit reached (max ${maxSessions}). Close idle ACP clients and retry.`);
		const session = {
			sessionId,
			sessionKey: params.sessionKey,
			cwd: params.cwd,
			createdAt: nowMs,
			lastTouchedAt: nowMs,
			abortController: null,
			activeRunId: null
		};
		sessions.set(sessionId, session);
		return session;
	};
	const hasSession = (sessionId) => sessions.has(sessionId);
	const getSession = (sessionId) => {
		const session = sessions.get(sessionId);
		if (session) touchSession(session, now());
		return session;
	};
	const getSessionByRunId = (runId) => {
		const sessionId = runIdToSessionId.get(runId);
		if (!sessionId) return;
		const session = sessions.get(sessionId);
		if (session) touchSession(session, now());
		return session;
	};
	const setActiveRun = (sessionId, runId, abortController) => {
		const session = sessions.get(sessionId);
		if (!session) return;
		session.activeRunId = runId;
		session.abortController = abortController;
		runIdToSessionId.set(runId, sessionId);
		touchSession(session, now());
	};
	const clearActiveRun = (sessionId) => {
		const session = sessions.get(sessionId);
		if (!session) return;
		if (session.activeRunId) runIdToSessionId.delete(session.activeRunId);
		session.activeRunId = null;
		session.abortController = null;
		touchSession(session, now());
	};
	const cancelActiveRun = (sessionId) => {
		const session = sessions.get(sessionId);
		if (!session?.abortController) return false;
		session.abortController.abort();
		if (session.activeRunId) runIdToSessionId.delete(session.activeRunId);
		session.abortController = null;
		session.activeRunId = null;
		touchSession(session, now());
		return true;
	};
	const clearAllSessionsForTest = () => {
		for (const session of sessions.values()) session.abortController?.abort();
		sessions.clear();
		runIdToSessionId.clear();
	};
	return {
		createSession,
		hasSession,
		getSession,
		getSessionByRunId,
		setActiveRun,
		clearActiveRun,
		cancelActiveRun,
		clearAllSessionsForTest
	};
}
const defaultAcpSessionStore = createInMemorySessionStore();

//#endregion
//#region src/acp/types.ts
const ACP_AGENT_INFO = {
	name: "openclaw-acp",
	title: "OpenClaw ACP Gateway",
	version: VERSION
};

//#endregion
//#region src/acp/translator.ts
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 1e4;
var AcpGatewayAgent = class {
	constructor(connection, gateway, opts = {}) {
		this.pendingPrompts = /* @__PURE__ */ new Map();
		this.connection = connection;
		this.gateway = gateway;
		this.opts = opts;
		this.log = opts.verbose ? (msg) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
		this.sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
		this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
			maxRequests: Math.max(1, opts.sessionCreateRateLimit?.maxRequests ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS),
			windowMs: Math.max(1e3, opts.sessionCreateRateLimit?.windowMs ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS)
		});
	}
	start() {
		this.log("ready");
	}
	handleGatewayReconnect() {
		this.log("gateway reconnected");
	}
	handleGatewayDisconnect(reason) {
		this.log(`gateway disconnected: ${reason}`);
		for (const pending of this.pendingPrompts.values()) {
			pending.reject(/* @__PURE__ */ new Error(`Gateway disconnected: ${reason}`));
			this.sessionStore.clearActiveRun(pending.sessionId);
		}
		this.pendingPrompts.clear();
	}
	async handleGatewayEvent(evt) {
		if (evt.event === "chat") {
			await this.handleChatEvent(evt);
			return;
		}
		if (evt.event === "agent") await this.handleAgentEvent(evt);
	}
	async initialize(_params) {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: {
					image: true,
					audio: false,
					embeddedContext: true
				},
				mcpCapabilities: {
					http: false,
					sse: false
				},
				sessionCapabilities: { list: {} }
			},
			agentInfo: ACP_AGENT_INFO,
			authMethods: []
		};
	}
	async newSession(params) {
		if (params.mcpServers.length > 0) this.log(`ignoring ${params.mcpServers.length} MCP servers`);
		this.enforceSessionCreateRateLimit("newSession");
		const sessionId = randomUUID();
		const meta = parseSessionMeta(params._meta);
		const sessionKey = await resolveSessionKey({
			meta,
			fallbackKey: `acp:${sessionId}`,
			gateway: this.gateway,
			opts: this.opts
		});
		await resetSessionIfNeeded({
			meta,
			sessionKey,
			gateway: this.gateway,
			opts: this.opts
		});
		const session = this.sessionStore.createSession({
			sessionId,
			sessionKey,
			cwd: params.cwd
		});
		this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
		await this.sendAvailableCommands(session.sessionId);
		return { sessionId: session.sessionId };
	}
	async loadSession(params) {
		if (params.mcpServers.length > 0) this.log(`ignoring ${params.mcpServers.length} MCP servers`);
		if (!this.sessionStore.hasSession(params.sessionId)) this.enforceSessionCreateRateLimit("loadSession");
		const meta = parseSessionMeta(params._meta);
		const sessionKey = await resolveSessionKey({
			meta,
			fallbackKey: params.sessionId,
			gateway: this.gateway,
			opts: this.opts
		});
		await resetSessionIfNeeded({
			meta,
			sessionKey,
			gateway: this.gateway,
			opts: this.opts
		});
		const session = this.sessionStore.createSession({
			sessionId: params.sessionId,
			sessionKey,
			cwd: params.cwd
		});
		this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
		await this.sendAvailableCommands(session.sessionId);
		return {};
	}
	async unstable_listSessions(params) {
		const limit = readNumber(params._meta, ["limit"]) ?? 100;
		const result = await this.gateway.request("sessions.list", { limit });
		const cwd = params.cwd ?? process.cwd();
		return {
			sessions: result.sessions.map((session) => ({
				sessionId: session.key,
				cwd,
				title: session.displayName ?? session.label ?? session.key,
				updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : void 0,
				_meta: {
					sessionKey: session.key,
					kind: session.kind,
					channel: session.channel
				}
			})),
			nextCursor: null
		};
	}
	async authenticate(_params) {
		return {};
	}
	async setSessionMode(params) {
		const session = this.sessionStore.getSession(params.sessionId);
		if (!session) throw new Error(`Session ${params.sessionId} not found`);
		if (!params.modeId) return {};
		try {
			await this.gateway.request("sessions.patch", {
				key: session.sessionKey,
				thinkingLevel: params.modeId
			});
			this.log(`setSessionMode: ${session.sessionId} -> ${params.modeId}`);
		} catch (err) {
			this.log(`setSessionMode error: ${String(err)}`);
		}
		return {};
	}
	async prompt(params) {
		const session = this.sessionStore.getSession(params.sessionId);
		if (!session) throw new Error(`Session ${params.sessionId} not found`);
		if (session.abortController) this.sessionStore.cancelActiveRun(params.sessionId);
		const meta = parseSessionMeta(params._meta);
		const userText = extractTextFromPrompt(params.prompt, MAX_PROMPT_BYTES);
		const attachments = extractAttachmentsFromPrompt(params.prompt);
		const prefixCwd = meta.prefixCwd ?? this.opts.prefixCwd ?? true;
		const displayCwd = shortenHomePath(session.cwd);
		const message = prefixCwd ? `[Working directory: ${displayCwd}]\n\n${userText}` : userText;
		if (Buffer.byteLength(message, "utf-8") > MAX_PROMPT_BYTES) throw new Error(`Prompt exceeds maximum allowed size of ${MAX_PROMPT_BYTES} bytes`);
		const abortController = new AbortController();
		const runId = randomUUID();
		this.sessionStore.setActiveRun(params.sessionId, runId, abortController);
		return new Promise((resolve, reject) => {
			this.pendingPrompts.set(params.sessionId, {
				sessionId: params.sessionId,
				sessionKey: session.sessionKey,
				idempotencyKey: runId,
				resolve,
				reject
			});
			this.gateway.request("chat.send", {
				sessionKey: session.sessionKey,
				message,
				attachments: attachments.length > 0 ? attachments : void 0,
				idempotencyKey: runId,
				thinking: readString(params._meta, ["thinking", "thinkingLevel"]),
				deliver: readBool(params._meta, ["deliver"]),
				timeoutMs: readNumber(params._meta, ["timeoutMs"])
			}, { expectFinal: true }).catch((err) => {
				this.pendingPrompts.delete(params.sessionId);
				this.sessionStore.clearActiveRun(params.sessionId);
				reject(err instanceof Error ? err : new Error(String(err)));
			});
		});
	}
	async cancel(params) {
		const session = this.sessionStore.getSession(params.sessionId);
		if (!session) return;
		this.sessionStore.cancelActiveRun(params.sessionId);
		try {
			await this.gateway.request("chat.abort", { sessionKey: session.sessionKey });
		} catch (err) {
			this.log(`cancel error: ${String(err)}`);
		}
		const pending = this.pendingPrompts.get(params.sessionId);
		if (pending) {
			this.pendingPrompts.delete(params.sessionId);
			pending.resolve({ stopReason: "cancelled" });
		}
	}
	async handleAgentEvent(evt) {
		const payload = evt.payload;
		if (!payload) return;
		const stream = payload.stream;
		const data = payload.data;
		const sessionKey = payload.sessionKey;
		if (!stream || !data || !sessionKey) return;
		if (stream !== "tool") return;
		const phase = data.phase;
		const name = data.name;
		const toolCallId = data.toolCallId;
		if (!toolCallId) return;
		const pending = this.findPendingBySessionKey(sessionKey);
		if (!pending) return;
		if (phase === "start") {
			if (!pending.toolCalls) pending.toolCalls = /* @__PURE__ */ new Set();
			if (pending.toolCalls.has(toolCallId)) return;
			pending.toolCalls.add(toolCallId);
			const args = data.args;
			await this.connection.sessionUpdate({
				sessionId: pending.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId,
					title: formatToolTitle(name, args),
					status: "in_progress",
					rawInput: args,
					kind: inferToolKind(name)
				}
			});
			return;
		}
		if (phase === "result") {
			const isError = Boolean(data.isError);
			await this.connection.sessionUpdate({
				sessionId: pending.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: isError ? "failed" : "completed",
					rawOutput: data.result
				}
			});
		}
	}
	async handleChatEvent(evt) {
		const payload = evt.payload;
		if (!payload) return;
		const sessionKey = payload.sessionKey;
		const state = payload.state;
		const runId = payload.runId;
		const messageData = payload.message;
		if (!sessionKey || !state) return;
		const pending = this.findPendingBySessionKey(sessionKey);
		if (!pending) return;
		if (runId && pending.idempotencyKey !== runId) return;
		if (state === "delta" && messageData) {
			await this.handleDeltaEvent(pending.sessionId, messageData);
			return;
		}
		if (state === "final") {
			this.finishPrompt(pending.sessionId, pending, "end_turn");
			return;
		}
		if (state === "aborted") {
			this.finishPrompt(pending.sessionId, pending, "cancelled");
			return;
		}
		if (state === "error") this.finishPrompt(pending.sessionId, pending, "refusal");
	}
	async handleDeltaEvent(sessionId, messageData) {
		const fullText = messageData.content?.find((c) => c.type === "text")?.text ?? "";
		const pending = this.pendingPrompts.get(sessionId);
		if (!pending) return;
		const sentSoFar = pending.sentTextLength ?? 0;
		if (fullText.length <= sentSoFar) return;
		const newText = fullText.slice(sentSoFar);
		pending.sentTextLength = fullText.length;
		pending.sentText = fullText;
		await this.connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: newText
				}
			}
		});
	}
	finishPrompt(sessionId, pending, stopReason) {
		this.pendingPrompts.delete(sessionId);
		this.sessionStore.clearActiveRun(sessionId);
		pending.resolve({ stopReason });
	}
	findPendingBySessionKey(sessionKey) {
		for (const pending of this.pendingPrompts.values()) if (pending.sessionKey === sessionKey) return pending;
	}
	async sendAvailableCommands(sessionId) {
		await this.connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: getAvailableCommands()
			}
		});
	}
	enforceSessionCreateRateLimit(method) {
		const budget = this.sessionCreateRateLimiter.consume();
		if (budget.allowed) return;
		throw new Error(`ACP session creation rate limit exceeded for ${method}; retry after ${Math.ceil(budget.retryAfterMs / 1e3)}s.`);
	}
};

//#endregion
//#region src/acp/server.ts
async function serveAcpGateway(opts = {}) {
	const cfg = loadConfig();
	const connection = buildGatewayConnectionDetails({
		config: cfg,
		url: opts.gatewayUrl
	});
	const creds = resolveGatewayCredentialsFromConfig({
		cfg,
		env: process.env,
		explicitAuth: {
			token: opts.gatewayToken,
			password: opts.gatewayPassword
		}
	});
	let agent = null;
	let onClosed;
	const closed = new Promise((resolve) => {
		onClosed = resolve;
	});
	let stopped = false;
	let onGatewayReadyResolve;
	let onGatewayReadyReject;
	let gatewayReadySettled = false;
	const gatewayReady = new Promise((resolve, reject) => {
		onGatewayReadyResolve = resolve;
		onGatewayReadyReject = reject;
	});
	const resolveGatewayReady = () => {
		if (gatewayReadySettled) return;
		gatewayReadySettled = true;
		onGatewayReadyResolve();
	};
	const rejectGatewayReady = (err) => {
		if (gatewayReadySettled) return;
		gatewayReadySettled = true;
		onGatewayReadyReject(err instanceof Error ? err : new Error(String(err)));
	};
	const gateway = new GatewayClient({
		url: connection.url,
		token: creds.token,
		password: creds.password,
		clientName: GATEWAY_CLIENT_NAMES.CLI,
		clientDisplayName: "ACP",
		clientVersion: "acp",
		mode: GATEWAY_CLIENT_MODES.CLI,
		onEvent: (evt) => {
			agent?.handleGatewayEvent(evt);
		},
		onHelloOk: () => {
			resolveGatewayReady();
			agent?.handleGatewayReconnect();
		},
		onConnectError: (err) => {
			rejectGatewayReady(err);
		},
		onClose: (code, reason) => {
			if (!stopped) rejectGatewayReady(/* @__PURE__ */ new Error(`gateway closed before ready (${code}): ${reason}`));
			agent?.handleGatewayDisconnect(`${code}: ${reason}`);
			if (stopped) onClosed();
		}
	});
	const shutdown = () => {
		if (stopped) return;
		stopped = true;
		resolveGatewayReady();
		gateway.stop();
		onClosed();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	gateway.start();
	await gatewayReady.catch((err) => {
		shutdown();
		throw err;
	});
	if (stopped) return closed;
	new AgentSideConnection((conn) => {
		agent = new AcpGatewayAgent(conn, gateway, opts);
		agent.start();
		return agent;
	}, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
	return closed;
}
function parseArgs(args) {
	const opts = {};
	let tokenFile;
	let passwordFile;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--url" || arg === "--gateway-url") {
			opts.gatewayUrl = args[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--token" || arg === "--gateway-token") {
			opts.gatewayToken = args[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--token-file" || arg === "--gateway-token-file") {
			tokenFile = args[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--password" || arg === "--gateway-password") {
			opts.gatewayPassword = args[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--password-file" || arg === "--gateway-password-file") {
			passwordFile = args[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--session") {
			opts.defaultSessionKey = args[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--session-label") {
			opts.defaultSessionLabel = args[i + 1];
			i += 1;
			continue;
		}
		if (arg === "--require-existing") {
			opts.requireExistingSession = true;
			continue;
		}
		if (arg === "--reset-session") {
			opts.resetSession = true;
			continue;
		}
		if (arg === "--no-prefix-cwd") {
			opts.prefixCwd = false;
			continue;
		}
		if (arg === "--verbose" || arg === "-v") {
			opts.verbose = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
	}
	if (opts.gatewayToken?.trim() && tokenFile?.trim()) throw new Error("Use either --token or --token-file.");
	if (opts.gatewayPassword?.trim() && passwordFile?.trim()) throw new Error("Use either --password or --password-file.");
	if (tokenFile?.trim()) opts.gatewayToken = readSecretFromFile(tokenFile, "Gateway token");
	if (passwordFile?.trim()) opts.gatewayPassword = readSecretFromFile(passwordFile, "Gateway password");
	return opts;
}
function printHelp() {
	console.log(`Usage: openclaw acp [options]

Gateway-backed ACP server for IDE integration.

Options:
  --url <url>             Gateway WebSocket URL
  --token <token>         Gateway auth token
  --token-file <path>     Read gateway auth token from file
  --password <password>   Gateway auth password
  --password-file <path>  Read gateway auth password from file
  --session <key>         Default session key (e.g. "agent:main:main")
  --session-label <label> Default session label to resolve
  --require-existing      Fail if the session key/label does not exist
  --reset-session         Reset the session key before first use
  --no-prefix-cwd         Do not prefix prompts with the working directory
  --verbose, -v           Verbose logging to stderr
  --help, -h              Show this help message
`);
}
if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
	const argv = process.argv.slice(2);
	if (argv.includes("--token") || argv.includes("--gateway-token")) console.error("Warning: --token can be exposed via process listings. Prefer --token-file or OPENCLAW_GATEWAY_TOKEN.");
	if (argv.includes("--password") || argv.includes("--gateway-password")) console.error("Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.");
	serveAcpGateway(parseArgs(argv)).catch((err) => {
		console.error(String(err));
		process.exit(1);
	});
}

//#endregion
//#region src/cli/acp-cli.ts
function resolveSecretOption(params) {
	const direct = params.direct?.trim();
	const file = params.file?.trim();
	if (direct && file) throw new Error(`Use either ${params.directFlag} or ${params.fileFlag} for ${params.label}.`);
	if (file) return readSecretFromFile(file, params.label);
	return direct || void 0;
}
function warnSecretCliFlag(flag) {
	defaultRuntime.error(`Warning: ${flag} can be exposed via process listings. Prefer ${flag}-file or environment variables.`);
}
function registerAcpCli(program) {
	const acp = program.command("acp").description("Run an ACP bridge backed by the Gateway");
	acp.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--token-file <path>", "Read gateway token from file").option("--password <password>", "Gateway password (if required)").option("--password-file <path>", "Read gateway password from file").option("--session <key>", "Default session key (e.g. agent:main:main)").option("--session-label <label>", "Default session label to resolve").option("--require-existing", "Fail if the session key/label does not exist", false).option("--reset-session", "Reset the session key before first use", false).option("--no-prefix-cwd", "Do not prefix prompts with the working directory", false).option("-v, --verbose", "Verbose logging to stderr", false).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/acp", "docs.openclaw.ai/cli/acp")}\n`).action(async (opts) => {
		try {
			const gatewayToken = resolveSecretOption({
				direct: opts.token,
				file: opts.tokenFile,
				directFlag: "--token",
				fileFlag: "--token-file",
				label: "Gateway token"
			});
			const gatewayPassword = resolveSecretOption({
				direct: opts.password,
				file: opts.passwordFile,
				directFlag: "--password",
				fileFlag: "--password-file",
				label: "Gateway password"
			});
			if (opts.token) warnSecretCliFlag("--token");
			if (opts.password) warnSecretCliFlag("--password");
			await serveAcpGateway({
				gatewayUrl: opts.url,
				gatewayToken,
				gatewayPassword,
				defaultSessionKey: opts.session,
				defaultSessionLabel: opts.sessionLabel,
				requireExistingSession: Boolean(opts.requireExisting),
				resetSession: Boolean(opts.resetSession),
				prefixCwd: !opts.noPrefixCwd,
				verbose: Boolean(opts.verbose)
			});
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
	acp.command("client").description("Run an interactive ACP client against the local ACP bridge").option("--cwd <dir>", "Working directory for the ACP session").option("--server <command>", "ACP server command (default: openclaw)").option("--server-args <args...>", "Extra arguments for the ACP server").option("--server-verbose", "Enable verbose logging on the ACP server", false).option("-v, --verbose", "Verbose client logging", false).action(async (opts, command) => {
		const inheritedVerbose = inheritOptionFromParent(command, "verbose");
		try {
			await runAcpClientInteractive({
				cwd: opts.cwd,
				serverCommand: opts.server,
				serverArgs: opts.serverArgs,
				serverVerbose: Boolean(opts.serverVerbose),
				verbose: Boolean(opts.verbose || inheritedVerbose)
			});
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
export { registerAcpCli };