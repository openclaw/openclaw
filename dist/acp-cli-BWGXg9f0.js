import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, f as readStringValue, s as normalizeOptionalLowercaseString, t as hasNonEmptyString } from "./string-coerce-DyL154ka.js";
import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as isMainModule } from "./is-main-DoKHeRG7.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as inheritOptionFromParent } from "./command-options-Dhjl7AMa.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { c as isRecord, g as shortenHomePath } from "./utils-sBTEdeml.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import "./path-guards-CBe_wA_B.js";
import { r as readJsonFile, s as writeTextAtomic } from "./json-files-C2hqjU--.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { a as routeLogsToStderr } from "./console-BAPPAj56.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as sanitizeTerminalText } from "./safe-text-J_0sTthZ.js";
import { l as BASE_THINKING_LEVELS } from "./thinking-DNSlsULp.js";
import { i as omitEnvKeysCaseInsensitive, n as listKnownProviderAuthEnvVarNames } from "./provider-env-vars-HpAfBQBJ.js";
import { o as withFileLock } from "./file-lock-D5OTq3qW.js";
import "./file-lock-BSRN56ID.js";
import "./config-B6Oplu5W.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES, t as GATEWAY_CLIENT_CAPS } from "./client-info-BVWE_ra1.js";
import { t as startGatewayClientWhenEventLoopReady } from "./client-start-readiness-zY0I9Wur.js";
import { n as GatewayClient } from "./client-B1EH_7Mz.js";
import { i as asOptionalRecord } from "./record-coerce-aMlBWINm.js";
import { r as isKnownCoreToolId } from "./tool-catalog-8X_kZYZC.js";
import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } from "./windows-spawn-B76fGM3V.js";
import { r as isMutatingToolCall } from "./tool-mutation-DHAIDwUO.js";
import { t as ensureOpenClawCliOnPath } from "./path-env-BY1Xr76b.js";
import { t as resolveGatewayClientBootstrap } from "./client-bootstrap-BVdOqAXA.js";
import { t as readSecretFromFile } from "./secret-file-UFPEBo9z.js";
import { t as resolveGatewayAuthOptions } from "./gateway-secret-options-D9e0ZqVQ.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os, { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as readline$1 from "node:readline";
import { AgentSideConnection, ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
//#region src/acp/approval-classifier.ts
const SAFE_SEARCH_TOOL_IDS = new Set([
	"search",
	"web_search",
	"memory_search"
]);
const TRUSTED_SAFE_TOOL_ALIASES = new Set(["search"]);
const EXEC_CAPABLE_TOOL_IDS = new Set([
	"exec",
	"spawn",
	"shell",
	"bash",
	"process",
	"code_execution",
	"nodes"
]);
const CONTROL_PLANE_TOOL_IDS = new Set([
	"cron",
	"gateway",
	"sessions_spawn",
	"sessions_send",
	"session_status"
]);
function readFirstStringValue(source, keys) {
	if (!source) return;
	for (const key of keys) {
		const value = normalizeOptionalString(source[key]);
		if (value) return value;
	}
}
function normalizeToolName(value) {
	const normalized = normalizeLowercaseStringOrEmpty(value);
	if (!normalized || normalized.length > 128) return;
	return /^[a-z0-9._-]+$/.test(normalized) ? normalized : void 0;
}
function parseToolNameFromTitle(title) {
	if (!title) return;
	const head = normalizeOptionalString(title.split(":", 1)[0]);
	return head ? normalizeToolName(head) : void 0;
}
function resolveToolNameForPermission(params) {
	const toolCall = params.toolCall;
	const toolMeta = asOptionalRecord(toolCall?.["_meta"]);
	const rawInput = asOptionalRecord(toolCall?.rawInput);
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
	return toolName === "read" ? tail : void 0;
}
function resolveToolPathCandidate(params, toolName, toolTitle) {
	return readFirstStringValue(asOptionalRecord(params.toolCall?.rawInput), [
		"path",
		"file_path",
		"filePath"
	]) ?? extractPathFromToolTitle(toolTitle, toolName);
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
function isReadToolCallScopedToCwd(params, toolName, toolTitle, cwd) {
	if (toolName !== "read") return false;
	const rawPath = resolveToolPathCandidate(params, toolName, toolTitle);
	if (!rawPath) return false;
	const absolutePath = resolveAbsoluteScopedPath(rawPath, cwd);
	if (!absolutePath) return false;
	return isPathInside(path.resolve(cwd), absolutePath);
}
function classifyAcpToolApproval(params) {
	const toolName = resolveToolNameForPermission(params);
	if (!toolName) return {
		toolName: void 0,
		approvalClass: "unknown",
		autoApprove: false
	};
	const isTrustedToolId = isKnownCoreToolId(toolName) || TRUSTED_SAFE_TOOL_ALIASES.has(toolName);
	if (toolName === "read" && isTrustedToolId) {
		const autoApprove = isReadToolCallScopedToCwd(params, toolName, params.toolCall?.title ?? void 0, params.cwd);
		return {
			toolName,
			approvalClass: autoApprove ? "readonly_scoped" : "other",
			autoApprove
		};
	}
	if (SAFE_SEARCH_TOOL_IDS.has(toolName) && isTrustedToolId) return {
		toolName,
		approvalClass: "readonly_search",
		autoApprove: true
	};
	if (EXEC_CAPABLE_TOOL_IDS.has(toolName)) return {
		toolName,
		approvalClass: "exec_capable",
		autoApprove: false
	};
	if (CONTROL_PLANE_TOOL_IDS.has(toolName)) return {
		toolName,
		approvalClass: "control_plane",
		autoApprove: false
	};
	if (isMutatingToolCall(toolName, params.toolCall?.rawInput)) return {
		toolName,
		approvalClass: "mutating",
		autoApprove: false
	};
	return {
		toolName,
		approvalClass: "other",
		autoApprove: false
	};
}
//#endregion
//#region src/acp/client-helpers.ts
function resolveToolKindForPermission(toolName, approvalClass) {
	if (!toolName && approvalClass === "unknown") return;
	if (approvalClass === "readonly_scoped") return "readonly_scoped";
	if (approvalClass === "readonly_search") return "readonly_search";
	return approvalClass;
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
			const approved = normalizeLowercaseStringOrEmpty(answer) === "y";
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
	const toolTitle = sanitizeTerminalText(params.toolCall?.title ?? "tool");
	const classification = classifyAcpToolApproval({
		toolCall: params.toolCall,
		cwd
	});
	const toolName = classification.toolName;
	const toolKind = resolveToolKindForPermission(toolName, classification.approvalClass);
	if (options.length === 0) {
		log(`[permission cancelled] ${toolName ?? "unknown"}: no options available`);
		return cancelledPermission();
	}
	const allowOption = pickOption(options, ["allow_once", "allow_always"]);
	const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
	if (!!classification.autoApprove) {
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
function resolveAcpClientSpawnEnv(baseEnv = process.env, options = {}) {
	const env = omitEnvKeysCaseInsensitive(baseEnv, options.stripKeys ?? []);
	env.OPENCLAW_SHELL = "acp-client";
	return env;
}
function shouldStripProviderAuthEnvVarsForAcpServer(params = {}) {
	const serverCommand = normalizeOptionalString(params.serverCommand);
	if (!serverCommand) return true;
	const defaultServerCommand = normalizeOptionalString(params.defaultServerCommand);
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
		packageName: "openclaw"
	}), params.serverArgs);
	return {
		command: resolved.command,
		args: resolved.argv,
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	};
}
//#endregion
//#region src/acp/client.ts
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
	const argv1 = normalizeOptionalString(process.argv[1]);
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
	const { getActiveSkillEnvKeys } = await import("./env-overrides.runtime.js");
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
//#region src/acp/event-ledger.ts
const LEDGER_VERSION = 1;
const DEFAULT_MAX_SESSIONS$1 = 200;
const DEFAULT_MAX_EVENTS_PER_SESSION = 5e3;
const DEFAULT_MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;
const FILE_LEDGER_LOCK_OPTIONS = {
	retries: {
		retries: 8,
		factor: 2,
		minTimeout: 50,
		maxTimeout: 5e3,
		randomize: true
	},
	stale: 15e3
};
function createEmptyStore() {
	return {
		version: LEDGER_VERSION,
		sessions: {}
	};
}
function normalizeLedgerOptions(options = {}) {
	return {
		maxSessions: Math.max(1, Math.floor(options.maxSessions ?? DEFAULT_MAX_SESSIONS$1)),
		maxEventsPerSession: Math.max(1, Math.floor(options.maxEventsPerSession ?? DEFAULT_MAX_EVENTS_PER_SESSION)),
		maxSerializedBytes: Math.max(1024, Math.floor(options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES)),
		now: options.now ?? Date.now
	};
}
function cloneJsonValue(value) {
	return structuredClone(value);
}
function createUserPromptUpdates(prompt) {
	return prompt.map((content) => ({
		sessionUpdate: "user_message_chunk",
		content: cloneJsonValue(content)
	}));
}
function serializeLedgerStore(store) {
	return JSON.stringify(store);
}
function getSerializedLedgerByteLength(store) {
	return Buffer.byteLength(serializeLedgerStore(store), "utf8");
}
function normalizeEvent(raw) {
	if (!isRecord(raw) || !isRecord(raw.update)) return;
	const seq = raw.seq;
	const at = raw.at;
	const sessionId = raw.sessionId;
	const sessionKey = raw.sessionKey;
	const runId = raw.runId;
	const sessionUpdate = raw.update.sessionUpdate;
	if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || typeof at !== "number" || !Number.isFinite(at) || typeof sessionId !== "string" || typeof sessionKey !== "string" || typeof sessionUpdate !== "string") return;
	return {
		seq,
		at,
		sessionId,
		sessionKey,
		...typeof runId === "string" && runId ? { runId } : {},
		update: cloneJsonValue(raw.update)
	};
}
function normalizeSession(raw) {
	if (!isRecord(raw)) return;
	const sessionId = raw.sessionId;
	const sessionKey = raw.sessionKey;
	const cwd = raw.cwd;
	const createdAt = raw.createdAt;
	const updatedAt = raw.updatedAt;
	const nextSeq = raw.nextSeq;
	if (typeof sessionId !== "string" || typeof sessionKey !== "string" || typeof cwd !== "string" || typeof createdAt !== "number" || !Number.isFinite(createdAt) || typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || typeof nextSeq !== "number" || !Number.isInteger(nextSeq) || nextSeq < 1) return;
	const events = Array.isArray(raw.events) ? raw.events.map(normalizeEvent).filter((event) => Boolean(event)) : [];
	return {
		sessionId,
		sessionKey,
		cwd,
		complete: raw.complete === true,
		createdAt,
		updatedAt,
		nextSeq,
		events
	};
}
function normalizeStore(raw) {
	if (!isRecord(raw) || raw.version !== LEDGER_VERSION || !isRecord(raw.sessions)) return createEmptyStore();
	const sessions = {};
	for (const [sessionId, value] of Object.entries(raw.sessions)) {
		const session = normalizeSession(value);
		if (!session || session.sessionId !== sessionId) continue;
		sessions[sessionId] = session;
	}
	return {
		version: LEDGER_VERSION,
		sessions
	};
}
function getOrCreateSession(state, params) {
	const now = state.now();
	const existing = state.store.sessions[params.sessionId];
	if (!params.reset && existing) {
		existing.sessionKey = params.sessionKey;
		if (params.cwd) existing.cwd = params.cwd;
		existing.complete = existing.complete || params.complete;
		existing.updatedAt = now;
		return existing;
	}
	const session = {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		cwd: params.cwd,
		complete: params.complete,
		createdAt: now,
		updatedAt: now,
		nextSeq: 1,
		events: []
	};
	state.store.sessions[params.sessionId] = session;
	return session;
}
function trimLedger(state) {
	for (const session of Object.values(state.store.sessions)) {
		if (session.events.length <= state.maxEventsPerSession) continue;
		session.events = session.events.slice(-state.maxEventsPerSession);
		session.complete = false;
	}
	const sessions = Object.values(state.store.sessions);
	if (sessions.length > state.maxSessions) for (const session of sessions.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(state.maxSessions)) delete state.store.sessions[session.sessionId];
	let serializedBytes = getSerializedLedgerByteLength(state.store);
	while (serializedBytes > state.maxSerializedBytes) {
		const session = Object.values(state.store.sessions).filter((candidate) => candidate.events.length > 0).toSorted((a, b) => a.updatedAt - b.updatedAt)[0];
		if (!session) break;
		session.events.shift();
		session.complete = false;
		serializedBytes = getSerializedLedgerByteLength(state.store);
	}
	while (serializedBytes > state.maxSerializedBytes) {
		const session = Object.values(state.store.sessions).toSorted((a, b) => a.updatedAt - b.updatedAt)[0];
		if (!session) break;
		delete state.store.sessions[session.sessionId];
		serializedBytes = getSerializedLedgerByteLength(state.store);
	}
}
function appendUpdate(state, params) {
	const session = getOrCreateSession(state, {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		cwd: "",
		complete: false
	});
	const now = state.now();
	session.updatedAt = now;
	session.events.push({
		seq: session.nextSeq,
		at: now,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		...params.runId ? { runId: params.runId } : {},
		update: cloneJsonValue(params.update)
	});
	session.nextSeq += 1;
	trimLedger(state);
}
function createLedgerApi(params) {
	const buildReplay = (session) => ({
		complete: true,
		sessionId: session.sessionId,
		sessionKey: session.sessionKey,
		events: session.events.map((event) => cloneJsonValue(event))
	});
	return {
		async startSession(sessionParams) {
			await params.mutate(() => {
				getOrCreateSession(params.state, sessionParams);
				trimLedger(params.state);
			});
		},
		async recordUserPrompt(promptParams) {
			await params.mutate(() => {
				for (const update of createUserPromptUpdates(promptParams.prompt)) appendUpdate(params.state, {
					sessionId: promptParams.sessionId,
					sessionKey: promptParams.sessionKey,
					runId: promptParams.runId,
					update
				});
			});
		},
		async recordUpdate(updateParams) {
			await params.mutate(() => {
				appendUpdate(params.state, updateParams);
			});
		},
		async markIncomplete(markParams) {
			await params.mutate(() => {
				const session = params.state.store.sessions[markParams.sessionId];
				if (!session || session.sessionKey !== markParams.sessionKey) return;
				session.complete = false;
				session.updatedAt = params.state.now();
			});
		},
		async readReplay(replayParams) {
			return params.read(() => {
				const session = params.state.store.sessions[replayParams.sessionId];
				if (!session || session.sessionKey !== replayParams.sessionKey || !session.complete) return {
					complete: false,
					events: []
				};
				return buildReplay(session);
			});
		},
		async readReplayBySessionId(replayParams) {
			return params.read(() => {
				const session = params.state.store.sessions[replayParams.sessionId];
				if (!session || !session.complete) return {
					complete: false,
					events: []
				};
				return buildReplay(session);
			});
		},
		async readReplayBySessionKey(replayParams) {
			return params.read(() => {
				const session = Object.values(params.state.store.sessions).filter((candidate) => candidate.sessionKey === replayParams.sessionKey && candidate.complete).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
				if (!session) return {
					complete: false,
					events: []
				};
				return buildReplay(session);
			});
		}
	};
}
function createInMemoryAcpEventLedger(options = {}) {
	const normalized = normalizeLedgerOptions(options);
	return createLedgerApi({
		state: {
			store: createEmptyStore(),
			...normalized
		},
		mutate: async (fn) => {
			fn();
		},
		read: async (fn) => fn()
	});
}
function resolveDefaultAcpEventLedgerPath(env = process.env) {
	return path.join(resolveStateDir(env), "acp", "event-ledger.json");
}
function createFileAcpEventLedger(params) {
	const normalized = normalizeLedgerOptions(params);
	const state = {
		store: createEmptyStore(),
		...normalized
	};
	let operation = Promise.resolve();
	const load = async () => {
		state.store = normalizeStore(await readJsonFile(params.filePath));
	};
	const ensureParentDir = async () => {
		await fs$1.mkdir(path.dirname(params.filePath), {
			recursive: true,
			mode: 448
		});
	};
	const enqueue = async (fn) => {
		const task = operation.then(fn, fn);
		operation = task.then(() => {}, () => {});
		return task;
	};
	return createLedgerApi({
		state,
		mutate: async (fn) => enqueue(async () => {
			await ensureParentDir();
			await withFileLock(params.filePath, FILE_LEDGER_LOCK_OPTIONS, async () => {
				await load();
				fn();
				await writeTextAtomic(params.filePath, serializeLedgerStore(state.store), {
					mode: 384,
					dirMode: 448
				});
			});
		}),
		read: async (fn) => enqueue(async () => {
			await ensureParentDir();
			return await withFileLock(params.filePath, FILE_LEDGER_LOCK_OPTIONS, async () => {
				await load();
				return fn();
			});
		})
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
		const candidate = normalizeOptionalString(match[1]);
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
		const entry = asOptionalRecord(block);
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
	return escapeInlineControlChars(`${base}: ${Object.entries(args).map(([key, value]) => {
		const raw = typeof value === "string" ? value : JSON.stringify(value);
		return `${key}: ${raw.length > 100 ? `${raw.slice(0, 100)}...` : raw}`;
	}).join(", ")}`);
}
function inferToolKind(name) {
	if (!name) return "other";
	const normalized = normalizeLowercaseStringOrEmpty(name);
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
	if (hasNonEmptyString(value)) return value.trim() ? [{
		type: "content",
		content: {
			type: "text",
			text: value
		}
	}] : void 0;
	const record = asOptionalRecord(value);
	if (!record) return;
	const contents = [];
	const blocks = Array.isArray(record.content) ? record.content : [];
	for (const block of blocks) {
		const entry = asOptionalRecord(block);
		if (entry?.type === "text" && hasNonEmptyString(entry.text)) contents.push({
			type: "content",
			content: {
				type: "text",
				text: entry.text
			}
		});
	}
	if (contents.length > 0) return contents;
	const fallbackText = readStringValue(record.text) ?? readStringValue(record.message) ?? readStringValue(record.error);
	if (!hasNonEmptyString(fallbackText)) return;
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
		const value = normalizeOptionalString(meta[key]);
		if (value) return value;
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
//#region src/acp/permission-relay.ts
const FALLBACK_EXEC_APPROVAL_DECISIONS = ["allow-once", "deny"];
function readNonEmptyString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function normalizeGatewayExecApprovalDecision(value) {
	if (value === "allow-once" || value === "allow-always" || value === "deny") return value;
}
function normalizeGatewayExecApprovalDecisions(value) {
	const normalized = Array.isArray(value) ? value.map(normalizeGatewayExecApprovalDecision).filter((decision) => Boolean(decision)) : [];
	return normalized.length > 0 ? normalized : [...FALLBACK_EXEC_APPROVAL_DECISIONS];
}
function buildAcpPermissionOptions(decisions) {
	const unique = new Set(decisions);
	const options = [];
	if (unique.has("allow-once")) options.push({
		optionId: "allow-once",
		name: "Allow once",
		kind: "allow_once"
	});
	if (unique.has("allow-always")) options.push({
		optionId: "allow-always",
		name: "Allow always",
		kind: "allow_always"
	});
	if (unique.has("deny")) options.push({
		optionId: "deny",
		name: "Deny",
		kind: "reject_once"
	});
	return options.length > 0 ? options : buildAcpPermissionOptions(FALLBACK_EXEC_APPROVAL_DECISIONS);
}
function parseGatewayExecApprovalEventData(data) {
	if (data.phase !== "requested" || data.kind !== "exec" || data.status !== "pending") return null;
	const approvalId = readNonEmptyString(data.approvalId);
	if (!approvalId) return null;
	return {
		approvalId,
		command: readNonEmptyString(data.command),
		host: readNonEmptyString(data.host),
		title: readNonEmptyString(data.title),
		toolCallId: readNonEmptyString(data.toolCallId)
	};
}
function parseGatewayExecApprovalRequestEventPayload(payload) {
	const approvalId = readNonEmptyString(payload.id);
	const request = payload.request;
	if (!approvalId || !request || typeof request !== "object" || Array.isArray(request)) return null;
	const requestRecord = request;
	return {
		approvalId,
		command: readNonEmptyString(requestRecord.command) ?? readNonEmptyString(requestRecord.commandPreview),
		host: readNonEmptyString(requestRecord.host)
	};
}
function buildAcpPermissionRequest(params) {
	const command = readNonEmptyString(params.details?.commandText) ?? readNonEmptyString(params.details?.commandPreview) ?? params.event.command;
	const host = readNonEmptyString(params.details?.host) ?? params.event.host;
	const decisions = normalizeGatewayExecApprovalDecisions(params.details?.allowedDecisions);
	const rawInput = {
		name: "exec",
		approvalId: params.event.approvalId
	};
	if (command) rawInput.command = command;
	if (host) rawInput.host = host;
	return {
		sessionId: params.sessionId,
		toolCall: {
			toolCallId: params.event.toolCallId ?? `exec:${params.event.approvalId}`,
			title: params.event.title ?? "Command approval requested",
			kind: "execute",
			status: "pending",
			rawInput,
			_meta: {
				toolName: "exec",
				approvalId: params.event.approvalId
			}
		},
		options: buildAcpPermissionOptions(decisions)
	};
}
function resolveGatewayDecisionFromPermissionOutcome(response, options) {
	const outcome = response?.outcome;
	if (!outcome || outcome.outcome !== "selected") return;
	return normalizeGatewayExecApprovalDecision(options.find((option) => option.optionId === outcome.optionId)?.optionId);
}
//#endregion
//#region src/acp/session-lineage-meta.ts
const SUBAGENT_ROLES = ["orchestrator", "leaf"];
const SUBAGENT_CONTROL_SCOPES = ["children", "none"];
function readInteger(value) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return;
	return value;
}
function readEnum(value, allowed) {
	const normalized = normalizeOptionalString(value);
	return allowed.find((candidate) => candidate === normalized);
}
function toAcpSessionLineageMeta(row) {
	const sessionKey = normalizeOptionalString(row.key) ?? row.key;
	const kind = normalizeOptionalString(row.kind);
	const channel = normalizeOptionalString(row.channel);
	const parentSessionId = normalizeOptionalString(row.parentSessionKey) ?? normalizeOptionalString(row.spawnedBy);
	const spawnedBy = normalizeOptionalString(row.spawnedBy);
	const spawnDepth = readInteger(row.spawnDepth);
	const subagentRole = readEnum(row.subagentRole, SUBAGENT_ROLES);
	const subagentControlScope = readEnum(row.subagentControlScope, SUBAGENT_CONTROL_SCOPES);
	const spawnedWorkspaceDir = normalizeOptionalString(row.spawnedWorkspaceDir);
	return {
		sessionKey,
		...kind ? { kind } : {},
		...channel ? { channel } : {},
		...parentSessionId ? { parentSessionId } : {},
		...spawnedBy ? { spawnedBy } : {},
		...spawnDepth !== void 0 ? { spawnDepth } : {},
		...subagentRole ? { subagentRole } : {},
		...subagentControlScope ? { subagentControlScope } : {},
		...spawnedWorkspaceDir ? { spawnedWorkspaceDir } : {}
	};
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
			if ("ledgerSessionId" in params) existingSession.ledgerSessionId = params.ledgerSessionId;
			existingSession.cwd = params.cwd;
			touchSession(existingSession, nowMs);
			return existingSession;
		}
		reapIdleSessions(nowMs);
		if (sessions.size >= maxSessions && !evictOldestIdleSession()) throw new Error(`ACP session limit reached (max ${maxSessions}). Close idle ACP clients and retry.`);
		const session = {
			sessionId,
			sessionKey: params.sessionKey,
			...params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {},
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
	const deleteSession = (sessionId) => removeSession(sessionId);
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
		deleteSession,
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
	const normalized = normalizeOptionalLowercaseString(value);
	if (!normalized) return;
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
const ACP_TRACE_LEVEL_CONFIG_ID = "trace_level";
const ACP_REASONING_LEVEL_CONFIG_ID = "reasoning_level";
const ACP_RESPONSE_USAGE_CONFIG_ID = "response_usage";
const ACP_ELEVATED_LEVEL_CONFIG_ID = "elevated_level";
const ACP_TIMEOUT_CONFIG_ID = "timeout";
const ACP_TIMEOUT_SECONDS_CONFIG_ID = "timeout_seconds";
const ACP_LOAD_SESSION_REPLAY_LIMIT = 1e6;
const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5e3;
const ACP_LIST_SESSIONS_DEFAULT_PAGE_SIZE = 100;
const ACP_LIST_SESSIONS_MAX_PAGE_SIZE = 100;
const ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET = 1e4;
const ACP_LIST_SESSIONS_MAX_FETCH_LIMIT = 10101;
let acpCommandsModulePromise;
let acpSdkModulePromise;
async function getAvailableCommandsForAcp() {
	acpCommandsModulePromise ??= import("./commands-C8FmT2tX.js");
	const { getAvailableCommands } = await acpCommandsModulePromise;
	return getAvailableCommands();
}
async function getAcpProtocolVersion() {
	acpSdkModulePromise ??= import("@agentclientprotocol/sdk");
	const { PROTOCOL_VERSION } = await acpSdkModulePromise;
	return PROTOCOL_VERSION;
}
function normalizeClientCapabilities(capabilities) {
	return {
		readTextFile: capabilities?.fs?.readTextFile === true,
		writeTextFile: capabilities?.fs?.writeTextFile === true,
		terminal: capabilities?.terminal === true
	};
}
function isAdminScopeProvenanceRejection(err) {
	if (!(err instanceof Error)) return false;
	const gatewayCode = typeof err.gatewayCode === "string" ? err.gatewayCode : void 0;
	return err.name === "GatewayClientRequestError" && gatewayCode === "INVALID_REQUEST" && err.message.includes("system provenance fields require admin scope");
}
function isGatewayCloseError(err) {
	return err instanceof Error && err.message.startsWith("gateway closed (");
}
function encodeListSessionsCursor(cursor) {
	return Buffer.from(JSON.stringify({
		v: 1,
		...cursor
	}), "utf8").toString("base64url");
}
function decodeListSessionsCursor(value) {
	if (!value) return { offset: 0 };
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw new Error("Invalid ACP session list cursor.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid ACP session list cursor.");
	const record = parsed;
	if (record.v !== 1) throw new Error("Unsupported ACP session list cursor.");
	if (typeof record.offset !== "number" || !Number.isInteger(record.offset) || record.offset < 0 || record.offset > ACP_LIST_SESSIONS_MAX_CURSOR_OFFSET) throw new Error("Invalid ACP session list cursor offset.");
	const cwd = normalizeOptionalString(record.cwd);
	return {
		offset: record.offset,
		...cwd ? { cwd } : {}
	};
}
function assertAbsoluteCwd(cwd, method) {
	if (!path.isAbsolute(cwd)) throw new Error(`ACP ${method} requires an absolute cwd.`);
}
function resolveListSessionsPageSize(meta) {
	const requested = readNumber(meta, ["limit", "pageSize"]);
	if (requested === void 0) return ACP_LIST_SESSIONS_DEFAULT_PAGE_SIZE;
	return Math.min(ACP_LIST_SESSIONS_MAX_PAGE_SIZE, Math.max(1, Math.floor(requested)));
}
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
	const availableLevelIds = row.thinkingLevels?.map((level) => level.id) ?? [...BASE_THINKING_LEVELS];
	const currentModeId = normalizeOptionalString(row.thinkingLevel) || "adaptive";
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
				currentValue: normalizeOptionalString(row.verboseLevel) || "off",
				values: [
					"off",
					"on",
					"full"
				]
			}),
			buildSelectConfigOption({
				id: ACP_TRACE_LEVEL_CONFIG_ID,
				name: "Plugin trace",
				description: "Controls whether plugin-owned trace lines are shown for the session.",
				currentValue: normalizeOptionalString(row.traceLevel) || "off",
				values: ["off", "on"]
			}),
			buildSelectConfigOption({
				id: ACP_REASONING_LEVEL_CONFIG_ID,
				name: "Reasoning stream",
				description: "Controls whether reasoning-capable models emit reasoning text for the session.",
				currentValue: normalizeOptionalString(row.reasoningLevel) || "off",
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
				currentValue: normalizeOptionalString(row.responseUsage) || "off",
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
				currentValue: normalizeOptionalString(row.elevatedLevel) || "off",
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
function extractReplayChunks(message) {
	const role = typeof message.role === "string" ? message.role : "";
	if (role !== "user" && role !== "assistant") return [];
	if (typeof message.content === "string") return message.content.length > 0 ? [{
		sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
		text: message.content
	}] : [];
	if (!Array.isArray(message.content)) return [];
	const replayChunks = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object" || Array.isArray(block)) continue;
		const typedBlock = block;
		if (typedBlock.type === "text" && typeof typedBlock.text === "string" && typedBlock.text) {
			replayChunks.push({
				sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk",
				text: typedBlock.text
			});
			continue;
		}
		if (role === "assistant" && typedBlock.type === "thinking" && typeof typedBlock.thinking === "string" && typedBlock.thinking) replayChunks.push({
			sessionUpdate: "agent_thought_chunk",
			text: typedBlock.thinking
		});
	}
	return replayChunks;
}
function buildSessionMetadata(params) {
	return {
		title: normalizeOptionalString(params.row?.derivedTitle) || normalizeOptionalString(params.row?.displayName) || normalizeOptionalString(params.row?.label) || params.sessionKey,
		updatedAt: typeof params.row?.updatedAt === "number" && Number.isFinite(params.row.updatedAt) ? new Date(params.row.updatedAt).toISOString() : null,
		_meta: toAcpSessionLineageMeta(params.row ?? {
			key: params.sessionKey,
			kind: "unknown"
		})
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
function hasExplicitSessionRouting(meta, opts) {
	return Boolean(meta.sessionKey || meta.sessionLabel || opts.defaultSessionKey || opts.defaultSessionLabel);
}
function resolveLedgerSessionId(session) {
	return session.ledgerSessionId ?? session.sessionId;
}
var AcpGatewayAgent = class {
	getPendingPrompt(sessionId, runId) {
		const pending = this.pendingPrompts.get(sessionId);
		if (pending?.idempotencyKey !== runId) return;
		return pending;
	}
	constructor(connection, gateway, opts = {}) {
		this.pendingPrompts = /* @__PURE__ */ new Map();
		this.approvalRelays = /* @__PURE__ */ new Map();
		this.clientCapabilities = normalizeClientCapabilities(void 0);
		this.clientInfo = null;
		this.disconnectTimer = null;
		this.activeDisconnectContext = null;
		this.disconnectGeneration = 0;
		this.connection = connection;
		this.gateway = gateway;
		this.opts = opts;
		this.log = opts.verbose ? (msg) => process.stderr.write(`[acp] ${msg}\n`) : () => {};
		this.sessionStore = opts.sessionStore ?? defaultAcpSessionStore;
		this.eventLedger = opts.eventLedger ?? createInMemoryAcpEventLedger();
		this.sessionCreateRateLimiter = createFixedWindowRateLimiter({
			maxRequests: Math.max(1, opts.sessionCreateRateLimit?.maxRequests ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_MAX_REQUESTS),
			windowMs: Math.max(1e3, opts.sessionCreateRateLimit?.windowMs ?? SESSION_CREATE_RATE_LIMIT_DEFAULT_WINDOW_MS)
		});
	}
	start() {
		this.log("ready");
	}
	supportsClientReadTextFile() {
		return this.clientCapabilities.readTextFile;
	}
	supportsClientWriteTextFile() {
		return this.clientCapabilities.writeTextFile;
	}
	supportsClientTerminal() {
		return this.clientCapabilities.terminal;
	}
	getClientInfo() {
		return this.clientInfo;
	}
	handleGatewayReconnect() {
		this.log("gateway reconnected");
		const disconnectContext = this.activeDisconnectContext;
		this.activeDisconnectContext = null;
		if (!disconnectContext) return;
		this.reconcilePendingPrompts(disconnectContext.generation, false);
	}
	handleGatewayDisconnect(reason) {
		this.log(`gateway disconnected: ${reason}`);
		const disconnectContext = {
			generation: this.disconnectGeneration + 1,
			reason
		};
		this.disconnectGeneration = disconnectContext.generation;
		this.activeDisconnectContext = disconnectContext;
		if (this.pendingPrompts.size === 0) return;
		for (const pending of this.pendingPrompts.values()) pending.disconnectContext = disconnectContext;
		this.armDisconnectTimer(disconnectContext);
	}
	async handleGatewayEvent(evt) {
		if (evt.event === "chat") {
			await this.handleChatEvent(evt);
			return;
		}
		if (evt.event === "exec.approval.requested") {
			this.handleExecApprovalRequestEvent(evt);
			return;
		}
		if (evt.event === "agent") await this.handleAgentEvent(evt);
	}
	async initialize(params) {
		this.clientCapabilities = normalizeClientCapabilities(params.clientCapabilities);
		this.clientInfo = params.clientInfo ?? null;
		return {
			protocolVersion: await getAcpProtocolVersion(),
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
				sessionCapabilities: {
					list: {},
					resume: {},
					close: {}
				}
			},
			agentInfo: ACP_AGENT_INFO,
			authMethods: []
		};
	}
	async newSession(params) {
		this.assertSupportedSessionSetup(params.mcpServers);
		this.enforceSessionCreateRateLimit("newSession");
		const sessionId = randomUUID();
		const meta = parseSessionMeta(params["_meta"]);
		const sessionKey = await this.resolveSessionKeyFromMeta({
			meta,
			fallbackKey: `acp:${sessionId}`
		});
		const session = this.sessionStore.createSession({
			sessionId,
			sessionKey,
			cwd: params.cwd
		});
		await this.startLedgerSession(session, {
			complete: true,
			reset: true
		});
		this.log(`newSession: ${session.sessionId} -> ${session.sessionKey}`);
		const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey);
		await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
			includeControls: false,
			record: true
		});
		await this.sendAvailableCommands(session, { record: true });
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
		const meta = parseSessionMeta(params["_meta"]);
		const hasExplicitRouting = hasExplicitSessionRouting(meta, this.opts);
		const exactLedgerReplay = hasExplicitRouting ? {
			complete: false,
			events: []
		} : await this.readLedgerReplayBySessionId(params.sessionId);
		const listedLedgerReplay = !hasExplicitRouting && !exactLedgerReplay.complete ? await this.readLedgerReplayBySessionKey(params.sessionId) : {
			complete: false,
			events: []
		};
		const routedLedgerReplay = exactLedgerReplay.complete ? exactLedgerReplay : listedLedgerReplay;
		const sessionKey = await this.resolveSessionKeyFromMeta({
			meta,
			fallbackKey: routedLedgerReplay.sessionKey ?? params.sessionId
		});
		const ledgerReplay = exactLedgerReplay.complete && exactLedgerReplay.sessionKey === sessionKey ? exactLedgerReplay : listedLedgerReplay.complete && listedLedgerReplay.sessionKey === sessionKey ? listedLedgerReplay : await this.readLedgerReplay({
			sessionId: params.sessionId,
			sessionKey
		});
		const session = this.sessionStore.createSession({
			sessionId: params.sessionId,
			sessionKey,
			...ledgerReplay.sessionId ? { ledgerSessionId: ledgerReplay.sessionId } : {},
			cwd: params.cwd
		});
		await this.startLedgerSession(session, { complete: ledgerReplay.complete });
		this.log(`loadSession: ${session.sessionId} -> ${session.sessionKey}`);
		const [sessionSnapshot, transcript] = await Promise.all([this.getSessionSnapshot(session.sessionKey), ledgerReplay.complete ? Promise.resolve([]) : this.getSessionTranscript(session.sessionKey).catch((err) => {
			this.log(`session transcript fallback for ${session.sessionKey}: ${String(err)}`);
			return [];
		})]);
		if (ledgerReplay.complete) await this.replayLedgerSession(session.sessionId, ledgerReplay);
		else await this.replaySessionTranscript(session.sessionId, transcript);
		await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
			includeControls: false,
			record: false
		});
		await this.sendAvailableCommands(session, { record: false });
		const { configOptions, modes } = sessionSnapshot;
		return {
			configOptions,
			modes
		};
	}
	async listSessions(params) {
		const requestedCwd = normalizeOptionalString(params.cwd);
		if (requestedCwd) assertAbsoluteCwd(requestedCwd, "session/list");
		const fallbackCwd = requestedCwd ?? process.cwd();
		const rawCursor = normalizeOptionalString(params.cursor);
		const cursor = decodeListSessionsCursor(rawCursor);
		if (rawCursor && cursor.cwd !== requestedCwd) throw new Error("ACP session list cursor does not match the cwd filter.");
		const pageSize = resolveListSessionsPageSize(params["_meta"]);
		const start = cursor.offset;
		const end = start + pageSize;
		let fetchLimit = end + 1;
		let rows = [];
		while (true) {
			const result = await this.gateway.request("sessions.list", {
				limit: fetchLimit,
				includeDerivedTitles: true
			});
			rows = result.sessions.filter((session) => {
				if (!requestedCwd) return true;
				return normalizeOptionalString(session.spawnedWorkspaceDir) === requestedCwd;
			}).map((session) => this.mapGatewaySessionToAcpSessionInfo(session, fallbackCwd));
			if (rows.length > end || result.hasMore !== true || fetchLimit >= ACP_LIST_SESSIONS_MAX_FETCH_LIMIT) break;
			fetchLimit = Math.min(fetchLimit * 2, ACP_LIST_SESSIONS_MAX_FETCH_LIMIT);
		}
		return {
			sessions: rows.slice(start, end),
			nextCursor: rows.length > end ? encodeListSessionsCursor({
				offset: end,
				...requestedCwd ? { cwd: requestedCwd } : {}
			}) : null
		};
	}
	async resumeSession(params) {
		this.assertSupportedSessionSetup(params.mcpServers ?? []);
		assertAbsoluteCwd(params.cwd, "session/resume");
		const existingSession = this.sessionStore.getSession(params.sessionId);
		if (!existingSession) this.enforceSessionCreateRateLimit("resumeSession");
		const meta = parseSessionMeta(params["_meta"]);
		const fallbackKey = existingSession?.sessionKey ?? params.sessionId;
		const sessionKey = await this.resolveSessionKeyFromMeta({
			meta,
			fallbackKey
		});
		const sessionSnapshot = !existingSession || sessionKey !== existingSession.sessionKey ? await this.getExistingSessionSnapshot(sessionKey) : await this.getSessionSnapshot(sessionKey);
		const session = this.sessionStore.createSession({
			sessionId: params.sessionId,
			sessionKey,
			cwd: params.cwd
		});
		await this.startLedgerSession(session, { complete: false });
		this.log(`resumeSession: ${session.sessionId} -> ${session.sessionKey}`);
		await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
			includeControls: false,
			record: false
		});
		await this.sendAvailableCommands(session, { record: false });
		const { configOptions, modes } = sessionSnapshot;
		return {
			configOptions,
			modes
		};
	}
	async closeSession(params) {
		const session = this.sessionStore.getSession(params.sessionId);
		if (!session) throw new Error(`Session ${params.sessionId} not found`);
		await this.cancelSessionWork(session);
		this.sessionStore.deleteSession(params.sessionId);
		this.log(`closeSession: ${params.sessionId}`);
		return {};
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
			await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
				includeControls: true,
				record: true
			});
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
			if (sessionPatch.patch) await this.gateway.request("sessions.patch", {
				key: session.sessionKey,
				...sessionPatch.patch
			});
			this.log(`setSessionConfigOption: ${session.sessionId} -> ${params.configId}=${params.value}`);
			const sessionSnapshot = await this.getSessionSnapshot(session.sessionKey, sessionPatch.overrides);
			await this.sendSessionSnapshotUpdate(session, sessionSnapshot, {
				includeControls: true,
				record: true
			});
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
		const meta = parseSessionMeta(params["_meta"]);
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
		const requestParams = {
			sessionKey: session.sessionKey,
			message,
			attachments: attachments.length > 0 ? attachments : void 0,
			idempotencyKey: runId,
			thinking: readString(params["_meta"], ["thinking", "thinkingLevel"]),
			deliver: readBool(params["_meta"], ["deliver"]),
			timeoutMs: readNumber(params["_meta"], ["timeoutMs"])
		};
		return new Promise((resolve, reject) => {
			this.pendingPrompts.set(params.sessionId, {
				sessionId: params.sessionId,
				sessionKey: session.sessionKey,
				...session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {},
				idempotencyKey: runId,
				disconnectContext: this.activeDisconnectContext ?? void 0,
				resolve,
				reject
			});
			if (this.activeDisconnectContext && !this.disconnectTimer) this.armDisconnectTimer(this.activeDisconnectContext);
			const sendWithProvenanceFallback = async () => {
				const markSendAccepted = () => {
					const pending = this.getPendingPrompt(params.sessionId, runId);
					if (pending) pending.sendAccepted = true;
				};
				try {
					await this.gateway.request("chat.send", {
						...requestParams,
						systemInputProvenance,
						systemProvenanceReceipt
					}, { timeoutMs: null });
					markSendAccepted();
					await this.recordUserPrompt(session, runId, params.prompt);
				} catch (err) {
					if ((systemInputProvenance || systemProvenanceReceipt) && isAdminScopeProvenanceRejection(err)) {
						await this.gateway.request("chat.send", requestParams, { timeoutMs: null });
						markSendAccepted();
						await this.recordUserPrompt(session, runId, params.prompt);
						return;
					}
					throw err;
				}
			};
			sendWithProvenanceFallback().catch((err) => {
				if (isGatewayCloseError(err) && this.getPendingPrompt(params.sessionId, runId)) return;
				this.clearApprovalRelaysForPrompt(params.sessionId, runId, { denyActive: true });
				this.pendingPrompts.delete(params.sessionId);
				this.sessionStore.clearActiveRun(params.sessionId);
				if (this.pendingPrompts.size === 0) this.clearDisconnectTimer();
				reject(err instanceof Error ? err : new Error(String(err)));
			});
		});
	}
	async cancel(params) {
		const session = this.sessionStore.getSession(params.sessionId);
		if (!session) return;
		await this.cancelSessionWork(session);
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
		if (stream === "approval") {
			await this.handleApprovalEvent({
				sessionKey,
				runId,
				data
			});
			return;
		}
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
			await this.emitSessionUpdate({
				sessionId: pending.sessionId,
				sessionKey: pending.sessionKey,
				...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},
				runId: pending.idempotencyKey,
				record: true,
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
			await this.emitSessionUpdate({
				sessionId: pending.sessionId,
				sessionKey: pending.sessionKey,
				...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},
				runId: pending.idempotencyKey,
				record: true,
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
			await this.emitSessionUpdate({
				sessionId: pending.sessionId,
				sessionKey: pending.sessionKey,
				...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},
				runId: pending.idempotencyKey,
				record: true,
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
	async handleApprovalEvent(params) {
		const approvalEvent = parseGatewayExecApprovalEventData(params.data);
		if (!approvalEvent) return;
		this.startApprovalRelay({
			sessionKey: params.sessionKey,
			runId: params.runId,
			approvalEvent
		});
	}
	handleExecApprovalRequestEvent(evt) {
		const payload = evt.payload;
		if (!payload) return;
		const approvalEvent = parseGatewayExecApprovalRequestEventPayload(payload);
		if (!approvalEvent) return;
		const request = payload.request;
		const sessionKey = normalizeOptionalString(request?.sessionKey);
		if (!sessionKey) return;
		this.startApprovalRelay({
			sessionKey,
			approvalEvent
		});
	}
	startApprovalRelay(params) {
		const approvalEvent = params.approvalEvent;
		if (this.approvalRelays.has(approvalEvent.approvalId)) return;
		const pending = params.runId ? this.findPendingBySessionKey(params.sessionKey, params.runId) : this.findUniquePendingBySessionKey(params.sessionKey);
		if (!pending) return;
		const relay = {
			approvalId: approvalEvent.approvalId,
			runId: pending.idempotencyKey,
			sessionId: pending.sessionId,
			sessionKey: pending.sessionKey,
			state: "active"
		};
		this.approvalRelays.set(relay.approvalId, relay);
		this.runApprovalRelay(relay, approvalEvent);
	}
	async runApprovalRelay(relay, approvalEvent) {
		let resolved = false;
		try {
			const details = await this.getGatewayApprovalDetails(relay.approvalId);
			if (!this.isApprovalRelayActive(relay)) {
				resolved = await this.resolveGatewayApproval(relay.approvalId, "deny");
				return;
			}
			const request = buildAcpPermissionRequest({
				sessionId: relay.sessionId,
				event: approvalEvent,
				details
			});
			let decision;
			try {
				decision = resolveGatewayDecisionFromPermissionOutcome(await this.connection.requestPermission(request), request.options);
			} catch (err) {
				this.log(`approval relay request failed for ${relay.approvalId}: ${String(err)}`);
			}
			const selectedDecision = this.isApprovalRelayActive(relay) && decision ? decision : "deny";
			resolved = await this.resolveGatewayApproval(relay.approvalId, selectedDecision);
		} finally {
			const current = this.approvalRelays.get(relay.approvalId);
			if (current === relay && current.state === "active") if (resolved) current.state = "completed";
			else this.approvalRelays.delete(relay.approvalId);
		}
	}
	async getGatewayApprovalDetails(approvalId) {
		try {
			return await this.gateway.request("exec.approval.get", { id: approvalId });
		} catch (err) {
			this.log(`approval relay hydrate failed for ${approvalId}: ${String(err)}`);
			return null;
		}
	}
	async resolveGatewayApproval(approvalId, decision) {
		try {
			await this.gateway.request("exec.approval.resolve", {
				id: approvalId,
				decision
			});
			return true;
		} catch (err) {
			this.log(`approval relay resolve failed for ${approvalId}: ${String(err)}`);
			return false;
		}
	}
	isApprovalRelayActive(relay) {
		return this.approvalRelays.get(relay.approvalId) === relay && relay.state === "active" && this.getPendingPrompt(relay.sessionId, relay.runId) !== void 0;
	}
	clearApprovalRelaysForPrompt(sessionId, runId, opts = {}) {
		for (const [approvalId, relay] of this.approvalRelays) {
			if (relay.sessionId !== sessionId) continue;
			if (runId && relay.runId !== runId) continue;
			this.approvalRelays.delete(approvalId);
			if (opts.denyActive && relay.state === "active") this.resolveGatewayApproval(approvalId, "deny");
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
		if (state === "error") {
			const stopReason = payload.errorKind === "refusal" ? "refusal" : "end_turn";
			this.finishPrompt(pending.sessionId, pending, stopReason);
		}
	}
	async handleDeltaEvent(sessionId, messageData) {
		const content = messageData.content;
		const pending = this.pendingPrompts.get(sessionId);
		if (!pending) return;
		const fullThought = content?.filter((block) => block?.type === "thinking").map((block) => block.thinking ?? "").join("\n").trimEnd();
		const sentThoughtSoFar = pending.sentThoughtLength ?? 0;
		if (fullThought && fullThought.length > sentThoughtSoFar) {
			const newThought = fullThought.slice(sentThoughtSoFar);
			pending.sentThoughtLength = fullThought.length;
			pending.sentThought = fullThought;
			await this.emitSessionUpdate({
				sessionId,
				sessionKey: pending.sessionKey,
				...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},
				runId: pending.idempotencyKey,
				record: true,
				update: {
					sessionUpdate: "agent_thought_chunk",
					content: {
						type: "text",
						text: newThought
					}
				}
			});
		}
		const fullText = content?.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n").trimEnd();
		const sentSoFar = pending.sentTextLength ?? 0;
		if (!fullText || fullText.length <= sentSoFar) return;
		const newText = fullText.slice(sentSoFar);
		pending.sentTextLength = fullText.length;
		pending.sentText = fullText;
		await this.emitSessionUpdate({
			sessionId,
			sessionKey: pending.sessionKey,
			...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {},
			runId: pending.idempotencyKey,
			record: true,
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
		this.clearApprovalRelaysForPrompt(sessionId, pending.idempotencyKey, { denyActive: true });
		this.pendingPrompts.delete(sessionId);
		this.sessionStore.clearActiveRun(sessionId);
		if (this.pendingPrompts.size === 0) this.clearDisconnectTimer();
		const sessionSnapshot = await this.getSessionSnapshot(pending.sessionKey);
		try {
			await this.sendSessionSnapshotUpdate({
				sessionId,
				sessionKey: pending.sessionKey,
				...pending.ledgerSessionId ? { ledgerSessionId: pending.ledgerSessionId } : {}
			}, sessionSnapshot, {
				includeControls: false,
				record: true,
				runId: pending.idempotencyKey
			});
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
		if (runId) for (const pending of this.pendingPrompts.values()) {
			if (pending.idempotencyKey !== runId) continue;
			this.reconcilePendingSessionKey(pending, sessionKey);
			return pending;
		}
	}
	findUniquePendingBySessionKey(sessionKey) {
		let match;
		for (const pending of this.pendingPrompts.values()) {
			if (pending.sessionKey !== sessionKey) continue;
			if (match) return;
			match = pending;
		}
		return match;
	}
	reconcilePendingSessionKey(pending, sessionKey) {
		if (pending.sessionKey === sessionKey) return;
		this.log(`session key reconciled: ${pending.sessionKey} -> ${sessionKey}`);
		pending.sessionKey = sessionKey;
		const session = this.sessionStore.getSession(pending.sessionId);
		if (session?.activeRunId === pending.idempotencyKey) session.sessionKey = sessionKey;
	}
	clearDisconnectTimer() {
		if (!this.disconnectTimer) return;
		clearTimeout(this.disconnectTimer);
		this.disconnectTimer = null;
	}
	armDisconnectTimer(disconnectContext) {
		this.clearDisconnectTimer();
		this.disconnectTimer = setTimeout(() => {
			this.disconnectTimer = null;
			this.reconcilePendingPrompts(disconnectContext.generation, true);
		}, ACP_GATEWAY_DISCONNECT_GRACE_MS);
		this.disconnectTimer.unref?.();
	}
	rejectPendingPrompt(pending, error) {
		if (this.getPendingPrompt(pending.sessionId, pending.idempotencyKey) !== pending) return;
		this.clearApprovalRelaysForPrompt(pending.sessionId, pending.idempotencyKey, { denyActive: true });
		this.pendingPrompts.delete(pending.sessionId);
		this.sessionStore.clearActiveRun(pending.sessionId);
		if (this.pendingPrompts.size === 0) this.clearDisconnectTimer();
		pending.reject(error);
	}
	clearPendingDisconnectState(pending, disconnectContext) {
		if (pending.disconnectContext !== disconnectContext) return;
		pending.disconnectContext = void 0;
	}
	shouldRejectPendingAtDisconnectDeadline(pending, disconnectContext) {
		return pending.disconnectContext === disconnectContext && (!pending.sendAccepted || this.activeDisconnectContext?.generation === disconnectContext.generation);
	}
	async reconcilePendingPrompts(observedDisconnectGeneration, deadlineExpired) {
		if (this.pendingPrompts.size === 0) {
			if (this.disconnectGeneration === observedDisconnectGeneration) this.clearDisconnectTimer();
			return;
		}
		const pendingEntries = [...this.pendingPrompts.entries()];
		let keepDisconnectTimer = false;
		for (const [sessionId, pending] of pendingEntries) {
			if (this.pendingPrompts.get(sessionId) !== pending) continue;
			if (pending.disconnectContext?.generation !== observedDisconnectGeneration) continue;
			if (await this.reconcilePendingPrompt(sessionId, pending, deadlineExpired)) keepDisconnectTimer = true;
		}
		if (!keepDisconnectTimer && this.disconnectGeneration === observedDisconnectGeneration) this.clearDisconnectTimer();
	}
	async reconcilePendingPrompt(sessionId, pending, deadlineExpired) {
		const disconnectContext = pending.disconnectContext;
		if (!disconnectContext) return false;
		let result;
		try {
			result = await this.gateway.request("agent.wait", {
				runId: pending.idempotencyKey,
				timeoutMs: 0
			}, { timeoutMs: null });
		} catch (err) {
			this.log(`agent.wait reconcile failed for ${pending.idempotencyKey}: ${String(err)}`);
			if (deadlineExpired) {
				if (this.shouldRejectPendingAtDisconnectDeadline(pending, disconnectContext)) {
					this.rejectPendingPrompt(pending, /* @__PURE__ */ new Error(`Gateway disconnected: ${disconnectContext.reason}`));
					return false;
				}
				this.clearPendingDisconnectState(pending, disconnectContext);
				return false;
			}
			return true;
		}
		const currentPending = this.getPendingPrompt(sessionId, pending.idempotencyKey);
		if (!currentPending) return false;
		if (result?.status === "ok") {
			await this.finishPrompt(sessionId, currentPending, "end_turn");
			return false;
		}
		if (result?.status === "error") {
			this.finishPrompt(sessionId, currentPending, "end_turn");
			return false;
		}
		if (deadlineExpired) {
			if (this.shouldRejectPendingAtDisconnectDeadline(currentPending, disconnectContext)) {
				const currentDisconnectContext = currentPending.disconnectContext;
				if (!currentDisconnectContext) return false;
				this.rejectPendingPrompt(currentPending, /* @__PURE__ */ new Error(`Gateway disconnected: ${currentDisconnectContext.reason}`));
				return false;
			}
			this.clearPendingDisconnectState(currentPending, disconnectContext);
			return false;
		}
		return true;
	}
	async startLedgerSession(session, options) {
		try {
			await this.eventLedger.startSession({
				sessionId: resolveLedgerSessionId(session),
				sessionKey: session.sessionKey,
				cwd: session.cwd,
				complete: options.complete,
				...options.reset ? { reset: true } : {}
			});
		} catch (err) {
			this.log(`event ledger session start failed for ${session.sessionId}: ${String(err)}`);
		}
	}
	async readLedgerReplay(params) {
		try {
			return await this.eventLedger.readReplay(params);
		} catch (err) {
			this.log(`event ledger replay fallback for ${params.sessionId}: ${String(err)}`);
			return {
				complete: false,
				events: []
			};
		}
	}
	async readLedgerReplayBySessionId(sessionId) {
		try {
			return await this.eventLedger.readReplayBySessionId({ sessionId });
		} catch (err) {
			this.log(`event ledger exact replay fallback for ${sessionId}: ${String(err)}`);
			return {
				complete: false,
				events: []
			};
		}
	}
	async readLedgerReplayBySessionKey(sessionKey) {
		try {
			return await this.eventLedger.readReplayBySessionKey({ sessionKey });
		} catch (err) {
			this.log(`event ledger session-key replay fallback for ${sessionKey}: ${String(err)}`);
			return {
				complete: false,
				events: []
			};
		}
	}
	async recordUserPrompt(session, runId, prompt) {
		try {
			await this.eventLedger.recordUserPrompt({
				sessionId: resolveLedgerSessionId(session),
				sessionKey: session.sessionKey,
				runId,
				prompt
			});
		} catch (err) {
			this.log(`event ledger prompt record failed for ${session.sessionId}: ${String(err)}`);
			await this.markLedgerIncomplete(session);
		}
	}
	async recordLedgerUpdate(params) {
		try {
			await this.eventLedger.recordUpdate({
				sessionId: params.ledgerSessionId ?? params.sessionId,
				sessionKey: params.sessionKey,
				...params.runId ? { runId: params.runId } : {},
				update: params.update
			});
		} catch (err) {
			this.log(`event ledger update record failed for ${params.sessionId}: ${String(err)}`);
			await this.markLedgerIncomplete({
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				...params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {}
			});
		}
	}
	async markLedgerIncomplete(session) {
		try {
			await this.eventLedger.markIncomplete({
				sessionId: resolveLedgerSessionId(session),
				sessionKey: session.sessionKey
			});
		} catch (err) {
			this.log(`event ledger incomplete mark failed for ${session.sessionId}: ${String(err)}`);
		}
	}
	async emitSessionUpdate(params) {
		await this.connection.sessionUpdate({
			sessionId: params.sessionId,
			update: params.update
		});
		if (params.record && params.sessionKey) await this.recordLedgerUpdate({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			...params.ledgerSessionId ? { ledgerSessionId: params.ledgerSessionId } : {},
			...params.runId ? { runId: params.runId } : {},
			update: params.update
		});
	}
	async sendAvailableCommands(session, options) {
		await this.emitSessionUpdate({
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			...session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {},
			record: options.record,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await getAvailableCommandsForAcp()
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
	async getExistingSessionSnapshot(sessionKey) {
		const row = await this.getGatewaySessionRow(sessionKey);
		if (!row) throw new Error(`Session ${sessionKey} not found`);
		return {
			...buildSessionPresentation({ row }),
			metadata: buildSessionMetadata({
				row,
				sessionKey
			}),
			usage: buildSessionUsageSnapshot(row)
		};
	}
	mapGatewaySessionToAcpSessionInfo(session, fallbackCwd) {
		const cwd = normalizeOptionalString(session.spawnedWorkspaceDir) ?? fallbackCwd;
		return {
			sessionId: session.key,
			cwd,
			title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
			updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : void 0,
			_meta: toAcpSessionLineageMeta(session)
		};
	}
	async cancelSessionWork(session) {
		const activeRunId = session.activeRunId;
		this.sessionStore.cancelActiveRun(session.sessionId);
		const pending = this.pendingPrompts.get(session.sessionId);
		const scopedRunId = activeRunId ?? pending?.idempotencyKey;
		if (scopedRunId) try {
			await this.gateway.request("chat.abort", {
				sessionKey: session.sessionKey,
				runId: scopedRunId
			});
		} catch (err) {
			this.log(`cancel error: ${String(err)}`);
		}
		if (pending) {
			this.clearApprovalRelaysForPrompt(session.sessionId, pending.idempotencyKey, { denyActive: true });
			this.pendingPrompts.delete(session.sessionId);
			if (this.pendingPrompts.size === 0) this.clearDisconnectTimer();
			pending.resolve({ stopReason: "cancelled" });
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
			key: session.key,
			kind: session.kind,
			channel: session.channel,
			parentSessionKey: session.parentSessionKey,
			spawnedBy: session.spawnedBy,
			spawnDepth: session.spawnDepth,
			subagentRole: session.subagentRole,
			subagentControlScope: session.subagentControlScope,
			spawnedWorkspaceDir: session.spawnedWorkspaceDir,
			displayName: session.displayName,
			label: session.label,
			derivedTitle: session.derivedTitle,
			updatedAt: session.updatedAt,
			thinkingLevel: session.thinkingLevel,
			thinkingLevels: session.thinkingLevels,
			modelProvider: session.modelProvider,
			model: session.model,
			fastMode: session.fastMode,
			verboseLevel: session.verboseLevel,
			traceLevel: session.traceLevel,
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
			case ACP_TRACE_LEVEL_CONFIG_ID: return {
				patch: { traceLevel: value },
				overrides: { traceLevel: value }
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
			case ACP_TIMEOUT_CONFIG_ID:
			case ACP_TIMEOUT_SECONDS_CONFIG_ID: return { overrides: {} };
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
			const replayChunks = extractReplayChunks(message);
			for (const chunk of replayChunks) await this.emitSessionUpdate({
				sessionId,
				update: {
					sessionUpdate: chunk.sessionUpdate,
					content: {
						type: "text",
						text: chunk.text
					}
				}
			});
		}
	}
	async replayLedgerSession(sessionId, ledgerReplay) {
		for (const event of ledgerReplay.events) await this.emitSessionUpdate({
			sessionId,
			update: event.update,
			record: false
		});
	}
	async sendSessionSnapshotUpdate(session, sessionSnapshot, options) {
		if (options.includeControls) {
			await this.emitSessionUpdate({
				sessionId: session.sessionId,
				sessionKey: session.sessionKey,
				...session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {},
				runId: options.runId,
				record: options.record,
				update: {
					sessionUpdate: "current_mode_update",
					currentModeId: sessionSnapshot.modes.currentModeId
				}
			});
			await this.emitSessionUpdate({
				sessionId: session.sessionId,
				sessionKey: session.sessionKey,
				...session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {},
				runId: options.runId,
				record: options.record,
				update: {
					sessionUpdate: "config_option_update",
					configOptions: sessionSnapshot.configOptions
				}
			});
		}
		if (sessionSnapshot.metadata) await this.emitSessionUpdate({
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			...session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {},
			runId: options.runId,
			record: options.record,
			update: {
				sessionUpdate: "session_info_update",
				...sessionSnapshot.metadata
			}
		});
		if (sessionSnapshot.usage) await this.emitSessionUpdate({
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			...session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {},
			runId: options.runId,
			record: options.record,
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
	routeLogsToStderr();
	const bootstrap = await resolveGatewayClientBootstrap({
		config: getRuntimeConfig(),
		gatewayUrl: opts.gatewayUrl,
		explicitAuth: {
			token: opts.gatewayToken,
			password: opts.gatewayPassword
		},
		env: process.env
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
		url: bootstrap.url,
		token: bootstrap.auth.token,
		password: bootstrap.auth.password,
		preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
		clientName: GATEWAY_CLIENT_NAMES.CLI,
		clientDisplayName: "ACP",
		clientVersion: "acp",
		mode: GATEWAY_CLIENT_MODES.CLI,
		caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
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
	if (!(await startGatewayClientWhenEventLoopReady(gateway, { clientOptions: { preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs } })).ready) rejectGatewayReady(/* @__PURE__ */ new Error("gateway event loop readiness timeout"));
	await gatewayReady.catch((err) => {
		shutdown();
		throw err;
	});
	if (stopped) return closed;
	const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
	const eventLedger = createFileAcpEventLedger({ filePath: resolveDefaultAcpEventLedgerPath(process.env) });
	new AgentSideConnection((conn) => {
		agent = new AcpGatewayAgent(conn, gateway, {
			...opts,
			eventLedger
		});
		agent.start();
		return agent;
	}, stream);
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
	const gatewayToken = normalizeOptionalString(opts.gatewayToken);
	const gatewayPassword = normalizeOptionalString(opts.gatewayPassword);
	const normalizedTokenFile = normalizeOptionalString(tokenFile);
	const normalizedPasswordFile = normalizeOptionalString(passwordFile);
	if (gatewayToken && normalizedTokenFile) throw new Error("Use either --token or --token-file.");
	if (gatewayPassword && normalizedPasswordFile) throw new Error("Use either --password or --password-file.");
	if (normalizedTokenFile) opts.gatewayToken = readSecretFromFile(normalizedTokenFile, "Gateway token");
	if (normalizedPasswordFile) opts.gatewayPassword = readSecretFromFile(normalizedPasswordFile, "Gateway password");
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
function registerAcpCli(program) {
	const acp = program.command("acp").description("Run an ACP bridge backed by the Gateway");
	acp.option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--token-file <path>", "Read gateway token from file").option("--password <password>", "Gateway password (if required)").option("--password-file <path>", "Read gateway password from file").option("--session <key>", "Default session key (e.g. agent:main:main)").option("--session-label <label>", "Default session label to resolve").option("--require-existing", "Fail if the session key/label does not exist", false).option("--reset-session", "Reset the session key before first use", false).option("--no-prefix-cwd", "Do not prefix prompts with the working directory").option("--provenance <mode>", "ACP provenance mode: off, meta, or meta+receipt").option("-v, --verbose", "Verbose logging to stderr", false).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/acp", "docs.openclaw.ai/cli/acp")}\n`).action(async (opts) => {
		try {
			const { gatewayToken, gatewayPassword } = resolveGatewayAuthOptions(opts);
			const provenanceMode = normalizeAcpProvenanceMode(opts.provenance);
			if (opts.provenance && !provenanceMode) throw new Error("Invalid --provenance. Use \"off\", \"meta\", or \"meta+receipt\".");
			await serveAcpGateway({
				gatewayUrl: opts.url,
				gatewayToken,
				gatewayPassword,
				defaultSessionKey: opts.session,
				defaultSessionLabel: opts.sessionLabel,
				requireExistingSession: Boolean(opts.requireExisting),
				resetSession: Boolean(opts.resetSession),
				prefixCwd: opts.prefixCwd !== false,
				provenanceMode,
				verbose: Boolean(opts.verbose)
			});
		} catch (err) {
			defaultRuntime.error(`ACP bridge failed: ${formatErrorMessage(err)}`);
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
			defaultRuntime.error(formatErrorMessage(err));
			defaultRuntime.exit(1);
		}
	});
}
//#endregion
export { registerAcpCli };
