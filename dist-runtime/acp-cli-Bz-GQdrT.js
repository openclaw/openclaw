import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import { t as isMainModule } from "./is-main-DRn0Pf7d.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import { C as shortenHomePath, d as init_utils } from "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { n as inheritOptionFromParent } from "./command-options-CwQM9XPT.js";
import { Eb as omitEnvKeysCaseInsensitive, H as listThinkingLevels, Rd as buildGatewayConnectionDetails, wb as listKnownProviderAuthEnvVarNames, zb as loadConfig } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import { En as GATEWAY_CLIENT_NAMES, Tn as GATEWAY_CLIENT_MODES, u as GatewayClient } from "./method-scopes-CLHNYIU6.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import { n as VERSION } from "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import { $ as isKnownCoreToolId } from "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import { n as resolveWindowsSpawnProgram, t as materializeWindowsSpawnProgram } from "./windows-spawn-BwgAH4Nd.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-BIP146cA.js";
import { t as DANGEROUS_ACP_TOOLS } from "./dangerous-tools-ACVy39Yu.js";
import { t as readSecretFromFile } from "./secret-file-ilVp6ynf.js";
import { t as resolveGatewayConnectionAuth } from "./connection-auth-O2biLHGI.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os, { homedir } from "node:os";
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
function asRecord$1(value) {
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
	const toolMeta = asRecord$1(toolCall?._meta);
	const rawInput = asRecord$1(toolCall?.rawInput);
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
	const metaName = fromMeta ? normalizeToolName(fromMeta) : void 0;
	const rawInputName = fromRawInput ? normalizeToolName(fromRawInput) : void 0;
	const titleName = fromTitle;
	if (fromMeta && !metaName || fromRawInput && !rawInputName) return;
	if (metaName && titleName && metaName !== titleName) return;
	if (rawInputName && metaName && rawInputName !== metaName) return;
	if (rawInputName && titleName && rawInputName !== titleName) return;
	return metaName ?? titleName ?? rawInputName;
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
	const fromRawInput = readFirstStringValue(asRecord$1(params.toolCall?.rawInput), READ_TOOL_PATH_KEYS);
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
function resolveAcpClientSpawnEnv(baseEnv = process.env, options = {}) {
	const env = omitEnvKeysCaseInsensitive(baseEnv, options.stripKeys ?? []);
	env.OPENCLAW_SHELL = "acp-client";
	return env;
}
function shouldStripProviderAuthEnvVarsForAcpServer(params = {}) {
	const serverCommand = params.serverCommand?.trim();
	if (!serverCommand) return true;
	const defaultServerCommand = params.defaultServerCommand?.trim();
	if (!defaultServerCommand || serverCommand !== defaultServerCommand) return false;
	const serverArgs = params.serverArgs ?? [];
	const defaultServerArgs = params.defaultServerArgs ?? [];
	return serverArgs.length === defaultServerArgs.length && serverArgs.every((arg, index) => arg === defaultServerArgs[index]);
}
function buildAcpClientStripKeys(params) {
	const stripKeys = new Set(params.activeSkillEnvKeys ?? []);
	if (params.stripProviderAuthEnvVars) for (const key of listKnownProviderAuthEnvVarNames()) stripKeys.add(key);
	return stripKeys;
}
const DEFAULT_ACP_SPAWN_RUNTIME = {
	platform: process.platform,
	env: process.env,
	execPath: process.execPath
};
function resolveAcpClientSpawnInvocation(params, runtime = DEFAULT_ACP_SPAWN_RUNTIME) {
	const resolved = materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({
		command: params.serverCommand,
		platform: runtime.platform,
		env: runtime.env,
		execPath: runtime.execPath,
		packageName: "openclaw",
		allowShellFallback: true
	}), params.serverArgs);
	return {
		command: resolved.command,
		args: resolved.argv,
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	};
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
	const defaultServerCommand = entryPath ? process.execPath : "openclaw";
	const defaultServerArgs = entryPath ? [entryPath, ...serverArgs] : serverArgs;
	const serverCommand = opts.serverCommand ?? defaultServerCommand;
	const effectiveArgs = opts.serverCommand || !entryPath ? serverArgs : defaultServerArgs;
	const { getActiveSkillEnvKeys } = await import("./env-overrides.runtime-B2i1PgwY.js");
	const stripKeys = buildAcpClientStripKeys({
		stripProviderAuthEnvVars: shouldStripProviderAuthEnvVarsForAcpServer({
			serverCommand,
			serverArgs: effectiveArgs,
			defaultServerCommand,
			defaultServerArgs
		}),
		activeSkillEnvKeys: getActiveSkillEnvKeys()
	});
	const spawnEnv = resolveAcpClientSpawnEnv(process.env, { stripKeys });
	const spawnInvocation = resolveAcpClientSpawnInvocation({
		serverCommand,
		serverArgs: effectiveArgs
	}, {
		platform: process.platform,
		env: spawnEnv,
		execPath: process.execPath
	});
	log(`spawning: ${spawnInvocation.command} ${spawnInvocation.args.join(" ")}`);
	const agent = spawn(spawnInvocation.command, spawnInvocation.args, {
		stdio: [
			"pipe",
			"pipe",
			"inherit"
		],
		cwd,
		env: spawnEnv,
		shell: spawnInvocation.shell,
		windowsHide: spawnInvocation.windowsHide
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
init_utils();
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
const TOOL_LOCATION_PATH_KEYS = [
	"path",
	"filePath",
	"file_path",
	"targetPath",
	"target_path",
	"targetFile",
	"target_file",
	"sourcePath",
	"source_path",
	"destinationPath",
	"destination_path",
	"oldPath",
	"old_path",
	"newPath",
	"new_path",
	"outputPath",
	"output_path",
	"inputPath",
	"input_path"
];
const TOOL_LOCATION_LINE_KEYS = [
	"line",
	"lineNumber",
	"line_number",
	"startLine",
	"start_line"
];
const TOOL_RESULT_PATH_MARKER_RE = /^(?:FILE|MEDIA):(.+)$/gm;
const TOOL_LOCATION_MAX_DEPTH = 4;
const TOOL_LOCATION_MAX_NODES = 100;
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
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function normalizeToolLocationPath(value) {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 4096 || trimmed.includes("\0") || trimmed.includes("\r") || trimmed.includes("\n")) return;
	if (/^https?:\/\//i.test(trimmed)) return;
	if (/^file:\/\//i.test(trimmed)) try {
		const parsed = new URL(trimmed);
		return decodeURIComponent(parsed.pathname || "") || void 0;
	} catch {
		return;
	}
	return trimmed;
}
function normalizeToolLocationLine(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const line = Math.floor(value);
	return line > 0 ? line : void 0;
}
function extractToolLocationLine(record) {
	for (const key of TOOL_LOCATION_LINE_KEYS) {
		const line = normalizeToolLocationLine(record[key]);
		if (line !== void 0) return line;
	}
}
function addToolLocation(locations, rawPath, line) {
	const path = normalizeToolLocationPath(rawPath);
	if (!path) return;
	for (const [existingKey, existing] of locations.entries()) {
		if (existing.path !== path) continue;
		if (line === void 0 || existing.line === line) return;
		if (existing.line === void 0) locations.delete(existingKey);
	}
	const locationKey = `${path}:${line ?? ""}`;
	if (locations.has(locationKey)) return;
	locations.set(locationKey, line ? {
		path,
		line
	} : { path });
}
function collectLocationsFromTextMarkers(text, locations) {
	for (const match of text.matchAll(TOOL_RESULT_PATH_MARKER_RE)) {
		const candidate = match[1]?.trim();
		if (candidate) addToolLocation(locations, candidate);
	}
}
function collectToolLocations(value, locations, state, depth) {
	if (state.visited >= TOOL_LOCATION_MAX_NODES || depth > TOOL_LOCATION_MAX_DEPTH) return;
	state.visited += 1;
	if (typeof value === "string") {
		collectLocationsFromTextMarkers(value, locations);
		return;
	}
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) {
			collectToolLocations(item, locations, state, depth + 1);
			if (state.visited >= TOOL_LOCATION_MAX_NODES) return;
		}
		return;
	}
	const record = value;
	const line = extractToolLocationLine(record);
	for (const key of TOOL_LOCATION_PATH_KEYS) {
		const rawPath = record[key];
		if (typeof rawPath === "string") addToolLocation(locations, rawPath, line);
	}
	const content = Array.isArray(record.content) ? record.content : void 0;
	if (content) for (const block of content) {
		const entry = asRecord(block);
		if (entry?.type === "text" && typeof entry.text === "string") collectLocationsFromTextMarkers(entry.text, locations);
	}
	for (const [key, nested] of Object.entries(record)) {
		if (key === "content") continue;
		collectToolLocations(nested, locations, state, depth + 1);
		if (state.visited >= TOOL_LOCATION_MAX_NODES) return;
	}
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
function extractToolCallContent(value) {
	if (typeof value === "string") return value.trim() ? [{
		type: "content",
		content: {
			type: "text",
			text: value
		}
	}] : void 0;
	const record = asRecord(value);
	if (!record) return;
	const contents = [];
	const blocks = Array.isArray(record.content) ? record.content : [];
	for (const block of blocks) {
		const entry = asRecord(block);
		if (entry?.type === "text" && typeof entry.text === "string" && entry.text.trim()) contents.push({
			type: "content",
			content: {
				type: "text",
				text: entry.text
			}
		});
	}
	if (contents.length > 0) return contents;
	const fallbackText = typeof record.text === "string" ? record.text : typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : void 0;
	if (!fallbackText?.trim()) return;
	return [{
		type: "content",
		content: {
			type: "text",
			text: fallbackText
		}
	}];
}
function extractToolCallLocations(...values) {
	const locations = /* @__PURE__ */ new Map();
	for (const value of values) collectToolLocations(value, locations, { visited: 0 }, 0);
	return locations.size > 0 ? [...locations.values()] : void 0;
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
const ACP_PROVENANCE_MODE_VALUES = [
	"off",
	"meta",
	"meta+receipt"
];
function normalizeAcpProvenanceMode(value) {
	if (!value) return;
	const normalized = value.trim().toLowerCase();
	return ACP_PROVENANCE_MODE_VALUES.includes(normalized) ? normalized : void 0;
}
const ACP_AGENT_INFO = {
	name: "openclaw-acp",
	title: "OpenClaw ACP Gateway",
	version: VERSION
};
//#endregion
//#region src/acp/translator.ts
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const ACP_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const ACP_FAST_MODE_CONFIG_ID = "fast_mode";
const ACP_VERBOSE_LEVEL_CONFIG_ID = "verbose_level";
const ACP_REASONING_LEVEL_CONFIG_ID = "reasoning_level";
const ACP_RESPONSE_USAGE_CONFIG_ID = "response_usage";
const ACP_ELEVATED_LEVEL_CONFIG_ID = "elevated_level";
const ACP_LOAD_SESSION_REPLAY_LIMIT = 1e6;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS = 120;
const SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS = 1e4;
function formatThinkingLevelName(level) {
	switch (level) {
		case "xhigh": return "Extra High";
		case "adaptive": return "Adaptive";
		default: return level.length > 0 ? `${level[0].toUpperCase()}${level.slice(1)}` : "Unknown";
	}
}
function buildThinkingModeDescription(level) {
	if (level === "adaptive") return "Use the Gateway session default thought level.";
}
function formatConfigValueName(value) {
	switch (value) {
		case "xhigh": return "Extra High";
		default: return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : "Unknown";
	}
}
function buildSelectConfigOption(params) {
	return {
		type: "select",
		id: params.id,
		name: params.name,
		category: params.category,
		description: params.description,
		currentValue: params.currentValue,
		options: params.values.map((value) => ({
			value,
			name: formatConfigValueName(value)
		}))
	};
}
function buildSessionPresentation(params) {
	const row = {
		...params.row,
		...params.overrides
	};
	const availableLevelIds = [...listThinkingLevels(row.modelProvider, row.model)];
	const currentModeId = row.thinkingLevel?.trim() || "adaptive";
	if (!availableLevelIds.includes(currentModeId)) availableLevelIds.push(currentModeId);
	const modes = {
		currentModeId,
		availableModes: availableLevelIds.map((level) => ({
			id: level,
			name: formatThinkingLevelName(level),
			description: buildThinkingModeDescription(level)
		}))
	};
	return {
		configOptions: [
			buildSelectConfigOption({
				id: ACP_THOUGHT_LEVEL_CONFIG_ID,
				name: "Thought level",
				category: "thought_level",
				description: "Controls how much deliberate reasoning OpenClaw requests from the Gateway model.",
				currentValue: currentModeId,
				values: availableLevelIds
			}),
			buildSelectConfigOption({
				id: ACP_FAST_MODE_CONFIG_ID,
				name: "Fast mode",
				description: "Controls whether OpenAI sessions use the Gateway fast-mode profile.",
				currentValue: row.fastMode ? "on" : "off",
				values: ["off", "on"]
			}),
			buildSelectConfigOption({
				id: ACP_VERBOSE_LEVEL_CONFIG_ID,
				name: "Tool verbosity",
				description: "Controls how much tool progress and output detail OpenClaw keeps enabled for the session.",
				currentValue: row.verboseLevel?.trim() || "off",
				values: [
					"off",
					"on",
					"full"
				]
			}),
			buildSelectConfigOption({
				id: ACP_REASONING_LEVEL_CONFIG_ID,
				name: "Reasoning stream",
				description: "Controls whether reasoning-capable models emit reasoning text for the session.",
				currentValue: row.reasoningLevel?.trim() || "off",
				values: [
					"off",
					"on",
					"stream"
				]
			}),
			buildSelectConfigOption({
				id: ACP_RESPONSE_USAGE_CONFIG_ID,
				name: "Usage detail",
				description: "Controls how much usage information OpenClaw attaches to responses for the session.",
				currentValue: row.responseUsage?.trim() || "off",
				values: [
					"off",
					"tokens",
					"full"
				]
			}),
			buildSelectConfigOption({
				id: ACP_ELEVATED_LEVEL_CONFIG_ID,
				name: "Elevated actions",
				description: "Controls how aggressively the session allows elevated execution behavior.",
				currentValue: row.elevatedLevel?.trim() || "off",
				values: [
					"off",
					"on",
					"ask",
					"full"
				]
			})
		],
		modes
	};
}
function extractReplayText(content) {
	if (typeof content === "string") return content.length > 0 ? content : void 0;
	if (!Array.isArray(content)) return;
	const text = content.map((block) => {
		if (!block || typeof block !== "object" || Array.isArray(block)) return "";
		const typedBlock = block;
		return typedBlock.type === "text" && typeof typedBlock.text === "string" ? typedBlock.text : "";
	}).join("");
	return text.length > 0 ? text : void 0;
}
function buildSessionMetadata(params) {
	return {
		title: params.row?.derivedTitle?.trim() || params.row?.displayName?.trim() || params.row?.label?.trim() || params.sessionKey,
		updatedAt: typeof params.row?.updatedAt === "number" && Number.isFinite(params.row.updatedAt) ? new Date(params.row.updatedAt).toISOString() : null
	};
}
function buildSessionUsageSnapshot(row) {
	const totalTokens = row?.totalTokens;
	const contextTokens = row?.contextTokens;
	if (row?.totalTokensFresh !== true || typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0) return;
	const size = Math.max(0, Math.floor(contextTokens));
	return {
		size,
		used: Math.max(0, Math.min(Math.floor(totalTokens), size))
	};
}
function buildSystemInputProvenance(originSessionId) {
	return {
		kind: "external_user",
		originSessionId,
		sourceChannel: "acp",
		sourceTool: "openclaw_acp"
	};
}
function buildSystemProvenanceReceipt(params) {
	return [
		"[Source Receipt]",
		"bridge=openclaw-acp",
		`originHost=${os.hostname()}`,
		`originCwd=${shortenHomePath(params.cwd)}`,
		`acpSessionId=${params.sessionId}`,
		`originSessionId=${params.sessionId}`,
		`targetSession=${params.sessionKey}`,
		"[/Source Receipt]"
	].join("\n");
}
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
		this.assertSupportedSessionSetup(params.mcpServers);
		this.enforceSessionCreateRateLimit("newSession");
		const sessionId = randomUUID();
		const meta = parseSessionMeta(params._meta);
		const sessionKey = await this.resolveSessionKeyFromMeta({
			meta,
			fallbackKey: `acp:${sessionId}`
		});
		const session = this.sessionStore.createSession({
			sessionId,
			sessionKey,
			cwd: params.cwd
		});
		this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
		const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey);
		await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, { includeControls: false });
		await this.sendAvailableCommands(session.sessionId);
		const { configOptions, modes } = sessionSnapshot;
		return {
			sessionId: session.sessionId,
			configOptions,
			modes
		};
	}
	async loadSession(params) {
		this.assertSupportedSessionSetup(params.mcpServers);
		if (!this.sessionStore.hasSession(params.sessionId)) this.enforceSessionCreateRateLimit("loadSession");
		const meta = parseSessionMeta(params._meta);
		const sessionKey = await this.resolveSessionKeyFromMeta({
			meta,
			fallbackKey: params.sessionId
		});
		const session = this.sessionStore.createSession({
			sessionId: params.sessionId,
			sessionKey,
			cwd: params.cwd
		});
		this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
		const [sessionSnapshot, transcript] = await Promise.all([this.getSessionSnapshot(session.sessionKey), this.getSessionTranscript(session.sessionKey).catch((err) => {
			this.log(`session transcript fallback for ${session.sessionKey}: ${String(err)}`);
			return [];
		})]);
		await this.replaySessionTranscript(session.sessionId, transcript);
		await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, { includeControls: false });
		await this.sendAvailableCommands(session.sessionId);
		const { configOptions, modes } = sessionSnapshot;
		return {
			configOptions,
			modes
		};
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
			const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, { thinkingLevel: params.modeId });
			await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, { includeControls: true });
		} catch (err) {
			this.log(`setSessionMode error: ${String(err)}`);
			throw err instanceof Error ? err : new Error(String(err));
		}
		return {};
	}
	async setSessionConfigOption(params) {
		const session = this.sessionStore.getSession(params.sessionId);
		if (!session) throw new Error(`Session ${params.sessionId} not found`);
		const sessionPatch = this.resolveSessionConfigPatch(params.configId, params.value);
		try {
			await this.gateway.request("sessions.patch", {
				key: session.sessionKey,
				...sessionPatch.patch
			});
			this.log(`setSessionConfigOption: ${session.sessionId} -> ${params.configId}=${params.value}`);
			const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, sessionPatch.overrides);
			await this.sendSessionSnapshotUpdate(session.sessionId, sessionSnapshot, { includeControls: true });
			return { configOptions: sessionSnapshot.configOptions };
		} catch (err) {
			this.log(`setSessionConfigOption error: ${String(err)}`);
			throw err instanceof Error ? err : new Error(String(err));
		}
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
		const provenanceMode = this.opts.provenanceMode ?? "off";
		const systemInputProvenance = provenanceMode === "off" ? void 0 : buildSystemInputProvenance(params.sessionId);
		const systemProvenanceReceipt = provenanceMode === "meta+receipt" ? buildSystemProvenanceReceipt({
			cwd: session.cwd,
			sessionId: params.sessionId,
			sessionKey: session.sessionKey
		}) : void 0;
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
				timeoutMs: readNumber(params._meta, ["timeoutMs"]),
				systemInputProvenance,
				systemProvenanceReceipt
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
		const activeRunId = session.activeRunId;
		this.sessionStore.cancelActiveRun(params.sessionId);
		const pending = this.pendingPrompts.get(params.sessionId);
		const scopedRunId = activeRunId ?? pending?.idempotencyKey;
		if (!scopedRunId) return;
		try {
			await this.gateway.request("chat.abort", {
				sessionKey: session.sessionKey,
				runId: scopedRunId
			});
		} catch (err) {
			this.log(`cancel error: ${String(err)}`);
		}
		if (pending) {
			this.pendingPrompts.delete(params.sessionId);
			pending.resolve({ stopReason: "cancelled" });
		}
	}
	async resolveSessionKeyFromMeta(params) {
		const sessionKey = await resolveSessionKey({
			meta: params.meta,
			fallbackKey: params.fallbackKey,
			gateway: this.gateway,
			opts: this.opts
		});
		await resetSessionIfNeeded({
			meta: params.meta,
			sessionKey,
			gateway: this.gateway,
			opts: this.opts
		});
		return sessionKey;
	}
	async handleAgentEvent(evt) {
		const payload = evt.payload;
		if (!payload) return;
		const stream = payload.stream;
		const runId = payload.runId;
		const data = payload.data;
		const sessionKey = payload.sessionKey;
		if (!stream || !data || !sessionKey) return;
		if (stream !== "tool") return;
		const phase = data.phase;
		const name = data.name;
		const toolCallId = data.toolCallId;
		if (!toolCallId) return;
		const pending = this.findPendingBySessionKey(sessionKey, runId);
		if (!pending) return;
		if (phase === "start") {
			if (!pending.toolCalls) pending.toolCalls = /* @__PURE__ */ new Map();
			if (pending.toolCalls.has(toolCallId)) return;
			const args = data.args;
			const title = formatToolTitle(name, args);
			const kind = inferToolKind(name);
			const locations = extractToolCallLocations(args);
			pending.toolCalls.set(toolCallId, {
				title,
				kind,
				rawInput: args,
				locations
			});
			await this.connection.sessionUpdate({
				sessionId: pending.sessionId,
				update: {
					sessionUpdate: "tool_call",
					toolCallId,
					title,
					status: "in_progress",
					rawInput: args,
					kind,
					locations
				}
			});
			return;
		}
		if (phase === "update") {
			const toolState = pending.toolCalls?.get(toolCallId);
			const partialResult = data.partialResult;
			await this.connection.sessionUpdate({
				sessionId: pending.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: "in_progress",
					rawOutput: partialResult,
					content: extractToolCallContent(partialResult),
					locations: extractToolCallLocations(toolState?.locations, partialResult)
				}
			});
			return;
		}
		if (phase === "result") {
			const isError = Boolean(data.isError);
			const toolState = pending.toolCalls?.get(toolCallId);
			pending.toolCalls?.delete(toolCallId);
			await this.connection.sessionUpdate({
				sessionId: pending.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: isError ? "failed" : "completed",
					rawOutput: data.result,
					content: extractToolCallContent(data.result),
					locations: extractToolCallLocations(toolState?.locations, data.result)
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
		const pending = this.findPendingBySessionKey(sessionKey, runId);
		if (!pending) return;
		if (messageData && (state === "delta" || state === "final")) {
			await this.handleDeltaEvent(pending.sessionId, messageData);
			if (state === "delta") return;
		}
		if (state === "final") {
			const stopReason = payload.stopReason === "max_tokens" ? "max_tokens" : "end_turn";
			await this.finishPrompt(pending.sessionId, pending, stopReason);
			return;
		}
		if (state === "aborted") {
			await this.finishPrompt(pending.sessionId, pending, "cancelled");
			return;
		}
		if (state === "error") this.finishPrompt(pending.sessionId, pending, "end_turn");
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
	async finishPrompt(sessionId, pending, stopReason) {
		this.pendingPrompts.delete(sessionId);
		this.sessionStore.clearActiveRun(sessionId);
		const sessionSnapshot = await this.getSessionSnapshot(pending.sessionKey);
		try {
			await this.sendSessionSnapshotUpdate(sessionId, sessionSnapshot, { includeControls: false });
		} catch (err) {
			this.log(`session snapshot update failed for ${sessionId}: ${String(err)}`);
		}
		pending.resolve({ stopReason });
	}
	findPendingBySessionKey(sessionKey, runId) {
		for (const pending of this.pendingPrompts.values()) {
			if (pending.sessionKey !== sessionKey) continue;
			if (runId && pending.idempotencyKey !== runId) continue;
			return pending;
		}
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
	async getSessionSnapshot(sessionKey, overrides) {
		try {
			const row = await this.getGatewaySessionRow(sessionKey);
			return {
				...buildSessionPresentation({
					row,
					overrides
				}),
				metadata: buildSessionMetadata({
					row,
					sessionKey
				}),
				usage: buildSessionUsageSnapshot(row)
			};
		} catch (err) {
			this.log(`session presentation fallback for ${sessionKey}: ${String(err)}`);
			return {
				...buildSessionPresentation({ overrides }),
				metadata: buildSessionMetadata({ sessionKey })
			};
		}
	}
	async getGatewaySessionRow(sessionKey) {
		const session = (await this.gateway.request("sessions.list", {
			limit: 200,
			search: sessionKey,
			includeDerivedTitles: true
		})).sessions.find((entry) => entry.key === sessionKey);
		if (!session) return;
		return {
			displayName: session.displayName,
			label: session.label,
			derivedTitle: session.derivedTitle,
			updatedAt: session.updatedAt,
			thinkingLevel: session.thinkingLevel,
			modelProvider: session.modelProvider,
			model: session.model,
			fastMode: session.fastMode,
			verboseLevel: session.verboseLevel,
			reasoningLevel: session.reasoningLevel,
			responseUsage: session.responseUsage,
			elevatedLevel: session.elevatedLevel,
			totalTokens: session.totalTokens,
			totalTokensFresh: session.totalTokensFresh,
			contextTokens: session.contextTokens
		};
	}
	resolveSessionConfigPatch(configId, value) {
		if (typeof value !== "string") throw new Error(`ACP bridge does not support non-string session config option values for "${configId}".`);
		switch (configId) {
			case ACP_THOUGHT_LEVEL_CONFIG_ID: return {
				patch: { thinkingLevel: value },
				overrides: { thinkingLevel: value }
			};
			case ACP_FAST_MODE_CONFIG_ID: return {
				patch: { fastMode: value === "on" },
				overrides: { fastMode: value === "on" }
			};
			case ACP_VERBOSE_LEVEL_CONFIG_ID: return {
				patch: { verboseLevel: value },
				overrides: { verboseLevel: value }
			};
			case ACP_REASONING_LEVEL_CONFIG_ID: return {
				patch: { reasoningLevel: value },
				overrides: { reasoningLevel: value }
			};
			case ACP_RESPONSE_USAGE_CONFIG_ID: return {
				patch: { responseUsage: value },
				overrides: { responseUsage: value }
			};
			case ACP_ELEVATED_LEVEL_CONFIG_ID: return {
				patch: { elevatedLevel: value },
				overrides: { elevatedLevel: value }
			};
			default: throw new Error(`ACP bridge mode does not support session config option "${configId}".`);
		}
	}
	async getSessionTranscript(sessionKey) {
		const result = await this.gateway.request("sessions.get", {
			key: sessionKey,
			limit: ACP_LOAD_SESSION_REPLAY_LIMIT
		});
		if (!Array.isArray(result.messages)) return [];
		return result.messages;
	}
	async replaySessionTranscript(sessionId, transcript) {
		for (const message of transcript) {
			const role = typeof message.role === "string" ? message.role : "";
			if (role !== "user" && role !== "assistant") continue;
			const text = extractReplayText(message.content);
			if (!text) continue;
			await this.connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
					content: {
						type: "text",
						text
					}
				}
			});
		}
	}
	async sendSessionSnapshotUpdate(sessionId, sessionSnapshot, options) {
		if (options.includeControls) {
			await this.connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "current_mode_update",
					currentModeId: sessionSnapshot.modes.currentModeId
				}
			});
			await this.connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "config_option_update",
					configOptions: sessionSnapshot.configOptions
				}
			});
		}
		if (sessionSnapshot.metadata) await this.connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				...sessionSnapshot.metadata
			}
		});
		if (sessionSnapshot.usage) await this.connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "usage_update",
				used: sessionSnapshot.usage.used,
				size: sessionSnapshot.usage.size,
				_meta: {
					source: "gateway-session-store",
					approximate: true
				}
			}
		});
	}
	assertSupportedSessionSetup(mcpServers) {
		if (mcpServers.length === 0) return;
		throw new Error("ACP bridge mode does not support per-session MCP servers. Configure MCP on the OpenClaw gateway or agent instead.");
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
	const gatewayUrlOverrideSource = connection.urlSource === "cli --url" ? "cli" : connection.urlSource === "env OPENCLAW_GATEWAY_URL" ? "env" : void 0;
	const creds = await resolveGatewayConnectionAuth({
		config: cfg,
		explicitAuth: {
			token: opts.gatewayToken,
			password: opts.gatewayPassword
		},
		env: process.env,
		urlOverride: gatewayUrlOverrideSource ? connection.url : void 0,
		urlOverrideSource: gatewayUrlOverrideSource
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
		if (arg === "--provenance") {
			const provenanceMode = normalizeAcpProvenanceMode(args[i + 1]);
			if (!provenanceMode) throw new Error("Invalid --provenance value. Use off, meta, or meta+receipt.");
			opts.provenanceMode = provenanceMode;
			i += 1;
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
  --provenance <mode>     ACP provenance mode: off, meta, or meta+receipt
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
init_runtime();
init_theme();
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
	acp.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--token-file <path>", "Read gateway token from file").option("--password <password>", "Gateway password (if required)").option("--password-file <path>", "Read gateway password from file").option("--session <key>", "Default session key (e.g. agent:main:main)").option("--session-label <label>", "Default session label to resolve").option("--require-existing", "Fail if the session key/label does not exist", false).option("--reset-session", "Reset the session key before first use", false).option("--no-prefix-cwd", "Do not prefix prompts with the working directory", false).option("--provenance <mode>", "ACP provenance mode: off, meta, or meta+receipt").option("-v, --verbose", "Verbose logging to stderr", false).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/acp", "docs.openclaw.ai/cli/acp")}\n`).action(async (opts) => {
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
			const provenanceMode = normalizeAcpProvenanceMode(opts.provenance);
			if (opts.provenance && !provenanceMode) throw new Error("Invalid --provenance value. Use off, meta, or meta+receipt.");
			await serveAcpGateway({
				gatewayUrl: opts.url,
				gatewayToken,
				gatewayPassword,
				defaultSessionKey: opts.session,
				defaultSessionLabel: opts.sessionLabel,
				requireExistingSession: Boolean(opts.requireExisting),
				resetSession: Boolean(opts.resetSession),
				prefixCwd: !opts.noPrefixCwd,
				provenanceMode,
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
