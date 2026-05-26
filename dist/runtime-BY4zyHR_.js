import { s as redactSensitiveText } from "./redact-ok5Q8nmw.js";
import { n as AcpRuntimeError$1 } from "./errors-BgH2aVJW.js";
import "./security-runtime-CcSekjBd.js";
import "./runtime-api-woL2syfn.js";
import { a as splitCommandParts, d as hashAcpxProcessCommand, f as withAcpxLeaseEnvironment, l as createAcpxProcessLeaseId, n as isOpenClawLeaseAwareAcpxProcessCommand, t as cleanupOpenClawOwnedAcpxProcessTree } from "./process-reaper-DKzsV1k3.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path, { resolve } from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import readline from "node:readline/promises";
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
//#region node_modules/acpx/dist/live-checkpoint-B9ctAuqV.js
var AcpxOperationalError = class extends Error {
	outputCode;
	detailCode;
	origin;
	retryable;
	acp;
	outputAlreadyEmitted;
	constructor(message, options) {
		super(message, options);
		this.name = new.target.name;
		this.outputCode = options?.outputCode;
		this.detailCode = options?.detailCode;
		this.origin = options?.origin;
		this.retryable = options?.retryable;
		this.acp = options?.acp;
		this.outputAlreadyEmitted = options?.outputAlreadyEmitted;
	}
};
var AgentSpawnError = class extends AcpxOperationalError {
	agentCommand;
	constructor(agentCommand, cause) {
		super(`Failed to spawn agent command: ${agentCommand}`, { cause: cause instanceof Error ? cause : void 0 });
		this.agentCommand = agentCommand;
	}
};
var AgentStartupError = class extends AcpxOperationalError {
	agentCommand;
	exitCode;
	signal;
	stderrSummary;
	constructor(params) {
		const exitSummary = `exit=${params.exitCode ?? "null"}, signal=${params.signal ?? "null"}`;
		const stderrSuffix = typeof params.stderrSummary === "string" && params.stderrSummary.trim().length > 0 ? `: ${params.stderrSummary.trim()}` : "";
		super(`ACP agent exited before initialize completed (${exitSummary})${stderrSuffix}`, {
			cause: params.cause instanceof Error ? params.cause : void 0,
			outputCode: "RUNTIME",
			detailCode: "AGENT_STARTUP_FAILED",
			origin: "acp"
		});
		this.agentCommand = params.agentCommand;
		this.exitCode = params.exitCode;
		this.signal = params.signal;
		this.stderrSummary = params.stderrSummary?.trim() || void 0;
	}
};
var AgentDisconnectedError = class extends AcpxOperationalError {
	reason;
	exitCode;
	signal;
	constructor(reason, exitCode, signal, options) {
		super(`ACP agent disconnected during request (${reason}, exit=${exitCode ?? "null"}, signal=${signal ?? "null"})`, {
			outputCode: "RUNTIME",
			detailCode: "AGENT_DISCONNECTED",
			origin: "acp",
			...options
		});
		this.reason = reason;
		this.exitCode = exitCode;
		this.signal = signal;
	}
};
var SessionResumeRequiredError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_RESUME_REQUIRED",
			origin: "acp",
			retryable: true,
			...options
		});
	}
};
var GeminiAcpStartupTimeoutError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "TIMEOUT",
			detailCode: "GEMINI_ACP_STARTUP_TIMEOUT",
			origin: "acp",
			...options
		});
	}
};
var SessionModeReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_MODE_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var SessionModelReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_MODEL_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var SessionConfigOptionReplayError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "SESSION_CONFIG_OPTION_REPLAY_FAILED",
			origin: "acp",
			...options
		});
	}
};
var ClaudeAcpSessionCreateTimeoutError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "TIMEOUT",
			detailCode: "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
			origin: "acp",
			...options
		});
	}
};
var CopilotAcpUnsupportedError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "COPILOT_ACP_UNSUPPORTED",
			origin: "acp",
			...options
		});
	}
};
var AuthPolicyError = class extends AcpxOperationalError {
	constructor(message, options) {
		super(message, {
			outputCode: "RUNTIME",
			detailCode: "AUTH_REQUIRED",
			origin: "acp",
			...options
		});
	}
};
var PermissionDeniedError = class extends AcpxOperationalError {};
var PermissionPromptUnavailableError = class extends AcpxOperationalError {
	constructor() {
		super("Permission prompt unavailable in non-interactive mode");
	}
};
const OUTPUT_ERROR_CODES = [
	"NO_SESSION",
	"TIMEOUT",
	"PERMISSION_DENIED",
	"PERMISSION_PROMPT_UNAVAILABLE",
	"RUNTIME",
	"USAGE"
];
const OUTPUT_ERROR_ORIGINS = [
	"cli",
	"runtime",
	"queue",
	"acp"
];
const SESSION_RECORD_SCHEMA = "acpx.session.v1";
const RESOURCE_NOT_FOUND_ACP_CODES = new Set([-32001, -32002]);
function asRecord$7(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function toAcpErrorPayload(value) {
	const record = asRecord$7(value);
	if (!record) return;
	if (typeof record.code !== "number" || !Number.isFinite(record.code)) return;
	if (typeof record.message !== "string" || record.message.length === 0) return;
	return {
		code: record.code,
		message: record.message,
		data: record.data
	};
}
function extractAcpErrorInternal(value, depth) {
	if (depth > 5) return;
	const direct = toAcpErrorPayload(value);
	if (direct) return direct;
	const record = asRecord$7(value);
	if (!record) return;
	if ("error" in record) {
		const nested = extractAcpErrorInternal(record.error, depth + 1);
		if (nested) return nested;
	}
	if ("acp" in record) {
		const nested = extractAcpErrorInternal(record.acp, depth + 1);
		if (nested) return nested;
	}
	if ("cause" in record) {
		const nested = extractAcpErrorInternal(record.cause, depth + 1);
		if (nested) return nested;
	}
}
function formatUnknownErrorMessage(error) {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const maybeMessage = error.message;
		if (typeof maybeMessage === "string" && maybeMessage.length > 0) return maybeMessage;
		try {
			return JSON.stringify(error);
		} catch {}
	}
	return String(error);
}
const SESSION_NOT_FOUND_PATTERN = /session\s+["'\w-]+\s+not found/i;
function isSessionNotFoundText(value) {
	if (typeof value !== "string") return false;
	const normalized = value.toLowerCase();
	return normalized.includes("resource_not_found") || normalized.includes("resource not found") || normalized.includes("session not found") || normalized.includes("unknown session") || normalized.includes("invalid session identifier") || SESSION_NOT_FOUND_PATTERN.test(value);
}
function hasSessionNotFoundHint(value, depth = 0) {
	if (depth > 4) return false;
	if (isSessionNotFoundText(value)) return true;
	if (Array.isArray(value)) return value.some((entry) => hasSessionNotFoundHint(entry, depth + 1));
	const record = asRecord$7(value);
	if (!record) return false;
	return Object.values(record).some((entry) => hasSessionNotFoundHint(entry, depth + 1));
}
function extractAcpError(error) {
	return extractAcpErrorInternal(error, 0);
}
function isAcpResourceNotFoundError(error) {
	const acp = extractAcpError(error);
	if (acp && RESOURCE_NOT_FOUND_ACP_CODES.has(acp.code)) return true;
	if (acp) {
		if (isSessionNotFoundText(acp.message)) return true;
		if (hasSessionNotFoundHint(acp.data)) return true;
	}
	return isSessionNotFoundText(formatUnknownErrorMessage(error));
}
const AUTH_REQUIRED_ACP_CODES = new Set([-32e3]);
const QUERY_CLOSED_BEFORE_RESPONSE_DETAIL = "query closed before response received";
function asRecord$6(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isAuthRequiredMessage(value) {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized.includes("auth required") || normalized.includes("authentication required") || normalized.includes("authorization required") || normalized.includes("credential required") || normalized.includes("credentials required") || normalized.includes("token required") || normalized.includes("login required");
}
function isAcpAuthRequiredPayload(acp) {
	if (!acp) return false;
	if (!AUTH_REQUIRED_ACP_CODES.has(acp.code)) return false;
	if (isAuthRequiredMessage(acp.message)) return true;
	const data = asRecord$6(acp.data);
	if (!data) return false;
	if (data.authRequired === true) return true;
	const methodId = data.methodId;
	if (typeof methodId === "string" && methodId.trim().length > 0) return true;
	const methods = data.methods;
	if (Array.isArray(methods) && methods.length > 0) return true;
	return false;
}
function isOutputErrorCode(value) {
	return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value);
}
function isOutputErrorOrigin(value) {
	return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value);
}
function readOutputErrorMeta(error) {
	const record = asRecord$6(error);
	if (!record) return {};
	return {
		outputCode: isOutputErrorCode(record.outputCode) ? record.outputCode : void 0,
		detailCode: typeof record.detailCode === "string" && record.detailCode.trim().length > 0 ? record.detailCode : void 0,
		origin: isOutputErrorOrigin(record.origin) ? record.origin : void 0,
		retryable: typeof record.retryable === "boolean" ? record.retryable : void 0,
		acp: extractAcpError(record.acp)
	};
}
function isTimeoutLike(error) {
	return error instanceof Error && error.name === "TimeoutError";
}
function isNoSessionLike(error) {
	return error instanceof Error && error.name === "NoSessionError";
}
function isUsageLike(error) {
	if (!(error instanceof Error)) return false;
	return error.name === "CommanderError" || error.name === "InvalidArgumentError" || asRecord$6(error)?.code === "commander.invalidArgument";
}
function formatErrorMessage(error) {
	return formatUnknownErrorMessage(error);
}
function isAcpQueryClosedBeforeResponseError(error) {
	const acp = extractAcpError(error);
	if (!acp || acp.code !== -32603) return false;
	const details = asRecord$6(acp.data)?.details;
	if (typeof details !== "string") return false;
	return details.toLowerCase().includes(QUERY_CLOSED_BEFORE_RESPONSE_DETAIL);
}
function mapErrorCode(error) {
	if (error instanceof PermissionPromptUnavailableError) return "PERMISSION_PROMPT_UNAVAILABLE";
	if (error instanceof PermissionDeniedError) return "PERMISSION_DENIED";
	if (isTimeoutLike(error)) return "TIMEOUT";
	if (isNoSessionLike(error) || isAcpResourceNotFoundError(error)) return "NO_SESSION";
	if (isUsageLike(error)) return "USAGE";
}
function normalizeOutputError(error, options = {}) {
	const meta = readOutputErrorMeta(error);
	let code = mapErrorCode(error) ?? options.defaultCode ?? "RUNTIME";
	if (meta.outputCode) code = meta.outputCode;
	if (code === "RUNTIME" && isAcpResourceNotFoundError(error)) code = "NO_SESSION";
	const acp = options.acp ?? meta.acp ?? extractAcpError(error);
	const detailCode = meta.detailCode ?? options.detailCode ?? (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(acp) ? "AUTH_REQUIRED" : void 0);
	return {
		code,
		message: formatErrorMessage(error),
		detailCode,
		origin: meta.origin ?? options.origin,
		retryable: meta.retryable ?? options.retryable,
		acp
	};
}
const ACP_ADAPTER_PACKAGE_RANGES = {
	pi: "^0.0.26",
	codex: "^0.12.0",
	claude: "^0.31.0"
};
const AGENT_REGISTRY = {
	pi: `npx pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`,
	openclaw: "openclaw acp",
	codex: `npx @zed-industries/codex-acp@${ACP_ADAPTER_PACKAGE_RANGES.codex}`,
	claude: `npx -y @agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`,
	gemini: "gemini --acp",
	cursor: "cursor-agent acp",
	copilot: "copilot --acp --stdio",
	droid: "droid exec --output-format acp",
	iflow: "iflow --experimental-acp",
	kilocode: "npx -y @kilocode/cli acp",
	kimi: "kimi acp",
	kiro: "kiro-cli-chat acp",
	opencode: "npx -y opencode-ai acp",
	qoder: "qodercli --acp",
	qwen: "qwen --acp",
	trae: "traecli acp serve"
};
const BUILT_IN_AGENT_PACKAGES = {
	codex: {
		packageName: "@zed-industries/codex-acp",
		packageRange: ACP_ADAPTER_PACKAGE_RANGES.codex,
		preferredBinName: "codex-acp",
		fallbackCommand: AGENT_REGISTRY.codex,
		legacyFallbackCommands: []
	},
	claude: {
		packageName: "@agentclientprotocol/claude-agent-acp",
		packageRange: ACP_ADAPTER_PACKAGE_RANGES.claude,
		preferredBinName: "claude-agent-acp",
		fallbackCommand: AGENT_REGISTRY.claude,
		legacyFallbackCommands: [`npm exec @agentclientprotocol/claude-agent-acp@${ACP_ADAPTER_PACKAGE_RANGES.claude}`]
	}
};
const AGENT_ALIASES = {
	"factory-droid": "droid",
	factorydroid: "droid"
};
const DEFAULT_AGENT_NAME = "codex";
function normalizeAgentName$1(value) {
	return value.trim().toLowerCase();
}
function mergeAgentRegistry(overrides) {
	if (!overrides) return { ...AGENT_REGISTRY };
	const merged = { ...AGENT_REGISTRY };
	for (const [name, command] of Object.entries(overrides)) {
		const normalized = normalizeAgentName$1(name);
		if (!normalized || !command.trim()) continue;
		merged[normalized] = command.trim();
	}
	return merged;
}
function resolveAgentCommand$1(agentName, overrides) {
	const normalized = normalizeAgentName$1(agentName);
	const registry = mergeAgentRegistry(overrides);
	return registry[normalized] ?? registry[AGENT_ALIASES[normalized] ?? normalized] ?? agentName;
}
function findBuiltInAgentPackage(agentCommand) {
	const normalized = agentCommand.trim();
	return Object.values(BUILT_IN_AGENT_PACKAGES).find((spec) => spec.fallbackCommand === normalized || spec.legacyFallbackCommands?.includes(normalized));
}
function defaultResolvePackageRoot(packageName) {
	const segments = packageName.split("/");
	let cursor = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		const candidateRoot = path.join(cursor, "node_modules", ...segments);
		const manifestPath = path.join(candidateRoot, "package.json");
		if (fs.existsSync(manifestPath)) try {
			if (JSON.parse(fs.readFileSync(manifestPath, "utf8")).name === packageName) return candidateRoot;
		} catch {}
		const parent = path.dirname(cursor);
		if (parent === cursor) throw new Error(`Built-in agent package not found: ${packageName}`);
		cursor = parent;
	}
}
function resolvePackageBin(spec, manifest) {
	if (typeof manifest.bin === "string") return manifest.bin;
	if (!manifest.bin || typeof manifest.bin !== "object") return;
	return manifest.bin[spec.preferredBinName] ?? (Object.keys(manifest.bin).length === 1 ? Object.values(manifest.bin)[0] : void 0);
}
function defaultResolveNpmCliPath(execPath) {
	const candidate = path.resolve(path.dirname(execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	if (!fs.existsSync(candidate)) throw new Error(`npm CLI not found for execPath: ${execPath}`);
	return candidate;
}
function resolveInstalledBuiltInAgentLaunch(agentCommand, options = {}) {
	const spec = findBuiltInAgentPackage(agentCommand);
	if (!spec) return;
	const readFileSync = options.readFileSync ?? fs.readFileSync;
	const existsSync = options.existsSync ?? fs.existsSync;
	const resolvePackageRoot = options.resolvePackageRoot ?? defaultResolvePackageRoot;
	try {
		const packageRoot = resolvePackageRoot(spec.packageName);
		const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
		if (manifest.name !== spec.packageName) return;
		const relativeBinPath = resolvePackageBin(spec, manifest);
		if (!relativeBinPath) return;
		const binPath = path.resolve(packageRoot, relativeBinPath);
		if (!existsSync(binPath)) return;
		return {
			source: "installed",
			command: process.execPath,
			args: [binPath],
			packageName: spec.packageName,
			packageRange: spec.packageRange,
			packageVersion: manifest.version,
			binPath
		};
	} catch {
		return;
	}
}
function resolvePackageExecBuiltInAgentLaunch(agentCommand, options = {}) {
	const spec = findBuiltInAgentPackage(agentCommand);
	if (!spec) return;
	const existsSync = options.existsSync ?? fs.existsSync;
	const execPath = options.execPath ?? process.execPath;
	const resolveNpmCliPath = options.resolveNpmCliPath ?? defaultResolveNpmCliPath;
	try {
		const npmCliPath = resolveNpmCliPath(execPath);
		if (!existsSync(npmCliPath)) return;
		return {
			source: "package-exec",
			command: execPath,
			args: [
				npmCliPath,
				"exec",
				"--yes",
				`--package=${spec.packageName}@${spec.packageRange}`,
				"--",
				spec.preferredBinName
			],
			packageName: spec.packageName,
			packageRange: spec.packageRange,
			npmCliPath
		};
	} catch {
		return;
	}
}
function resolveBuiltInAgentLaunch(agentCommand, options = {}) {
	return resolveInstalledBuiltInAgentLaunch(agentCommand, options) ?? resolvePackageExecBuiltInAgentLaunch(agentCommand, options);
}
function listBuiltInAgents(overrides) {
	return Object.keys(mergeAgentRegistry(overrides));
}
var TimeoutError = class extends Error {
	constructor(timeoutMs) {
		super(`Timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
	}
};
var InterruptedError = class extends Error {
	constructor() {
		super("Interrupted");
		this.name = "InterruptedError";
	}
};
async function withTimeout(promise, timeoutMs) {
	if (timeoutMs == null || timeoutMs <= 0) return await promise;
	let timer;
	const timeoutPromise = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			reject(new TimeoutError(timeoutMs));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function withInterrupt(run, onInterrupt) {
	return await new Promise((resolve, reject) => {
		let settled = false;
		const finish = (cb) => {
			if (settled) return;
			settled = true;
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
			process.off("SIGHUP", onSighup);
			cb();
		};
		const rejectInterrupted = () => {
			onInterrupt().finally(() => {
				finish(() => reject(new InterruptedError()));
			});
		};
		const onSigint = () => {
			rejectInterrupted();
		};
		const onSigterm = () => {
			rejectInterrupted();
		};
		const onSighup = () => {
			rejectInterrupted();
		};
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);
		process.once("SIGHUP", onSighup);
		run().then((result) => finish(() => resolve(result)), (error) => finish(() => reject(error)));
	});
}
function textPrompt(text) {
	return [{
		type: "text",
		text
	}];
}
const AGENT_SESSION_ID_META_KEYS = ["agentSessionId", "sessionId"];
function normalizeAgentSessionId(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function asMetaRecord(meta) {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return;
	return meta;
}
function extractAgentSessionId(meta) {
	const record = asMetaRecord(meta);
	if (!record) return;
	for (const key of AGENT_SESSION_ID_META_KEYS) {
		const normalized = normalizeAgentSessionId(record[key]);
		if (normalized) return normalized;
	}
}
function normalizeRuntimeSessionId(value) {
	return normalizeAgentSessionId(value);
}
function extractRuntimeSessionId(meta) {
	return extractAgentSessionId(meta);
}
function serializeSessionRecordForDisk(record) {
	const canonical = {
		...record,
		schema: SESSION_RECORD_SCHEMA
	};
	return {
		schema: canonical.schema,
		acpx_record_id: canonical.acpxRecordId,
		acp_session_id: canonical.acpSessionId,
		agent_session_id: normalizeRuntimeSessionId(canonical.agentSessionId),
		agent_command: canonical.agentCommand,
		cwd: canonical.cwd,
		name: canonical.name,
		created_at: canonical.createdAt,
		last_used_at: canonical.lastUsedAt,
		last_seq: canonical.lastSeq,
		last_request_id: canonical.lastRequestId,
		event_log: canonical.eventLog,
		closed: canonical.closed,
		closed_at: canonical.closedAt,
		pid: canonical.pid,
		agent_started_at: canonical.agentStartedAt,
		last_prompt_at: canonical.lastPromptAt,
		last_agent_exit_code: canonical.lastAgentExitCode,
		last_agent_exit_signal: canonical.lastAgentExitSignal,
		last_agent_exit_at: canonical.lastAgentExitAt,
		last_agent_disconnect_reason: canonical.lastAgentDisconnectReason,
		protocol_version: canonical.protocolVersion,
		agent_capabilities: canonical.agentCapabilities,
		title: canonical.title,
		messages: canonical.messages,
		updated_at: canonical.updated_at,
		cumulative_token_usage: canonical.cumulative_token_usage,
		request_token_usage: canonical.request_token_usage,
		acpx: canonical.acpx
	};
}
const counters = /* @__PURE__ */ new Map();
function incrementPerfCounter(name, delta = 1) {
	counters.set(name, (counters.get(name) ?? 0) + delta);
}
const SNAKE_CASE_KEY = /^[a-z][a-z0-9_]*$/;
const ZED_TAG_KEYS = new Set([
	"User",
	"Agent",
	"Resume",
	"Text",
	"Mention",
	"Image",
	"Thinking",
	"RedactedThinking",
	"ToolUse"
]);
const MAP_OBJECT_PATHS = new Set(["request_token_usage", "messages.Agent.tool_results"]);
const OPAQUE_VALUE_PATHS = new Set([
	"agent_capabilities",
	"messages.Agent.content.ToolUse.input",
	"acpx.desired_config_options",
	"acpx.config_options"
]);
function isRecord$1(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function joinPath(path) {
	return path.join(".");
}
function isAllowedKey(path, key) {
	if (ZED_TAG_KEYS.has(key)) return true;
	return false;
}
function shouldSkipKeyRule(path) {
	return MAP_OBJECT_PATHS.has(joinPath(path));
}
function shouldSkipDescend(path) {
	return OPAQUE_VALUE_PATHS.has(joinPath(path)) || isToolResultOutputPath(path);
}
function isToolResultOutputPath(path) {
	if (path.length < 5 || path[path.length - 1] !== "output") return false;
	const toolResultsIndex = path.lastIndexOf("tool_results");
	if (toolResultsIndex === -1 || toolResultsIndex + 2 !== path.length - 1) return false;
	return path.slice(0, toolResultsIndex + 1).join(".") === "messages.Agent.tool_results";
}
function collectViolations(value, path, violations) {
	if (Array.isArray(value)) {
		for (const entry of value) collectViolations(entry, path, violations);
		return;
	}
	if (!isRecord$1(value)) return;
	const skipKeyRule = shouldSkipKeyRule(path);
	for (const [key, child] of Object.entries(value)) {
		if (!skipKeyRule && !SNAKE_CASE_KEY.test(key) && !isAllowedKey(path, key)) violations.push(`${joinPath(path)}.${key}`.replace(/^\./, ""));
		const childPath = [...path, key];
		if (shouldSkipDescend(childPath)) continue;
		collectViolations(child, childPath, violations);
	}
}
function findPersistedKeyPolicyViolations(value) {
	const violations = [];
	collectViolations(value, [], violations);
	return violations;
}
function assertPersistedKeyPolicy(value) {
	const violations = findPersistedKeyPolicyViolations(value);
	if (violations.length === 0) return;
	throw new Error(`Persisted key policy violation (expected snake_case keys): ${violations.join(", ")}`);
}
const DEFAULT_EVENT_SEGMENT_MAX_BYTES = 64 * 1024 * 1024;
function sessionBaseDir$1() {
	return path.join(os.homedir(), ".acpx", "sessions");
}
function safeSessionId$1(sessionId) {
	return encodeURIComponent(sessionId);
}
function sessionEventActivePath(sessionId) {
	return path.join(sessionBaseDir$1(), `${safeSessionId$1(sessionId)}.stream.ndjson`);
}
function defaultSessionEventLog(sessionId) {
	return {
		active_path: sessionEventActivePath(sessionId),
		segment_count: 5,
		max_segment_bytes: DEFAULT_EVENT_SEGMENT_MAX_BYTES,
		max_segments: 5,
		last_write_at: void 0,
		last_write_error: null
	};
}
function asRecord$4(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function hasOwn$1(source, key) {
	return Object.prototype.hasOwnProperty.call(source, key);
}
function isStringArray(value) {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function parseTokenUsage(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$4(raw);
	if (!record) return null;
	const usage = {};
	for (const field of [
		"input_tokens",
		"output_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens"
	]) {
		const value = record[field];
		if (value === void 0) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
		usage[field] = value;
	}
	return usage;
}
function parseRequestTokenUsage(raw) {
	if (raw === void 0 || raw === null) return;
	const record = asRecord$4(raw);
	if (!record) return null;
	const usage = {};
	for (const [key, value] of Object.entries(record)) {
		const parsed = parseTokenUsage(value);
		if (parsed == null) return null;
		usage[key] = parsed;
	}
	return usage;
}
function isSessionMessageImage(raw) {
	const record = asRecord$4(raw);
	if (!record || typeof record.source !== "string") return false;
	if (record.size === void 0 || record.size === null) return true;
	const size = asRecord$4(record.size);
	return !!size && typeof size.width === "number" && Number.isFinite(size.width) && typeof size.height === "number" && Number.isFinite(size.height);
}
function isUserContent(raw) {
	const record = asRecord$4(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Mention !== void 0) {
		const mention = asRecord$4(record.Mention);
		return !!mention && typeof mention.uri === "string" && typeof mention.content === "string";
	}
	if (record.Image !== void 0) return isSessionMessageImage(record.Image);
	return false;
}
function isToolUse(raw) {
	const record = asRecord$4(raw);
	return !!record && typeof record.id === "string" && typeof record.name === "string" && typeof record.raw_input === "string" && hasOwn$1(record, "input") && typeof record.is_input_complete === "boolean" && (record.thought_signature === void 0 || record.thought_signature === null || typeof record.thought_signature === "string");
}
function isToolResultContent(raw) {
	const record = asRecord$4(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Image !== void 0) return isSessionMessageImage(record.Image);
	return false;
}
function isToolResult(raw) {
	const record = asRecord$4(raw);
	return !!record && typeof record.tool_use_id === "string" && typeof record.tool_name === "string" && typeof record.is_error === "boolean" && isToolResultContent(record.content);
}
function isAgentContent(raw) {
	const record = asRecord$4(raw);
	if (!record) return false;
	if (typeof record.Text === "string") return true;
	if (record.Thinking !== void 0) {
		const thinking = asRecord$4(record.Thinking);
		return !!thinking && typeof thinking.text === "string" && (thinking.signature === void 0 || thinking.signature === null || typeof thinking.signature === "string");
	}
	if (typeof record.RedactedThinking === "string") return true;
	if (record.ToolUse !== void 0) return isToolUse(record.ToolUse);
	return false;
}
function isUserMessage$1(raw) {
	const record = asRecord$4(raw);
	if (!record || record.User === void 0) return false;
	const user = asRecord$4(record.User);
	return !!user && typeof user.id === "string" && Array.isArray(user.content) && user.content.every((entry) => isUserContent(entry));
}
function isAgentMessage$1(raw) {
	const record = asRecord$4(raw);
	if (!record || record.Agent === void 0) return false;
	const agent = asRecord$4(record.Agent);
	if (!agent || !Array.isArray(agent.content) || !agent.content.every(isAgentContent)) return false;
	const toolResults = asRecord$4(agent.tool_results);
	if (!toolResults) return false;
	return Object.values(toolResults).every(isToolResult);
}
function isConversationMessage(raw) {
	return raw === "Resume" || isUserMessage$1(raw) || isAgentMessage$1(raw);
}
function parseConversationRecord(record) {
	if (!Array.isArray(record.messages) || !record.messages.every(isConversationMessage) || typeof record.updated_at !== "string") return;
	if (record.title !== void 0 && record.title !== null && typeof record.title !== "string") return;
	const cumulativeTokenUsage = parseTokenUsage(record.cumulative_token_usage);
	const requestTokenUsage = parseRequestTokenUsage(record.request_token_usage);
	if (cumulativeTokenUsage === null || requestTokenUsage === null) return;
	return {
		title: record.title === void 0 || record.title === null || typeof record.title === "string" ? record.title : null,
		messages: record.messages,
		updated_at: record.updated_at,
		cumulative_token_usage: cumulativeTokenUsage ?? {},
		request_token_usage: requestTokenUsage ?? {}
	};
}
function parseAcpxState(raw) {
	const record = asRecord$4(raw);
	if (!record) return;
	const state = {};
	if (record.reset_on_next_ensure === true) state.reset_on_next_ensure = true;
	if (typeof record.current_mode_id === "string") state.current_mode_id = record.current_mode_id;
	if (typeof record.desired_mode_id === "string") state.desired_mode_id = record.desired_mode_id;
	const desiredConfigOptions = asRecord$4(record.desired_config_options);
	if (desiredConfigOptions) {
		const parsed = {};
		for (const [key, value] of Object.entries(desiredConfigOptions)) if (typeof key === "string" && typeof value === "string") parsed[key] = value;
		if (Object.keys(parsed).length > 0) state.desired_config_options = parsed;
	}
	if (typeof record.current_model_id === "string") state.current_model_id = record.current_model_id;
	if (isStringArray(record.available_models)) state.available_models = [...record.available_models];
	if (isStringArray(record.available_commands)) state.available_commands = [...record.available_commands];
	if (Array.isArray(record.config_options)) state.config_options = record.config_options;
	const sessionOptions = asRecord$4(record.session_options);
	if (sessionOptions) {
		const parsedSessionOptions = {};
		if (typeof sessionOptions.model === "string") parsedSessionOptions.model = sessionOptions.model;
		if (isStringArray(sessionOptions.allowed_tools)) parsedSessionOptions.allowed_tools = [...sessionOptions.allowed_tools];
		if (typeof sessionOptions.max_turns === "number" && Number.isInteger(sessionOptions.max_turns) && sessionOptions.max_turns > 0) parsedSessionOptions.max_turns = sessionOptions.max_turns;
		const rawSystemPrompt = sessionOptions.system_prompt;
		if (typeof rawSystemPrompt === "string" && rawSystemPrompt.length > 0) parsedSessionOptions.system_prompt = rawSystemPrompt;
		else {
			const appendRecord = asRecord$4(rawSystemPrompt);
			if (appendRecord && typeof appendRecord.append === "string" && appendRecord.append.length > 0) parsedSessionOptions.system_prompt = { append: appendRecord.append };
		}
		if (Object.keys(parsedSessionOptions).length > 0) state.session_options = parsedSessionOptions;
	}
	return state;
}
function parseEventLog(raw, sessionId) {
	const record = asRecord$4(raw);
	if (!record) return defaultSessionEventLog(sessionId);
	if (typeof record.active_path !== "string" || typeof record.segment_count !== "number" || !Number.isInteger(record.segment_count) || record.segment_count < 1 || typeof record.max_segment_bytes !== "number" || !Number.isInteger(record.max_segment_bytes) || record.max_segment_bytes < 1 || typeof record.max_segments !== "number" || !Number.isInteger(record.max_segments) || record.max_segments < 1) return defaultSessionEventLog(sessionId);
	return {
		active_path: record.active_path,
		segment_count: record.segment_count,
		max_segment_bytes: record.max_segment_bytes,
		max_segments: record.max_segments,
		last_write_at: typeof record.last_write_at === "string" ? record.last_write_at : void 0,
		last_write_error: record.last_write_error == null || typeof record.last_write_error === "string" ? record.last_write_error : null
	};
}
function normalizeOptionalName(value) {
	if (value == null) return;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeOptionalPid(value) {
	if (value == null) return;
	if (!Number.isInteger(value) || value <= 0) return null;
	return value;
}
function normalizeOptionalBoolean(value, fallback = false) {
	if (value == null) return fallback;
	return typeof value === "boolean" ? value : null;
}
function normalizeOptionalString(value) {
	if (value == null) return;
	return typeof value === "string" ? value : null;
}
function normalizeOptionalExitCode(value) {
	if (value === void 0) return;
	if (value === null) return null;
	if (Number.isInteger(value)) return value;
	return Symbol("invalid");
}
function normalizeOptionalSignal(value) {
	if (value === void 0) return;
	if (value === null) return null;
	if (typeof value === "string") return value;
	return Symbol("invalid");
}
function parseSessionRecord(raw) {
	const record = asRecord$4(raw);
	if (!record) return null;
	if (record.schema !== "acpx.session.v1") return null;
	const name = normalizeOptionalName(record.name);
	const pid = normalizeOptionalPid(record.pid);
	const closed = normalizeOptionalBoolean(record.closed, false);
	const closedAt = normalizeOptionalString(record.closed_at);
	const agentStartedAt = normalizeOptionalString(record.agent_started_at);
	const lastPromptAt = normalizeOptionalString(record.last_prompt_at);
	const lastAgentExitCode = normalizeOptionalExitCode(record.last_agent_exit_code);
	const lastAgentExitSignal = normalizeOptionalSignal(record.last_agent_exit_signal);
	const lastAgentExitAt = normalizeOptionalString(record.last_agent_exit_at);
	const lastAgentDisconnectReason = normalizeOptionalString(record.last_agent_disconnect_reason);
	if (typeof record.acpx_record_id !== "string" || typeof record.acp_session_id !== "string" || typeof record.agent_command !== "string" || typeof record.cwd !== "string" || typeof record.created_at !== "string" || typeof record.last_used_at !== "string" || typeof record.last_seq !== "number" || !Number.isInteger(record.last_seq) || record.last_seq < 0 || name === null || pid === null || closed === null || closedAt === null || agentStartedAt === null || lastPromptAt === null || typeof lastAgentExitCode === "symbol" || typeof lastAgentExitSignal === "symbol" || lastAgentExitAt === null || lastAgentDisconnectReason === null) return null;
	const conversation = parseConversationRecord(record);
	if (!conversation) return null;
	const eventLog = parseEventLog(record.event_log, record.acpx_record_id);
	const lastRequestId = normalizeOptionalString(record.last_request_id);
	if (lastRequestId === null) return null;
	return {
		schema: SESSION_RECORD_SCHEMA,
		acpxRecordId: record.acpx_record_id,
		acpSessionId: record.acp_session_id,
		agentSessionId: normalizeRuntimeSessionId(record.agent_session_id),
		agentCommand: record.agent_command,
		cwd: record.cwd,
		name,
		createdAt: record.created_at,
		lastUsedAt: record.last_used_at,
		lastSeq: record.last_seq,
		lastRequestId,
		eventLog,
		closed,
		closedAt,
		pid,
		agentStartedAt,
		lastPromptAt,
		lastAgentExitCode,
		lastAgentExitSignal,
		lastAgentExitAt,
		lastAgentDisconnectReason,
		protocolVersion: typeof record.protocol_version === "number" ? record.protocol_version : void 0,
		agentCapabilities: asRecord$4(record.agent_capabilities),
		title: conversation.title,
		messages: conversation.messages,
		updated_at: conversation.updated_at,
		cumulative_token_usage: conversation.cumulative_token_usage,
		request_token_usage: conversation.request_token_usage,
		acpx: parseAcpxState(record.acpx)
	};
}
function absolutePath(value) {
	return path.resolve(value);
}
function isoNow$2() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
async function promptForPermission(options) {
	if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
	if (options.header) process.stderr.write(`\n${options.header}\n`);
	if (options.details && options.details.trim().length > 0) process.stderr.write(`${options.details}\n`);
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stderr
	});
	try {
		const normalized = (await rl.question(options.prompt)).trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}
const WRITE_PREVIEW_MAX_LINES = 16;
const WRITE_PREVIEW_MAX_CHARS = 1200;
function nowIso$1() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function isWithinRoot(rootDir, targetPath) {
	const relative = path.relative(rootDir, targetPath);
	return relative.length === 0 || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function toWritePreview(content) {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const visibleLines = lines.slice(0, WRITE_PREVIEW_MAX_LINES);
	let preview = visibleLines.join("\n");
	if (lines.length > visibleLines.length) preview += `\n... (${lines.length - visibleLines.length} more lines)`;
	if (preview.length > WRITE_PREVIEW_MAX_CHARS) preview = `${preview.slice(0, WRITE_PREVIEW_MAX_CHARS - 3)}...`;
	return preview;
}
async function defaultConfirmWrite(filePath, preview) {
	return await promptForPermission({
		header: `[permission] Allow write to ${filePath}?`,
		details: preview,
		prompt: "Allow write? (y/N) "
	});
}
function canPromptForPermission$2() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
var FileSystemHandlers = class {
	rootDir;
	permissionMode;
	nonInteractivePermissions;
	onOperation;
	usesDefaultConfirmWrite;
	confirmWrite;
	constructor(options) {
		this.rootDir = path.resolve(options.cwd);
		this.permissionMode = options.permissionMode;
		this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
		this.onOperation = options.onOperation;
		this.usesDefaultConfirmWrite = options.confirmWrite == null;
		this.confirmWrite = options.confirmWrite ?? defaultConfirmWrite;
	}
	updatePermissionPolicy(permissionMode, nonInteractivePermissions) {
		this.permissionMode = permissionMode;
		this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
	}
	async readTextFile(params) {
		const filePath = this.resolvePathWithinRoot(params.path);
		const summary = `read_text_file: ${filePath}`;
		this.emitOperation({
			method: "fs/read_text_file",
			status: "running",
			summary,
			details: this.readWindowDetails(params.line, params.limit),
			timestamp: nowIso$1()
		});
		try {
			if (this.permissionMode === "deny-all") throw new PermissionDeniedError("Permission denied for fs/read_text_file (--deny-all)");
			const content = await fs$1.readFile(filePath, "utf8");
			const sliced = this.sliceContent(content, params.line, params.limit);
			this.emitOperation({
				method: "fs/read_text_file",
				status: "completed",
				summary,
				details: this.readWindowDetails(params.line, params.limit),
				timestamp: nowIso$1()
			});
			return { content: sliced };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "fs/read_text_file",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso$1()
			});
			throw error;
		}
	}
	async writeTextFile(params) {
		const filePath = this.resolvePathWithinRoot(params.path);
		const preview = toWritePreview(params.content);
		const summary = `write_text_file: ${filePath}`;
		this.emitOperation({
			method: "fs/write_text_file",
			status: "running",
			summary,
			details: preview,
			timestamp: nowIso$1()
		});
		try {
			if (!await this.isWriteApproved(filePath, preview)) throw new PermissionDeniedError("Permission denied for fs/write_text_file");
			await fs$1.mkdir(path.dirname(filePath), { recursive: true });
			await fs$1.writeFile(filePath, params.content, "utf8");
			this.emitOperation({
				method: "fs/write_text_file",
				status: "completed",
				summary,
				details: preview,
				timestamp: nowIso$1()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "fs/write_text_file",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso$1()
			});
			throw error;
		}
	}
	async isWriteApproved(filePath, preview) {
		if (this.permissionMode === "approve-all") return true;
		if (this.permissionMode === "deny-all") return false;
		if (this.usesDefaultConfirmWrite && this.nonInteractivePermissions === "fail" && !canPromptForPermission$2()) throw new PermissionPromptUnavailableError();
		return await this.confirmWrite(filePath, preview);
	}
	resolvePathWithinRoot(rawPath) {
		if (!path.isAbsolute(rawPath)) throw new Error(`Path must be absolute: ${rawPath}`);
		const resolved = path.resolve(rawPath);
		if (!isWithinRoot(this.rootDir, resolved)) throw new Error(`Path is outside allowed cwd subtree: ${resolved}`);
		return resolved;
	}
	sliceContent(content, line, limit) {
		if (line == null && limit == null) return content;
		const lines = content.split("\n");
		const startIndex = Math.max(0, (line == null ? 1 : Math.max(1, Math.trunc(line))) - 1);
		const maxLines = limit == null ? void 0 : Math.max(0, Math.trunc(limit));
		if (maxLines === 0) return "";
		const endIndex = maxLines == null ? lines.length : Math.min(lines.length, startIndex + maxLines);
		return lines.slice(startIndex, endIndex).join("\n");
	}
	readWindowDetails(line, limit) {
		if (line == null && limit == null) return;
		return `line=${line == null ? 1 : Math.max(1, Math.trunc(line))}, limit=${limit == null ? "all" : Math.max(0, Math.trunc(limit))}`;
	}
	emitOperation(operation) {
		this.onOperation?.(operation);
	}
};
function selected(optionId) {
	return { outcome: {
		outcome: "selected",
		optionId
	} };
}
function cancelled() {
	return { outcome: { outcome: "cancelled" } };
}
function withEscalationMetadata(response, event) {
	return {
		...response,
		_meta: {
			...response._meta,
			acpx: {
				...response._meta?.acpx && typeof response._meta.acpx === "object" && !Array.isArray(response._meta.acpx) ? response._meta.acpx : {},
				permissionEscalation: event
			}
		}
	};
}
function pickOption(options, kinds) {
	for (const kind of kinds) {
		const match = options.find((option) => option.kind === kind);
		if (match) return match;
	}
}
function inferToolKind(params) {
	if (params.toolCall.kind) return params.toolCall.kind;
	const title = params.toolCall.title?.trim().toLowerCase();
	if (!title) return;
	const head = title.split(":", 1)[0]?.trim();
	if (!head) return;
	if (head.includes("read") || head.includes("cat")) return "read";
	if (head.includes("search") || head.includes("find") || head.includes("grep")) return "search";
	if (head.includes("write") || head.includes("edit") || head.includes("patch")) return "edit";
	if (head.includes("delete") || head.includes("remove")) return "delete";
	if (head.includes("move") || head.includes("rename")) return "move";
	if (head.includes("run") || head.includes("execute") || head.includes("bash")) return "execute";
	if (head.includes("fetch") || head.includes("http") || head.includes("url")) return "fetch";
	if (head.includes("think")) return "think";
	return "other";
}
function isAutoApprovedReadKind(kind) {
	return kind === "read" || kind === "search";
}
async function promptForToolPermission(params) {
	return await promptForPermission({ prompt: `\n[permission] Allow ${params.toolCall.title ?? "tool"} [${inferToolKind(params) ?? "other"}]? (y/N) ` });
}
function canPromptForPermission$1() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
function readStringProperty(value, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value;
	for (const key of keys) {
		const entry = record[key];
		if (typeof entry === "string" && entry.trim().length > 0) return entry.trim();
	}
}
function readToolName(params) {
	const rawInputName = readStringProperty(params.toolCall.rawInput, [
		"name",
		"tool",
		"toolName"
	]);
	if (rawInputName) return rawInputName;
	const head = (params.toolCall.title?.trim())?.split(/[:\s]/, 1)[0]?.trim();
	return head && head.length > 0 ? head : void 0;
}
function normalizeMatcher(value) {
	return value.trim().toLowerCase();
}
function permissionMatchTokens(params) {
	const tokens = /* @__PURE__ */ new Set();
	const kind = inferToolKind(params);
	const rawKind = params.toolCall.kind;
	const title = params.toolCall.title?.trim();
	const toolName = readToolName(params);
	for (const value of [
		kind,
		rawKind,
		title,
		toolName
	]) if (typeof value === "string" && value.trim().length > 0) tokens.add(normalizeMatcher(value));
	if (title) {
		const head = title.split(/[:\s]/, 1)[0]?.trim();
		if (head) tokens.add(normalizeMatcher(head));
	}
	return [...tokens];
}
function findPolicyRule(rules, params) {
	if (!rules || rules.length === 0) return;
	const tokens = permissionMatchTokens(params);
	for (const rule of rules) {
		const normalized = normalizeMatcher(rule);
		if (normalized === "*" || tokens.includes(normalized)) return rule;
	}
}
function matchPermissionPolicy(params, policy) {
	if (!policy) return;
	const denyRule = findPolicyRule(policy.autoDeny, params);
	if (denyRule) return {
		action: "deny",
		matchedRule: denyRule
	};
	const approveRule = findPolicyRule(policy.autoApprove, params);
	if (approveRule) return {
		action: "approve",
		matchedRule: approveRule
	};
	const escalateRule = findPolicyRule(policy.escalate, params);
	if (escalateRule) return {
		action: "escalate",
		matchedRule: escalateRule
	};
	return policy.defaultAction ? { action: policy.defaultAction } : void 0;
}
function buildEscalationEvent(params, matchedRule) {
	const toolKind = inferToolKind(params);
	const toolTitle = params.toolCall.title?.trim() || "tool";
	const toolName = readToolName(params);
	return {
		type: "permission_escalation",
		sessionId: params.sessionId,
		toolCallId: params.toolCall.toolCallId,
		...toolName ? { toolName } : {},
		toolTitle,
		...params.toolCall.rawInput !== void 0 ? { toolInput: params.toolCall.rawInput } : {},
		...toolKind ? { toolKind } : {},
		action: "escalate",
		...matchedRule ? { matchedRule } : {},
		message: `Permission escalation required for ${toolTitle}`,
		timestamp: (/* @__PURE__ */ new Date()).toISOString()
	};
}
async function resolvePermissionRequestWithDetails(params, mode, nonInteractivePolicy = "deny", policy) {
	const options = params.options ?? [];
	if (options.length === 0) return { response: cancelled() };
	const allowOption = pickOption(options, ["allow_once", "allow_always"]);
	const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
	const policyMatch = matchPermissionPolicy(params, policy);
	if (policyMatch?.action === "approve") {
		if (allowOption) return { response: selected(allowOption.optionId) };
		return { response: selected(options[0].optionId) };
	}
	if (policyMatch?.action === "deny") {
		if (rejectOption) return { response: selected(rejectOption.optionId) };
		return { response: cancelled() };
	}
	if (policyMatch?.action === "escalate") {
		if (canPromptForPermission$1()) {
			const approved = await promptForToolPermission(params);
			if (approved && allowOption) return { response: selected(allowOption.optionId) };
			if (!approved && rejectOption) return { response: selected(rejectOption.optionId) };
			return { response: cancelled() };
		}
		const escalation = buildEscalationEvent(params, policyMatch.matchedRule);
		return {
			response: withEscalationMetadata(rejectOption ? selected(rejectOption.optionId) : cancelled(), escalation),
			escalation
		};
	}
	if (mode === "approve-all") {
		if (allowOption) return { response: selected(allowOption.optionId) };
		return { response: selected(options[0].optionId) };
	}
	if (mode === "deny-all") {
		if (rejectOption) return { response: selected(rejectOption.optionId) };
		return { response: cancelled() };
	}
	if (isAutoApprovedReadKind(inferToolKind(params)) && allowOption) return { response: selected(allowOption.optionId) };
	if (!canPromptForPermission$1()) {
		if (nonInteractivePolicy === "fail") throw new PermissionPromptUnavailableError();
		if (rejectOption) return { response: selected(rejectOption.optionId) };
		return { response: cancelled() };
	}
	const approved = await promptForToolPermission(params);
	if (approved && allowOption) return { response: selected(allowOption.optionId) };
	if (!approved && rejectOption) return { response: selected(rejectOption.optionId) };
	return { response: cancelled() };
}
const DECISION_FALLBACK_ORDER = {
	allow_once: ["allow_once", "allow_always"],
	allow_always: ["allow_always", "allow_once"],
	reject_once: ["reject_once", "reject_always"],
	reject_always: ["reject_always", "reject_once"]
};
function decisionToResponse(params, decision) {
	if (decision.outcome === "cancel") return cancelled();
	const matched = pickOption(params.options ?? [], DECISION_FALLBACK_ORDER[decision.outcome]);
	return matched ? selected(matched.optionId) : cancelled();
}
function classifyPermissionDecision(params, response) {
	if (response.outcome.outcome !== "selected") return "cancelled";
	const selectedOptionId = response.outcome.optionId;
	const selectedOption = params.options.find((option) => option.optionId === selectedOptionId);
	if (!selectedOption) return "cancelled";
	if (selectedOption.kind === "allow_once" || selectedOption.kind === "allow_always") return "approved";
	return "denied";
}
function readWindowsEnvValue(env, key) {
	const matchedKey = Object.keys(env).find((entry) => entry.toUpperCase() === key);
	return matchedKey ? env[matchedKey] : void 0;
}
function resolveWindowsCommand(command, env = process.env) {
	const extensions = (readWindowsEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0);
	const candidates = path.extname(command).length > 0 ? [command] : extensions.map((extension) => `${command}${extension}`);
	if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) return candidates.find((candidate) => fs.existsSync(candidate));
	const pathValue = readWindowsEnvValue(env, "PATH");
	if (!pathValue) return;
	for (const directory of pathValue.split(";")) {
		const trimmedDirectory = directory.trim();
		if (trimmedDirectory.length === 0) continue;
		for (const candidate of candidates) {
			const resolved = path.join(trimmedDirectory, candidate);
			if (fs.existsSync(resolved)) return resolved;
		}
	}
}
function shouldUseWindowsBatchShell(command, platform = process.platform, env = process.env) {
	if (platform !== "win32") return false;
	const resolvedCommand = resolveWindowsCommand(command, env) ?? command;
	const ext = path.extname(resolvedCommand).toLowerCase();
	return ext === ".cmd" || ext === ".bat";
}
function buildSpawnCommandOptions(command, options, platform = process.platform, env = process.env) {
	if (!shouldUseWindowsBatchShell(command, platform, env)) return options;
	return {
		...options,
		shell: true
	};
}
function buildTerminalSpawnCommand(command, args) {
	return {
		command,
		args: args ?? [],
		killProcessGroup: false
	};
}
function buildTerminalShellSpawnCommand(command, platform = process.platform) {
	if (platform === "win32") return {
		command: "cmd.exe",
		args: [
			"/d",
			"/s",
			"/c",
			command
		],
		killProcessGroup: true
	};
	return {
		command: "/bin/sh",
		args: ["-c", command],
		killProcessGroup: true
	};
}
const execFileAsync = promisify(execFile);
function isoNow$1() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function waitForSpawn$1(child) {
	return new Promise((resolve, reject) => {
		const onSpawn = () => {
			child.off("error", onError);
			resolve();
		};
		const onError = (error) => {
			child.off("spawn", onSpawn);
			reject(error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
}
function isChildProcessRunning(child) {
	return child.exitCode == null && child.signalCode == null;
}
function requireAgentStdio(child) {
	if (!child.stdin || !child.stdout || !child.stderr) throw new Error("ACP agent must be spawned with piped stdin/stdout/stderr");
	return child;
}
function waitForChildExit(child, timeoutMs) {
	if (!isChildProcessRunning(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			finish(false);
		}, Math.max(0, timeoutMs));
		const finish = (value) => {
			if (settled) return;
			settled = true;
			child.off("close", onExitLike);
			child.off("exit", onExitLike);
			clearTimeout(timer);
			resolve(value);
		};
		const onExitLike = () => {
			finish(true);
		};
		child.once("close", onExitLike);
		child.once("exit", onExitLike);
	});
}
function splitCommandLine(value) {
	const parts = [];
	let current = "";
	let quote = null;
	let escaping = false;
	for (const ch of value) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaping) current += "\\";
	if (quote) throw new Error("Invalid --agent command: unterminated quote");
	if (current.length > 0) parts.push(current);
	if (parts.length === 0) throw new Error("Invalid --agent command: empty command");
	return {
		command: parts[0],
		args: parts.slice(1)
	};
}
function asAbsoluteCwd(cwd) {
	return path.resolve(cwd);
}
async function resolveAgentSessionCwd(cwd, agentCommand, options = {}) {
	const resolved = asAbsoluteCwd(cwd);
	if (!shouldTranslateWslWindowsCwd(agentCommand, options)) return resolved;
	const translated = (await (options.runWslpath ?? runWslpath)(resolved)).trim();
	if (!translated) throw new Error(`wslpath returned an empty Windows path for cwd: ${resolved}`);
	return translated;
}
function shouldTranslateWslWindowsCwd(agentCommand, options) {
	if (!isWsl(options)) return false;
	try {
		const { command } = splitCommandLine(agentCommand);
		return isWindowsExecutableCommand(command);
	} catch {
		return false;
	}
}
function isWsl(options) {
	if ((options.platform ?? process.platform) !== "linux") return false;
	return (options.existsSync ?? fs.existsSync)("/proc/sys/fs/binfmt_misc/WSLInterop");
}
const WINDOWS_EXECUTABLE_EXTENSION_RE = /\.(?:exe|cmd|bat)$/u;
function isWindowsExecutableCommand(command) {
	const normalized = command.toLowerCase();
	return WINDOWS_EXECUTABLE_EXTENSION_RE.test(normalized);
}
async function runWslpath(cwd) {
	const { stdout } = await execFileAsync("wslpath", ["-w", cwd], { encoding: "utf8" });
	return stdout;
}
function basenameToken(value) {
	return path.basename(value).toLowerCase().replace(/\.(cmd|exe|bat)$/u, "");
}
const DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS = 100;
const QODER_AGENT_CLOSE_AFTER_STDIN_END_MS = 750;
const GEMINI_ACP_STARTUP_TIMEOUT_MS = 15e3;
const CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS = 6e4;
const GEMINI_VERSION_TIMEOUT_MS = 2e3;
const GEMINI_ACP_FLAG_VERSION = [
	0,
	33,
	0
];
const COPILOT_HELP_TIMEOUT_MS = 2e3;
const QODER_BENIGN_STDOUT_LINES = new Set(["Received interrupt signal. Cleaning up resources...", "Cleanup completed. Exiting..."]);
function resolveAgentCloseAfterStdinEndMs(agentCommand) {
	const { command } = splitCommandLine(agentCommand);
	return basenameToken(command) === "qodercli" ? QODER_AGENT_CLOSE_AFTER_STDIN_END_MS : DEFAULT_AGENT_CLOSE_AFTER_STDIN_END_MS;
}
function shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine) {
	const { command } = splitCommandLine(agentCommand);
	return basenameToken(command) === "qodercli" && QODER_BENIGN_STDOUT_LINES.has(trimmedLine);
}
function isGeminiAcpCommand(command, args) {
	return basenameToken(command) === "gemini" && (args.includes("--acp") || args.includes("--experimental-acp"));
}
function isClaudeAcpCommand$1(command, args) {
	if (basenameToken(command) === "claude-agent-acp") return true;
	return args.some((arg) => arg.includes("claude-agent-acp"));
}
function isCopilotAcpCommand(command, args) {
	return basenameToken(command) === "copilot" && args.includes("--acp");
}
function isQoderAcpCommand(command, args) {
	return basenameToken(command) === "qodercli" && args.includes("--acp");
}
function hasCommandFlag(args, flagName) {
	return args.some((arg) => arg === flagName || arg.startsWith(`${flagName}=`));
}
function normalizeQoderAllowedToolName(tool) {
	switch (tool.trim().toLowerCase()) {
		case "bash":
		case "glob":
		case "grep":
		case "ls":
		case "read":
		case "write": return tool.trim().toUpperCase();
		default: return tool.trim();
	}
}
function buildQoderAcpCommandArgs(initialArgs, options) {
	const args = [...initialArgs];
	const sessionOptions = options.sessionOptions;
	if (typeof sessionOptions?.maxTurns === "number" && !hasCommandFlag(args, "--max-turns")) args.push(`--max-turns=${sessionOptions.maxTurns}`);
	if (Array.isArray(sessionOptions?.allowedTools) && !hasCommandFlag(args, "--allowed-tools") && !hasCommandFlag(args, "--disallowed-tools")) {
		const encodedTools = sessionOptions.allowedTools.map(normalizeQoderAllowedToolName).join(",");
		args.push(`--allowed-tools=${encodedTools}`);
	}
	return args;
}
function resolveGeminiAcpStartupTimeoutMs() {
	const raw = process.env.ACPX_GEMINI_ACP_STARTUP_TIMEOUT_MS;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
	}
	return GEMINI_ACP_STARTUP_TIMEOUT_MS;
}
function resolveClaudeAcpSessionCreateTimeoutMs() {
	const raw = process.env.ACPX_CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
	if (typeof raw === "string" && raw.trim().length > 0) {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
	}
	return CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS;
}
function parseGeminiVersion(value) {
	if (typeof value !== "string") return;
	const normalized = value.trim();
	const match = normalized.match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return;
	return {
		raw: normalized,
		parts: [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		]
	};
}
function compareVersionParts(left, right) {
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const leftPart = left[index] ?? 0;
		const rightPart = right[index] ?? 0;
		if (leftPart !== rightPart) return leftPart - rightPart;
	}
	return 0;
}
async function detectGeminiVersion(command) {
	const versionLine = (await readCommandOutput(command, ["--version"], GEMINI_VERSION_TIMEOUT_MS))?.split(/\r?\n/).map((line) => line.trim()).find((line) => /\d+\.\d+\.\d+/.test(line));
	return parseGeminiVersion(versionLine);
}
async function resolveGeminiCommandArgs(command, args) {
	if (basenameToken(command) !== "gemini" || !args.includes("--acp")) return [...args];
	const version = await detectGeminiVersion(command);
	if (version && compareVersionParts(version.parts, GEMINI_ACP_FLAG_VERSION) < 0) return args.map((arg) => arg === "--acp" ? "--experimental-acp" : arg);
	return [...args];
}
async function readCommandOutput(command, args, timeoutMs) {
	return await new Promise((resolve) => {
		const child = spawn(command, [...args], buildSpawnCommandOptions(command, {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		}));
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeAllListeners();
			child.stdout?.removeAllListeners();
			child.stderr?.removeAllListeners();
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(void 0);
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", () => {
			finish(void 0);
		});
		child.once("close", () => {
			finish(`${stdout}\n${stderr}`);
		});
	});
}
async function buildGeminiAcpStartupTimeoutMessage(command) {
	const parts = ["Gemini CLI ACP startup timed out before initialize completed.", "This usually means the local Gemini CLI is waiting on interactive OAuth or has incompatible ACP subprocess behavior."];
	const version = await detectGeminiVersion(command);
	if (version) parts.push(`Detected Gemini CLI version: ${version.raw}.`);
	if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) parts.push("No GEMINI_API_KEY or GOOGLE_API_KEY was set for non-interactive auth.");
	parts.push("Try upgrading Gemini CLI and using API-key-based auth for non-interactive ACP runs.");
	return parts.join(" ");
}
function buildClaudeAcpSessionCreateTimeoutMessage() {
	return [
		"Claude ACP session creation timed out before session/new completed.",
		"This matches the known persistent-session stall seen with some Claude Code and @agentclientprotocol/claude-agent-acp combinations.",
		"In harnessed or non-interactive runs, prefer --approve-all with nonInteractivePermissions=deny, upgrade Claude Code and the Claude ACP adapter, or use acpx claude exec as a one-shot fallback."
	].join(" ");
}
async function buildCopilotAcpUnsupportedMessage(command) {
	const parts = ["GitHub Copilot CLI ACP stdio mode is not available in the installed copilot binary.", "acpx copilot expects a Copilot CLI release that supports --acp --stdio."];
	const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
	if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) parts.push("Detected copilot --help output without --acp support.");
	parts.push("Upgrade GitHub Copilot CLI to a release with ACP stdio support, or use --agent with another ACP-compatible adapter in the meantime.");
	return parts.join(" ");
}
async function ensureCopilotAcpSupport(command) {
	const helpOutput = await readCommandOutput(command, ["--help"], COPILOT_HELP_TIMEOUT_MS);
	if (typeof helpOutput === "string" && !helpOutput.includes("--acp")) throw new CopilotAcpUnsupportedError(await buildCopilotAcpUnsupportedMessage(command), { retryable: false });
}
function buildClaudeCodeOptionsMeta(options) {
	if (!options) return;
	const claudeCodeOptions = {};
	if (typeof options.model === "string" && options.model.trim().length > 0) claudeCodeOptions.model = options.model;
	if (Array.isArray(options.allowedTools)) claudeCodeOptions.allowedTools = [...options.allowedTools];
	if (typeof options.maxTurns === "number") claudeCodeOptions.maxTurns = options.maxTurns;
	const meta = {};
	if (Object.keys(claudeCodeOptions).length > 0) meta.claudeCode = { options: claudeCodeOptions };
	const systemPrompt = options.systemPrompt;
	if (typeof systemPrompt === "string" && systemPrompt.length > 0) meta.systemPrompt = systemPrompt;
	else if (systemPrompt && typeof systemPrompt === "object" && typeof systemPrompt.append === "string" && systemPrompt.append.length > 0) meta.systemPrompt = { append: systemPrompt.append };
	if (Object.keys(meta).length === 0) return;
	return meta;
}
function resolveClaudeCodeExecutable(platform = process.platform, env = process.env) {
	if (platform !== "win32") return;
	if (readWindowsEnvValue(env, "CLAUDE_CODE_EXECUTABLE")) return;
	const resolved = resolveWindowsCommand("claude", env);
	if (!resolved) return;
	return path.resolve(resolved);
}
const AUTH_ENV_PREFIX = "ACPX_AUTH_";
function toEnvToken(value) {
	return value.trim().replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}
function buildAuthEnvKey(methodId) {
	const token = toEnvToken(methodId);
	return token.length > 0 ? `${AUTH_ENV_PREFIX}${token}` : void 0;
}
const authEnvKeyCache = /* @__PURE__ */ new Map();
function authEnvKey(methodId) {
	const cached = authEnvKeyCache.get(methodId);
	if (cached !== void 0) return cached;
	const key = buildAuthEnvKey(methodId);
	authEnvKeyCache.set(methodId, key);
	return key;
}
function readEnvCredential(methodId) {
	const key = authEnvKey(methodId);
	if (!key) return;
	const value = process.env[key];
	if (typeof value === "string" && value.trim().length > 0) return value;
}
function promotePrefixedAuthEnvironment(env) {
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith(AUTH_ENV_PREFIX)) continue;
		if (typeof value !== "string" || value.trim().length === 0) continue;
		const normalized = key.slice(10);
		if (!normalized || env[normalized] != null) continue;
		env[normalized] = value;
	}
}
function buildAgentEnvironment(authCredentials) {
	const env = { ...process.env };
	promotePrefixedAuthEnvironment(env);
	if (!authCredentials) return env;
	for (const [methodId, credential] of Object.entries(authCredentials)) {
		if (typeof credential !== "string" || credential.trim().length === 0) continue;
		if (!methodId.includes("=") && !methodId.includes("\0") && env[methodId] == null) env[methodId] = credential;
		const normalized = toEnvToken(methodId);
		if (normalized) {
			const prefixed = `${AUTH_ENV_PREFIX}${normalized}`;
			if (env[prefixed] == null) env[prefixed] = credential;
			if (env[normalized] == null) env[normalized] = credential;
		}
	}
	return env;
}
function resolveConfiguredAuthCredential(methodId, authCredentials) {
	const configCredentials = authCredentials ?? {};
	return configCredentials[methodId] ?? configCredentials[toEnvToken(methodId)];
}
function buildAgentSpawnOptions(cwd, authCredentials) {
	return {
		cwd,
		env: buildAgentEnvironment(authCredentials),
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		windowsHide: true
	};
}
function isJsonRpcNotification(message) {
	return Object.hasOwn(message, "method") && typeof message.method === "string" && !Object.hasOwn(message, "id");
}
function isSessionUpdateNotification(message) {
	return isJsonRpcNotification(message) && message.method === "session/update";
}
const SESSION_CONTROL_UNSUPPORTED_ACP_CODES = new Set([-32601, -32602]);
function asRecord$1(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function isLikelySessionControlUnsupportedError(acp) {
	if (SESSION_CONTROL_UNSUPPORTED_ACP_CODES.has(acp.code)) return true;
	if (acp.code !== -32603) return false;
	const details = asRecord$1(acp.data)?.details;
	return typeof details === "string" && details.toLowerCase().includes("invalid params");
}
function formatSessionControlAcpSummary(acp) {
	const details = asRecord$1(acp.data)?.details;
	if (typeof details === "string" && details.trim().length > 0) return `${details.trim()} (ACP ${acp.code}, adapter reported "${acp.message}")`;
	return `${acp.message} (ACP ${acp.code})`;
}
function maybeWrapSessionControlError(method, error, context) {
	const acp = extractAcpError(error);
	if (!acp || !isLikelySessionControlUnsupportedError(acp)) return error;
	const acpSummary = formatSessionControlAcpSummary(acp);
	const message = `Agent rejected ${method}${context ? ` ${context}` : ""}: ${acpSummary}. The adapter may not implement ${method}, or the requested value is not supported.`;
	const wrapped = new Error(message, { cause: error instanceof Error ? error : void 0 });
	wrapped.acp = acp;
	return wrapped;
}
const DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 1500;
function nowIso() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function toCommandLine(command, args) {
	const renderedArgs = (args ?? []).map((arg) => JSON.stringify(arg)).join(" ");
	return renderedArgs.length > 0 ? `${command} ${renderedArgs}` : command;
}
function toEnvObject(env) {
	if (!env || env.length === 0) return;
	const merged = { ...process.env };
	for (const entry of env) merged[entry.name] = entry.value;
	return merged;
}
function buildTerminalSpawnOptions(command, cwd, env, platform = process.platform) {
	const resolvedEnv = toEnvObject(env);
	return buildSpawnCommandOptions(command, {
		cwd,
		env: resolvedEnv,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		windowsHide: true
	}, platform, resolvedEnv ?? process.env);
}
function trimToUtf8Boundary(buffer, limit) {
	if (limit <= 0) return Buffer.alloc(0);
	if (buffer.length <= limit) return buffer;
	let start = buffer.length - limit;
	while (start < buffer.length && (buffer[start] & 192) === 128) start += 1;
	if (start >= buffer.length) start = buffer.length - limit;
	return buffer.subarray(start);
}
function waitForSpawn(process) {
	return new Promise((resolve, reject) => {
		const onSpawn = () => {
			process.off("error", onError);
			resolve();
		};
		const onError = (error) => {
			process.off("spawn", onSpawn);
			reject(error);
		};
		process.once("spawn", onSpawn);
		process.once("error", onError);
	});
}
async function defaultConfirmExecute(commandLine) {
	return await promptForPermission({ prompt: `\n[permission] Allow terminal command "${commandLine}"? (y/N) ` });
}
function canPromptForPermission() {
	return process.stdin.isTTY && process.stderr.isTTY;
}
function waitMs(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, Math.max(0, ms));
	});
}
var TerminalManager = class {
	cwd;
	permissionMode;
	nonInteractivePermissions;
	onOperation;
	usesDefaultConfirmExecute;
	confirmExecute;
	killGraceMs;
	terminals = /* @__PURE__ */ new Map();
	constructor(options) {
		this.cwd = options.cwd;
		this.permissionMode = options.permissionMode;
		this.nonInteractivePermissions = options.nonInteractivePermissions ?? "deny";
		this.onOperation = options.onOperation;
		this.usesDefaultConfirmExecute = options.confirmExecute == null;
		this.confirmExecute = options.confirmExecute ?? defaultConfirmExecute;
		this.killGraceMs = Math.max(0, Math.round(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS));
	}
	updatePermissionPolicy(permissionMode, nonInteractivePermissions) {
		this.permissionMode = permissionMode;
		this.nonInteractivePermissions = nonInteractivePermissions ?? "deny";
	}
	async createTerminal(params) {
		const commandLine = toCommandLine(params.command, params.args);
		const summary = `terminal/create: ${commandLine}`;
		this.emitOperation({
			method: "terminal/create",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		try {
			if (!await this.isExecuteApproved(commandLine)) throw new PermissionDeniedError("Permission denied for terminal/create");
			const outputByteLimit = Math.max(0, Math.round(params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_LIMIT_BYTES));
			const { proc, spawnCommand } = await spawnTerminalProcess(params, this.cwd);
			let resolveExit = () => {};
			const exitPromise = new Promise((resolve) => {
				resolveExit = resolve;
			});
			const terminal = {
				process: proc,
				killProcessGroup: spawnCommand.killProcessGroup,
				descendantPids: /* @__PURE__ */ new Set(),
				output: Buffer.alloc(0),
				truncated: false,
				outputByteLimit,
				exitCode: void 0,
				signal: void 0,
				exitPromise,
				resolveExit
			};
			const appendOutput = (chunk) => {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (bytes.length === 0) return;
				terminal.output = Buffer.concat([terminal.output, bytes]);
				if (terminal.output.length > terminal.outputByteLimit) {
					terminal.output = trimToUtf8Boundary(terminal.output, terminal.outputByteLimit);
					terminal.truncated = true;
				}
			};
			proc.stdout.on("data", appendOutput);
			proc.stderr.on("data", appendOutput);
			proc.once("exit", (exitCode, signal) => {
				terminal.exitCode = exitCode;
				terminal.signal = signal;
				terminal.processGroupSnapshotPromise = rememberProcessGroupPids(terminal);
				(async () => {
					await terminal.processGroupSnapshotPromise;
					terminal.resolveExit({
						exitCode: exitCode ?? null,
						signal: signal ?? null
					});
				})();
			});
			const terminalId = randomUUID();
			this.terminals.set(terminalId, terminal);
			this.emitOperation({
				method: "terminal/create",
				status: "completed",
				summary,
				details: `terminalId=${terminalId}`,
				timestamp: nowIso()
			});
			return { terminalId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/create",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async terminalOutput(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const hasExitStatus = terminal.exitCode !== void 0 || terminal.signal !== void 0;
		this.emitOperation({
			method: "terminal/output",
			status: "completed",
			summary: `terminal/output: ${params.terminalId}`,
			timestamp: nowIso()
		});
		return {
			output: terminal.output.toString("utf8"),
			truncated: terminal.truncated,
			exitStatus: hasExitStatus ? {
				exitCode: terminal.exitCode ?? null,
				signal: terminal.signal ?? null
			} : void 0
		};
	}
	async waitForTerminalExit(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const response = await terminal.exitPromise;
		this.emitOperation({
			method: "terminal/wait_for_exit",
			status: "completed",
			summary: `terminal/wait_for_exit: ${params.terminalId}`,
			details: `exitCode=${response.exitCode ?? "null"}, signal=${response.signal ?? "null"}`,
			timestamp: nowIso()
		});
		return response;
	}
	async killTerminal(params) {
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${params.terminalId}`);
		const summary = `terminal/kill: ${params.terminalId}`;
		this.emitOperation({
			method: "terminal/kill",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		try {
			await this.killProcess(terminal);
			this.emitOperation({
				method: "terminal/kill",
				status: "completed",
				summary,
				timestamp: nowIso()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/kill",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async releaseTerminal(params) {
		const summary = `terminal/release: ${params.terminalId}`;
		this.emitOperation({
			method: "terminal/release",
			status: "running",
			summary,
			timestamp: nowIso()
		});
		const terminal = this.getTerminal(params.terminalId);
		if (!terminal) {
			this.emitOperation({
				method: "terminal/release",
				status: "completed",
				summary,
				details: "already released",
				timestamp: nowIso()
			});
			return {};
		}
		try {
			await this.killProcess(terminal);
			await terminal.exitPromise.catch(() => {});
			terminal.output = Buffer.alloc(0);
			this.terminals.delete(params.terminalId);
			this.emitOperation({
				method: "terminal/release",
				status: "completed",
				summary,
				timestamp: nowIso()
			});
			return {};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emitOperation({
				method: "terminal/release",
				status: "failed",
				summary,
				details: message,
				timestamp: nowIso()
			});
			throw error;
		}
	}
	async shutdown() {
		for (const terminalId of Array.from(this.terminals.keys())) await this.releaseTerminal({
			terminalId,
			sessionId: "shutdown"
		});
	}
	getTerminal(terminalId) {
		return this.terminals.get(terminalId);
	}
	emitOperation(operation) {
		this.onOperation?.(operation);
	}
	async isExecuteApproved(commandLine) {
		if (this.permissionMode === "approve-all") return true;
		if (this.permissionMode === "deny-all") return false;
		if (this.usesDefaultConfirmExecute && this.nonInteractivePermissions === "fail" && !canPromptForPermission()) throw new PermissionPromptUnavailableError();
		return await this.confirmExecute(commandLine);
	}
	isRunning(terminal) {
		return terminal.exitCode === void 0 && terminal.signal === void 0;
	}
	async killProcess(terminal) {
		if (!this.isRunning(terminal) && !terminal.killProcessGroup) return;
		try {
			await this.signalProcess(terminal, "SIGTERM");
		} catch {
			return;
		}
		if (await this.waitForCleanupAfterSignal(terminal) && !terminal.killProcessGroup) return;
		try {
			await this.signalProcess(terminal, "SIGKILL");
		} catch {
			return;
		}
		await this.waitForCleanupAfterSignal(terminal);
	}
	async signalProcess(terminal, signal) {
		const pid = terminal.process.pid;
		if (terminal.killProcessGroup && pid && process.platform === "win32") {
			if (!this.isRunning(terminal)) await terminal.processGroupSnapshotPromise?.catch(() => {});
			for (const descendantPid of await listDescendantPids(pid)) terminal.descendantPids.add(descendantPid);
			if (this.isRunning(terminal)) {
				await killWindowsProcessTree(pid, signal);
				return;
			}
			for (const descendantPid of terminal.descendantPids) await killWindowsProcessTree(descendantPid, signal);
			return;
		}
		if (terminal.killProcessGroup && pid) {
			if (!this.isRunning(terminal)) await terminal.processGroupSnapshotPromise?.catch(() => {});
			for (const descendantPid of await listDescendantPids(pid)) terminal.descendantPids.add(descendantPid);
			if (process.platform !== "win32" && hasLiveProcessGroup(pid)) {
				sendSignal(-pid, signal);
				return;
			}
			for (const descendantPid of terminal.descendantPids) sendSignal(descendantPid, signal);
			return;
		}
		terminal.process.kill(signal);
	}
	async waitForCleanupAfterSignal(terminal) {
		return await Promise.race([this.waitForTerminalAndTrackedDescendants(terminal).then(() => true), waitMs(this.killGraceMs).then(() => false)]);
	}
	async waitForTerminalAndTrackedDescendants(terminal) {
		await terminal.exitPromise;
		while (hasLiveTerminalProcessGroup(terminal)) await waitMs(25);
		while (hasLivePid(terminal.descendantPids)) await waitMs(25);
	}
};
async function spawnTerminalProcess(params, defaultCwd) {
	const directCommand = buildTerminalSpawnCommand(params.command, params.args);
	try {
		return {
			proc: await spawnAndWait(directCommand, params, defaultCwd),
			spawnCommand: directCommand
		};
	} catch (error) {
		const fallbackCommand = params.args === void 0 && isNotFoundSpawnError(error) ? buildTerminalFallbackSpawnCommand(params.command, params.cwd ?? defaultCwd) : void 0;
		if (!fallbackCommand) throw error;
		return {
			proc: await spawnAndWait(fallbackCommand, params, defaultCwd),
			spawnCommand: fallbackCommand
		};
	}
}
async function spawnAndWait(spawnCommand, params, defaultCwd) {
	const spawnOptions = buildTerminalSpawnOptions(spawnCommand.command, params.cwd ?? defaultCwd, params.env);
	if (spawnCommand.killProcessGroup) spawnOptions.detached = true;
	const proc = spawn(spawnCommand.command, spawnCommand.args, spawnOptions);
	await waitForSpawn(proc);
	return proc;
}
function isNotFoundSpawnError(error) {
	return error instanceof Error && error.code === "ENOENT";
}
function buildTerminalFallbackSpawnCommand(command, cwd, platform = process.platform) {
	if (commandPathExists(command, cwd)) return;
	if (platform === "win32") return hasWindowsShellSyntax(command) || /\s/u.test(command) ? buildTerminalShellSpawnCommand(command, platform) : void 0;
	if (hasShellSyntax(command) || /\s/u.test(command)) return buildTerminalShellSpawnCommand(command, platform);
}
function hasShellSyntax(command) {
	return /[|&;<>()>$`*?[\]{}'"\\\r\n]/u.test(command);
}
function hasWindowsShellSyntax(command) {
	return /[|&;<>()>$`*?[\]{}'"\r\n]/u.test(command);
}
function commandPathExists(command, cwd) {
	if (!/[\\/]/u.test(command)) return false;
	const resolvedPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
	return fs.existsSync(resolvedPath);
}
async function listDescendantPids(rootPid) {
	let output;
	try {
		output = await runProcessListCommand();
	} catch {
		return [];
	}
	const childrenByParent = /* @__PURE__ */ new Map();
	for (const line of output.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const parentPid = Number(match[2]);
		if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) continue;
		const children = childrenByParent.get(parentPid);
		if (children) children.push(pid);
		else childrenByParent.set(parentPid, [pid]);
	}
	const descendants = [];
	const queue = [...childrenByParent.get(rootPid) ?? []];
	for (let index = 0; index < queue.length; index += 1) {
		const pid = queue[index];
		descendants.push(pid);
		queue.push(...childrenByParent.get(pid) ?? []);
	}
	return descendants;
}
async function runProcessListCommand() {
	if (process.platform === "win32") return await runWindowsProcessListCommand();
	return await new Promise((resolve, reject) => {
		const child = spawn("ps", ["-eo", "pid=,ppid="], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(/* @__PURE__ */ new Error(`ps exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`));
		});
	});
}
async function rememberProcessGroupPids(terminal) {
	const processGroupId = terminal.process.pid;
	if (!terminal.killProcessGroup || !processGroupId) return;
	if (process.platform === "win32") {
		for (const pid of await listDescendantPids(processGroupId)) terminal.descendantPids.add(pid);
		return;
	}
	for (const pid of await listProcessGroupPids(processGroupId)) if (pid !== processGroupId) terminal.descendantPids.add(pid);
}
async function listProcessGroupPids(processGroupId) {
	let output;
	try {
		output = await runProcessGroupListCommand();
	} catch {
		return [];
	}
	const pids = [];
	for (const line of output.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const pgid = Number(match[2]);
		if (Number.isInteger(pid) && Number.isInteger(pgid) && pid > 0 && pgid === processGroupId) pids.push(pid);
	}
	return pids;
}
async function runProcessGroupListCommand() {
	return await new Promise((resolve, reject) => {
		const child = spawn("ps", ["-eo", "pid=,pgid="], { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(/* @__PURE__ */ new Error(`ps exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`));
		});
	});
}
async function runWindowsProcessListCommand() {
	return await new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			["Get-CimInstance Win32_Process |", "ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"].join(" ")
		], {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}
			reject(/* @__PURE__ */ new Error(`powershell process list exited with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr}`));
		});
	});
}
async function killWindowsProcessTree(pid, signal) {
	const args = [
		"/pid",
		String(pid),
		"/t"
	];
	if (signal === "SIGKILL") args.push("/f");
	await new Promise((resolve) => {
		const child = spawn("taskkill", args, {
			stdio: [
				"ignore",
				"ignore",
				"ignore"
			],
			windowsHide: true
		});
		child.once("error", () => resolve());
		child.once("close", () => resolve());
	});
}
function sendSignal(pid, signal) {
	try {
		process.kill(pid, signal);
	} catch {}
}
function hasLiveProcessGroup(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch {
		return false;
	}
}
function hasLiveTerminalProcessGroup(terminal) {
	const pid = terminal.process.pid;
	return Boolean(terminal.killProcessGroup && pid && process.platform !== "win32" && hasLiveProcessGroup(pid));
}
function hasLivePid(pids) {
	for (const pid of pids) try {
		process.kill(pid, 0);
		return true;
	} catch {
		pids.delete(pid);
	}
	return false;
}
const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5e3;
const DRAIN_POLL_INTERVAL_MS = 20;
const AGENT_CLOSE_TERM_GRACE_MS = 1500;
const AGENT_CLOSE_KILL_GRACE_MS = 1e3;
const STARTUP_STDERR_MAX_CHARS = 8192;
function shouldSuppressSdkConsoleError(args) {
	if (args.length === 0) return false;
	return typeof args[0] === "string" && args[0] === "Error handling request";
}
function installSdkConsoleErrorSuppression() {
	const originalConsoleError = console.error;
	console.error = (...args) => {
		if (shouldSuppressSdkConsoleError(args)) return;
		originalConsoleError(...args);
	};
	return () => {
		console.error = originalConsoleError;
	};
}
function createNdJsonMessageStream(agentCommand, output, input) {
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();
	return {
		readable: new ReadableStream({ async start(controller) {
			let content = "";
			const reader = input.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (!value) continue;
					content += textDecoder.decode(value, { stream: true });
					const lines = content.split("\n");
					content = lines.pop() || "";
					for (const line of lines) {
						const trimmedLine = line.trim();
						if (!trimmedLine || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)) continue;
						try {
							const message = JSON.parse(trimmedLine);
							controller.enqueue(message);
						} catch (err) {
							console.error("Failed to parse JSON message:", trimmedLine, err);
						}
					}
				}
			} finally {
				reader.releaseLock();
				controller.close();
			}
		} }),
		writable: new WritableStream({ async write(message) {
			const content = JSON.stringify(message) + "\n";
			const writer = output.getWriter();
			try {
				await writer.write(textEncoder.encode(content));
			} finally {
				writer.releaseLock();
			}
		} })
	};
}
var AcpClient = class {
	options;
	connection;
	agent;
	initResult;
	loadedSessionId;
	eventHandlers;
	permissionStats = {
		requested: 0,
		approved: 0,
		denied: 0,
		cancelled: 0
	};
	filesystem;
	terminalManager;
	sessionUpdateChain = Promise.resolve();
	observedSessionUpdates = 0;
	processedSessionUpdates = 0;
	suppressSessionUpdates = false;
	suppressReplaySessionUpdateMessages = false;
	activePrompt;
	cancellingSessionIds = /* @__PURE__ */ new Set();
	permissionAbortControllers = /* @__PURE__ */ new Map();
	closing = false;
	agentStartedAt;
	lastAgentExit;
	lastKnownPid;
	promptPermissionFailures = /* @__PURE__ */ new Map();
	pendingConnectionRequests = /* @__PURE__ */ new Set();
	constructor(options) {
		this.options = {
			...options,
			cwd: asAbsoluteCwd(options.cwd),
			authPolicy: options.authPolicy ?? "skip"
		};
		this.eventHandlers = {
			onAcpMessage: this.options.onAcpMessage,
			onAcpOutputMessage: this.options.onAcpOutputMessage,
			onSessionUpdate: this.options.onSessionUpdate,
			onClientOperation: this.options.onClientOperation,
			onPermissionEscalation: this.options.onPermissionEscalation
		};
		this.filesystem = new FileSystemHandlers({
			cwd: this.options.cwd,
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onOperation: (operation) => {
				this.eventHandlers.onClientOperation?.(operation);
			}
		});
		this.terminalManager = new TerminalManager({
			cwd: this.options.cwd,
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onOperation: (operation) => {
				this.eventHandlers.onClientOperation?.(operation);
			}
		});
	}
	get initializeResult() {
		return this.initResult;
	}
	getAgentPid() {
		return this.agent?.pid ?? this.lastKnownPid;
	}
	getPermissionStats() {
		return { ...this.permissionStats };
	}
	getAgentLifecycleSnapshot() {
		const pid = this.agent?.pid ?? this.lastKnownPid;
		const running = Boolean(this.agent) && this.agent?.exitCode == null && this.agent?.signalCode == null && !this.agent?.killed;
		return {
			pid,
			startedAt: this.agentStartedAt,
			running,
			lastExit: this.lastAgentExit ? { ...this.lastAgentExit } : void 0
		};
	}
	supportsLoadSession() {
		return Boolean(this.initResult?.agentCapabilities?.loadSession);
	}
	supportsCloseSession() {
		return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.close);
	}
	setEventHandlers(handlers) {
		this.eventHandlers = { ...handlers };
	}
	clearEventHandlers() {
		this.eventHandlers = {};
	}
	updateRuntimeOptions(options) {
		if (options.permissionMode) this.options.permissionMode = options.permissionMode;
		if (options.nonInteractivePermissions !== void 0) this.options.nonInteractivePermissions = options.nonInteractivePermissions;
		if (Object.prototype.hasOwnProperty.call(options, "permissionPolicy")) this.options.permissionPolicy = options.permissionPolicy;
		if (options.terminal !== void 0) this.options.terminal = options.terminal;
		if (options.permissionMode || options.nonInteractivePermissions !== void 0) {
			this.filesystem.updatePermissionPolicy(this.options.permissionMode, this.options.nonInteractivePermissions);
			this.terminalManager.updatePermissionPolicy(this.options.permissionMode, this.options.nonInteractivePermissions);
		}
		if (options.suppressSdkConsoleErrors !== void 0) this.options.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
		if (options.verbose !== void 0) this.options.verbose = options.verbose;
	}
	hasReusableSession(sessionId) {
		return this.connection != null && this.agent != null && isChildProcessRunning(this.agent) && this.loadedSessionId === sessionId;
	}
	hasActivePrompt(sessionId) {
		if (!this.activePrompt) return false;
		if (sessionId == null) return true;
		return this.activePrompt.sessionId === sessionId;
	}
	async start() {
		if (this.connection && this.agent && isChildProcessRunning(this.agent)) return;
		if (this.connection || this.agent) await this.close();
		const configuredCommand = splitCommandLine(this.options.agentCommand);
		const resolvedBuiltInLaunch = resolveBuiltInAgentLaunch(this.options.agentCommand);
		const spawnCommand = resolvedBuiltInLaunch?.command ?? configuredCommand.command;
		let args = resolvedBuiltInLaunch?.args ?? configuredCommand.args;
		args = await resolveGeminiCommandArgs(spawnCommand, args);
		if (isQoderAcpCommand(spawnCommand, args)) args = buildQoderAcpCommandArgs(args, this.options);
		if (resolvedBuiltInLaunch?.source === "installed") this.log(`spawning installed built-in agent ${resolvedBuiltInLaunch.packageName}${resolvedBuiltInLaunch.packageVersion ? `@${resolvedBuiltInLaunch.packageVersion}` : ""} via ${spawnCommand} ${args.join(" ")}`);
		else if (resolvedBuiltInLaunch?.source === "package-exec") this.log(`spawning built-in agent ${resolvedBuiltInLaunch.packageName}@${resolvedBuiltInLaunch.packageRange} via current Node package exec bridge ${spawnCommand} ${args.join(" ")}`);
		else this.log(`spawning agent: ${spawnCommand} ${args.join(" ")}`);
		const geminiAcp = isGeminiAcpCommand(spawnCommand, args);
		if (isCopilotAcpCommand(spawnCommand, args)) await ensureCopilotAcpSupport(spawnCommand);
		const agentSpawnOptions = buildAgentSpawnOptions(this.options.cwd, this.options.authCredentials);
		if (isClaudeAcpCommand$1(spawnCommand, args)) {
			const claudeExe = resolveClaudeCodeExecutable(process.platform, agentSpawnOptions.env);
			if (claudeExe) {
				agentSpawnOptions.env.CLAUDE_CODE_EXECUTABLE = claudeExe;
				this.log(`resolved system Claude Code executable: ${claudeExe}`);
			}
		}
		const spawnedChild = spawn(spawnCommand, args, buildSpawnCommandOptions(spawnCommand, agentSpawnOptions));
		try {
			await waitForSpawn$1(spawnedChild);
		} catch (error) {
			throw new AgentSpawnError(this.options.agentCommand, error);
		}
		const child = requireAgentStdio(spawnedChild);
		this.closing = false;
		this.agentStartedAt = isoNow$1();
		this.lastAgentExit = void 0;
		this.lastKnownPid = child.pid ?? void 0;
		this.attachAgentLifecycleObservers(child);
		const startupStderr = [];
		child.stderr.on("data", (chunk) => {
			this.captureStartupStderr(startupStderr, chunk);
			if (!this.options.verbose) return;
			process.stderr.write(chunk);
		});
		const input = Writable.toWeb(child.stdin);
		const output = Readable.toWeb(child.stdout);
		const connection = new ClientSideConnection(() => ({
			sessionUpdate: async (params) => {
				await this.handleSessionUpdate(params);
			},
			requestPermission: async (params) => {
				return this.handlePermissionRequest(params);
			},
			readTextFile: async (params) => {
				return this.handleReadTextFile(params);
			},
			writeTextFile: async (params) => {
				return this.handleWriteTextFile(params);
			},
			createTerminal: async (params) => {
				return this.handleCreateTerminal(params);
			},
			terminalOutput: async (params) => {
				return this.handleTerminalOutput(params);
			},
			waitForTerminalExit: async (params) => {
				return this.handleWaitForTerminalExit(params);
			},
			killTerminal: async (params) => {
				return this.handleKillTerminal(params);
			},
			releaseTerminal: async (params) => {
				return this.handleReleaseTerminal(params);
			}
		}), this.createTappedStream(createNdJsonMessageStream(this.options.agentCommand, input, output)));
		connection.signal.addEventListener("abort", () => {
			this.recordAgentExit("connection_close", child.exitCode ?? null, child.signalCode ?? null);
		}, { once: true });
		const startupFailure = this.createStartupFailureWatcher(child, startupStderr);
		try {
			const initResult = await Promise.race([(async () => {
				const initializePromise = connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {
						fs: {
							readTextFile: true,
							writeTextFile: true
						},
						terminal: this.options.terminal !== false
					},
					clientInfo: {
						name: "acpx",
						version: "0.1.0"
					}
				});
				const initialized = geminiAcp ? await withTimeout(initializePromise, resolveGeminiAcpStartupTimeoutMs()) : await initializePromise;
				await this.authenticateIfRequired(connection, initialized.authMethods ?? []);
				return initialized;
			})(), startupFailure.promise]);
			startupFailure.dispose();
			this.connection = connection;
			this.agent = child;
			this.initResult = initResult;
			this.log(`initialized protocol version ${initResult.protocolVersion}`);
		} catch (error) {
			startupFailure.dispose();
			const normalizedError = await this.normalizeInitializeError(error, child, startupStderr);
			try {
				child.kill();
			} catch {}
			if (geminiAcp && error instanceof TimeoutError) throw new GeminiAcpStartupTimeoutError(await buildGeminiAcpStartupTimeoutMessage(spawnCommand), {
				cause: error,
				retryable: true
			});
			throw normalizedError;
		}
	}
	createTappedStream(base) {
		const onAcpMessage = () => this.eventHandlers.onAcpMessage;
		const onAcpOutputMessage = () => this.eventHandlers.onAcpOutputMessage;
		const shouldSuppressInboundReplaySessionUpdate = (message) => {
			return this.suppressReplaySessionUpdateMessages && isSessionUpdateNotification(message);
		};
		return {
			readable: new ReadableStream({ async start(controller) {
				const reader = base.readable.getReader();
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						if (!value) continue;
						if (!shouldSuppressInboundReplaySessionUpdate(value)) {
							onAcpOutputMessage()?.("inbound", value);
							onAcpMessage()?.("inbound", value);
						}
						controller.enqueue(value);
					}
				} finally {
					reader.releaseLock();
					controller.close();
				}
			} }),
			writable: new WritableStream({ async write(message) {
				onAcpOutputMessage()?.("outbound", message);
				onAcpMessage()?.("outbound", message);
				const writer = base.writable.getWriter();
				try {
					await writer.write(message);
				} finally {
					writer.releaseLock();
				}
			} })
		};
	}
	async createSession(cwd = this.options.cwd) {
		const connection = this.getConnection();
		const { command, args } = splitCommandLine(this.options.agentCommand);
		const claudeAcp = isClaudeAcpCommand$1(command, args);
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		let result;
		try {
			const createPromise = this.runConnectionRequest(() => connection.newSession({
				cwd: sessionCwd,
				mcpServers: this.options.mcpServers ?? [],
				_meta: buildClaudeCodeOptionsMeta(this.options.sessionOptions)
			}));
			result = claudeAcp ? await withTimeout(createPromise, resolveClaudeAcpSessionCreateTimeoutMs()) : await createPromise;
		} catch (error) {
			if (claudeAcp && error instanceof TimeoutError) throw new ClaudeAcpSessionCreateTimeoutError(buildClaudeAcpSessionCreateTimeoutMessage(), {
				cause: error,
				retryable: true
			});
			throw error;
		}
		this.loadedSessionId = result.sessionId;
		return {
			sessionId: result.sessionId,
			agentSessionId: extractRuntimeSessionId(result._meta),
			configOptions: result.configOptions ?? void 0,
			models: result.models ?? void 0
		};
	}
	async loadSession(sessionId, cwd = this.options.cwd) {
		this.getConnection();
		return await this.loadSessionWithOptions(sessionId, cwd, {});
	}
	async loadSessionWithOptions(sessionId, cwd = this.options.cwd, options = {}) {
		const connection = this.getConnection();
		const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
		const previousSuppression = this.suppressSessionUpdates;
		const previousReplaySuppression = this.suppressReplaySessionUpdateMessages;
		this.suppressSessionUpdates = previousSuppression || Boolean(options.suppressReplayUpdates);
		this.suppressReplaySessionUpdateMessages = previousReplaySuppression || Boolean(options.suppressReplayUpdates);
		let response;
		try {
			response = await this.runConnectionRequest(() => connection.loadSession({
				sessionId,
				cwd: sessionCwd,
				mcpServers: this.options.mcpServers ?? []
			}));
			await this.waitForSessionUpdateDrain(options.replayIdleMs ?? REPLAY_IDLE_MS, options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS);
		} finally {
			this.suppressSessionUpdates = previousSuppression;
			this.suppressReplaySessionUpdateMessages = previousReplaySuppression;
		}
		this.loadedSessionId = sessionId;
		return {
			agentSessionId: extractRuntimeSessionId(response?._meta),
			configOptions: response?.configOptions ?? void 0,
			models: response?.models ?? void 0
		};
	}
	async prompt(sessionId, prompt) {
		const connection = this.getConnection();
		const restoreConsoleError = this.options.suppressSdkConsoleErrors ? installSdkConsoleErrorSuppression() : void 0;
		let promptPromise;
		try {
			promptPromise = this.runConnectionRequest(() => connection.prompt({
				sessionId,
				prompt: typeof prompt === "string" ? textPrompt(prompt) : prompt
			}));
		} catch (error) {
			restoreConsoleError?.();
			throw error;
		}
		this.activePrompt = {
			sessionId,
			promise: promptPromise
		};
		try {
			const response = await promptPromise;
			const permissionFailure = this.consumePromptPermissionFailure(sessionId);
			if (permissionFailure) throw permissionFailure;
			return response;
		} catch (error) {
			const permissionFailure = this.consumePromptPermissionFailure(sessionId);
			if (permissionFailure) throw permissionFailure;
			throw error;
		} finally {
			restoreConsoleError?.();
			if (this.activePrompt?.promise === promptPromise) this.activePrompt = void 0;
			this.cancellingSessionIds.delete(sessionId);
			this.abortAndDropPermissionSignal(sessionId);
			this.promptPermissionFailures.delete(sessionId);
		}
	}
	async setSessionMode(sessionId, modeId) {
		const connection = this.getConnection();
		try {
			await this.runConnectionRequest(() => connection.setSessionMode({
				sessionId,
				modeId
			}));
		} catch (error) {
			throw maybeWrapSessionControlError("session/set_mode", error, `for mode "${modeId}"`);
		}
	}
	async setSessionConfigOption(sessionId, configId, value) {
		const connection = this.getConnection();
		try {
			return await this.runConnectionRequest(() => connection.setSessionConfigOption({
				sessionId,
				configId,
				value
			}));
		} catch (error) {
			throw maybeWrapSessionControlError("session/set_config_option", error, `for "${configId}"="${value}"`);
		}
	}
	async setSessionModel(sessionId, modelId) {
		const connection = this.getConnection();
		try {
			await this.runConnectionRequest(() => connection.unstable_setSessionModel({
				sessionId,
				modelId
			}));
		} catch (error) {
			const wrapped = maybeWrapSessionControlError("session/set_model", error, `for model "${modelId}"`);
			if (wrapped !== error) throw wrapped;
			const acp = extractAcpError(error);
			const summary = acp ? formatSessionControlAcpSummary(acp) : error instanceof Error ? error.message : String(error);
			if (error instanceof Error) throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, { cause: error });
			throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, { cause: error });
		}
	}
	async cancel(sessionId) {
		const connection = this.getConnection();
		this.cancellingSessionIds.add(sessionId);
		this.abortAndDropPermissionSignal(sessionId);
		await this.runConnectionRequest(() => connection.cancel({ sessionId }));
	}
	async closeSession(sessionId) {
		const connection = this.getConnection();
		await this.runConnectionRequest(() => connection.closeSession({ sessionId }));
		if (this.loadedSessionId === sessionId) this.loadedSessionId = void 0;
	}
	async requestCancelActivePrompt() {
		const active = this.activePrompt;
		if (!active) return false;
		await this.cancel(active.sessionId);
		return true;
	}
	async cancelActivePrompt(waitMs = 2500) {
		const active = this.activePrompt;
		if (!active) return;
		try {
			await this.cancel(active.sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.log(`failed to send session/cancel: ${message}`);
		}
		if (waitMs <= 0) return;
		let timer;
		const timeoutPromise = new Promise((resolve) => {
			timer = setTimeout(resolve, waitMs);
		});
		try {
			return await Promise.race([active.promise.then((response) => response, () => void 0), timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async close() {
		this.closing = true;
		await this.terminalManager.shutdown();
		const agent = this.agent;
		if (agent) await this.terminateAgentProcess(agent);
		if (this.pendingConnectionRequests.size > 0) this.rejectPendingConnectionRequests(this.lastAgentExit ? new AgentDisconnectedError(this.lastAgentExit.reason, this.lastAgentExit.exitCode, this.lastAgentExit.signal, { outputAlreadyEmitted: Boolean(this.activePrompt) }) : new AgentDisconnectedError("connection_close", null, null, { outputAlreadyEmitted: Boolean(this.activePrompt) }));
		this.sessionUpdateChain = Promise.resolve();
		this.observedSessionUpdates = 0;
		this.processedSessionUpdates = 0;
		this.suppressSessionUpdates = false;
		this.suppressReplaySessionUpdateMessages = false;
		this.activePrompt = void 0;
		this.cancellingSessionIds.clear();
		for (const controller of this.permissionAbortControllers.values()) controller.abort();
		this.permissionAbortControllers.clear();
		this.promptPermissionFailures.clear();
		this.loadedSessionId = void 0;
		this.initResult = void 0;
		this.connection = void 0;
		this.agent = void 0;
	}
	async terminateAgentProcess(child) {
		const stdinCloseGraceMs = resolveAgentCloseAfterStdinEndMs(this.options.agentCommand);
		if (!child.stdin.destroyed) try {
			child.stdin.end();
		} catch {}
		let exited = await waitForChildExit(child, stdinCloseGraceMs);
		if (!exited && isChildProcessRunning(child)) {
			try {
				child.kill("SIGTERM");
			} catch {}
			exited = await waitForChildExit(child, AGENT_CLOSE_TERM_GRACE_MS);
		}
		if (!exited && isChildProcessRunning(child)) {
			this.log(`agent did not exit after ${AGENT_CLOSE_TERM_GRACE_MS}ms; forcing SIGKILL`);
			try {
				child.kill("SIGKILL");
			} catch {}
			exited = await waitForChildExit(child, AGENT_CLOSE_KILL_GRACE_MS);
		}
		this.detachAgentHandles(child, !exited);
	}
	detachAgentHandles(agent, unref) {
		const stdin = agent.stdin;
		const stdout = agent.stdout;
		const stderr = agent.stderr;
		stdin?.destroy();
		stdout?.destroy();
		stderr?.destroy();
		if (unref) try {
			agent.unref();
		} catch {}
	}
	getConnection() {
		if (!this.connection) throw new Error("ACP client not started");
		return this.connection;
	}
	log(message) {
		if (!this.options.verbose) return;
		process.stderr.write(`[acpx] ${message}\n`);
	}
	captureStartupStderr(target, chunk) {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		if (text.length === 0) return;
		target.push(text);
		if (target.join("").length - STARTUP_STDERR_MAX_CHARS <= 0) return;
		const joined = target.join("");
		target.splice(0, target.length, joined.slice(-8192));
	}
	summarizeStartupStderr(target) {
		const joined = target.join("").trim();
		if (!joined) return;
		return joined.replace(/\s+/gu, " ").trim().slice(0, STARTUP_STDERR_MAX_CHARS);
	}
	createStartupFailureWatcher(child, startupStderr) {
		let settled = false;
		let rejectPromise;
		const cleanup = () => {
			child.off("error", onError);
			child.off("exit", onExit);
			child.off("close", onClose);
		};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) rejectPromise(error);
		};
		const createError = (params) => new AgentStartupError({
			agentCommand: this.options.agentCommand,
			exitCode: params?.exitCode ?? child.exitCode ?? null,
			signal: params?.signal ?? child.signalCode ?? null,
			stderrSummary: this.summarizeStartupStderr(startupStderr),
			cause: params?.cause
		});
		const onError = (error) => {
			finish(createError({ cause: error }));
		};
		const onExit = (exitCode, signal) => {
			finish(createError({
				exitCode,
				signal
			}));
		};
		const onClose = (exitCode, signal) => {
			finish(createError({
				exitCode,
				signal
			}));
		};
		return {
			promise: new Promise((_resolve, reject) => {
				rejectPromise = reject;
				child.once("error", onError);
				child.once("exit", onExit);
				child.once("close", onClose);
			}),
			dispose: () => finish()
		};
	}
	async normalizeInitializeError(error, child, startupStderr) {
		if (error instanceof AgentStartupError) return error;
		const connectionClosedDuringInitialize = error instanceof Error && /acp connection closed/i.test(error.message);
		await waitForChildExit(child, 100);
		const childExited = child.exitCode !== null || child.signalCode !== null;
		if (!connectionClosedDuringInitialize && !childExited) return error;
		return new AgentStartupError({
			agentCommand: this.options.agentCommand,
			exitCode: child.exitCode ?? null,
			signal: child.signalCode ?? null,
			stderrSummary: this.summarizeStartupStderr(startupStderr),
			cause: error
		});
	}
	selectAuthMethod(methods) {
		for (const method of methods) {
			const envCredential = readEnvCredential(method.id);
			if (envCredential) return {
				methodId: method.id,
				credential: envCredential,
				source: "env"
			};
			const configCredential = resolveConfiguredAuthCredential(method.id, this.options.authCredentials);
			if (typeof configCredential === "string" && configCredential.trim().length > 0) return {
				methodId: method.id,
				credential: configCredential,
				source: "config"
			};
		}
	}
	async authenticateIfRequired(connection, methods) {
		if (methods.length === 0) return;
		const selected = this.selectAuthMethod(methods);
		if (!selected) {
			if (this.options.authPolicy === "fail") throw new AuthPolicyError(`agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found`);
			this.log(`agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found — skipping (agent may handle auth internally)`);
			return;
		}
		await connection.authenticate({ methodId: selected.methodId });
		this.log(`authenticated with method ${selected.methodId} (${selected.source})`);
	}
	async handlePermissionRequest(params) {
		if (this.cancellingSessionIds.has(params.sessionId)) return { outcome: { outcome: "cancelled" } };
		if (this.options.onPermissionRequest) {
			const signal = this.cancellationSignalForSession(params.sessionId);
			try {
				const decision = await this.options.onPermissionRequest({
					sessionId: params.sessionId,
					raw: params,
					inferredKind: inferToolKind(params)
				}, { signal });
				if (signal.aborted || this.cancellingSessionIds.has(params.sessionId)) {
					this.recordPermissionDecision("cancelled");
					return { outcome: { outcome: "cancelled" } };
				}
				if (decision) {
					const response = decisionToResponse(params, decision);
					this.recordPermissionDecision(classifyPermissionDecision(params, response));
					return response;
				}
			} catch (error) {
				if (signal.aborted || this.cancellingSessionIds.has(params.sessionId)) {
					this.recordPermissionDecision("cancelled");
					return { outcome: { outcome: "cancelled" } };
				}
				this.log(`onPermissionRequest threw, falling through to mode-based resolver: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		let response;
		try {
			const result = await resolvePermissionRequestWithDetails(params, this.options.permissionMode, this.options.nonInteractivePermissions ?? "deny", this.options.permissionPolicy);
			response = result.response;
			if (result.escalation) this.eventHandlers.onPermissionEscalation?.(result.escalation);
		} catch (error) {
			if (error instanceof PermissionPromptUnavailableError) {
				this.notePromptPermissionFailure(params.sessionId, error);
				this.recordPermissionDecision("cancelled");
				return { outcome: { outcome: "cancelled" } };
			}
			throw error;
		}
		const decision = classifyPermissionDecision(params, response);
		this.recordPermissionDecision(decision);
		return response;
	}
	attachAgentLifecycleObservers(child) {
		child.once("exit", (exitCode, signal) => {
			this.recordAgentExit("process_exit", exitCode, signal);
		});
		child.once("close", (exitCode, signal) => {
			this.recordAgentExit("process_close", exitCode, signal);
		});
		child.stdout.once("close", () => {
			this.recordAgentExit("pipe_close", child.exitCode ?? null, child.signalCode ?? null);
		});
	}
	recordAgentExit(reason, exitCode, signal) {
		if (this.lastAgentExit) return;
		this.lastAgentExit = {
			exitCode,
			signal,
			exitedAt: isoNow$1(),
			reason,
			unexpectedDuringPrompt: !this.closing && Boolean(this.activePrompt)
		};
		this.rejectPendingConnectionRequests(new AgentDisconnectedError(reason, exitCode, signal, { outputAlreadyEmitted: Boolean(this.activePrompt) }));
	}
	notePromptPermissionFailure(sessionId, error) {
		if (!this.promptPermissionFailures.has(sessionId)) this.promptPermissionFailures.set(sessionId, error);
	}
	consumePromptPermissionFailure(sessionId) {
		const error = this.promptPermissionFailures.get(sessionId);
		if (error) this.promptPermissionFailures.delete(sessionId);
		return error;
	}
	async runConnectionRequest(run) {
		return await new Promise((resolve, reject) => {
			const pending = {
				settled: false,
				reject
			};
			const finish = (cb) => {
				if (pending.settled) return;
				pending.settled = true;
				this.pendingConnectionRequests.delete(pending);
				cb();
			};
			this.pendingConnectionRequests.add(pending);
			Promise.resolve().then(run).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
		});
	}
	rejectPendingConnectionRequests(error) {
		for (const pending of this.pendingConnectionRequests) {
			if (pending.settled) {
				this.pendingConnectionRequests.delete(pending);
				continue;
			}
			pending.settled = true;
			this.pendingConnectionRequests.delete(pending);
			pending.reject(error);
		}
	}
	async handleReadTextFile(params) {
		try {
			return await this.filesystem.readTextFile(params);
		} catch (error) {
			this.recordPermissionError(params.sessionId, error);
			throw error;
		}
	}
	async handleWriteTextFile(params) {
		try {
			return await this.filesystem.writeTextFile(params);
		} catch (error) {
			this.recordPermissionError(params.sessionId, error);
			throw error;
		}
	}
	async handleCreateTerminal(params) {
		try {
			return await this.terminalManager.createTerminal(params);
		} catch (error) {
			this.recordPermissionError(params.sessionId, error);
			throw error;
		}
	}
	async handleTerminalOutput(params) {
		return await this.terminalManager.terminalOutput(params);
	}
	async handleWaitForTerminalExit(params) {
		return await this.terminalManager.waitForTerminalExit(params);
	}
	async handleKillTerminal(params) {
		return await this.terminalManager.killTerminal(params);
	}
	async handleReleaseTerminal(params) {
		return await this.terminalManager.releaseTerminal(params);
	}
	cancellationSignalForSession(sessionId) {
		let controller = this.permissionAbortControllers.get(sessionId);
		if (!controller) {
			controller = new AbortController();
			this.permissionAbortControllers.set(sessionId, controller);
		}
		return controller.signal;
	}
	abortAndDropPermissionSignal(sessionId) {
		const controller = this.permissionAbortControllers.get(sessionId);
		if (controller) {
			controller.abort();
			this.permissionAbortControllers.delete(sessionId);
		}
	}
	recordPermissionDecision(decision) {
		this.permissionStats.requested += 1;
		if (decision === "approved") {
			this.permissionStats.approved += 1;
			return;
		}
		if (decision === "denied") {
			this.permissionStats.denied += 1;
			return;
		}
		this.permissionStats.cancelled += 1;
	}
	recordPermissionError(sessionId, error) {
		if (error instanceof PermissionPromptUnavailableError) {
			this.notePromptPermissionFailure(sessionId, error);
			this.recordPermissionDecision("cancelled");
			return;
		}
		if (error instanceof PermissionDeniedError) this.recordPermissionDecision("denied");
	}
	async handleSessionUpdate(notification) {
		const sequence = ++this.observedSessionUpdates;
		this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
			try {
				if (!this.suppressSessionUpdates) this.eventHandlers.onSessionUpdate?.(notification);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.log(`session update handler failed: ${message}`);
			} finally {
				this.processedSessionUpdates = sequence;
			}
		});
		await this.sessionUpdateChain;
	}
	async waitForSessionUpdateDrain(idleMs, timeoutMs) {
		const normalizedIdleMs = Math.max(0, idleMs);
		const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
		const deadline = Date.now() + normalizedTimeoutMs;
		let lastObserved = this.observedSessionUpdates;
		let idleSince = Date.now();
		while (Date.now() <= deadline) {
			const observed = this.observedSessionUpdates;
			if (observed !== lastObserved) {
				lastObserved = observed;
				idleSince = Date.now();
			}
			if (this.processedSessionUpdates === this.observedSessionUpdates && Date.now() - idleSince >= normalizedIdleMs) {
				await this.sessionUpdateChain;
				if (this.processedSessionUpdates === this.observedSessionUpdates) return;
			}
			await new Promise((resolve) => {
				setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
			});
		}
		throw new Error(`Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`);
	}
	async waitForSessionUpdatesIdle(options) {
		await this.waitForSessionUpdateDrain(options?.idleMs ?? 0, options?.timeoutMs ?? 0);
	}
};
function persistSessionOptions(record, options) {
	const systemPromptOption = options?.systemPrompt;
	const normalizedSystemPrompt = typeof systemPromptOption === "string" && systemPromptOption.length > 0 ? systemPromptOption : systemPromptOption && typeof systemPromptOption === "object" && typeof systemPromptOption.append === "string" && systemPromptOption.append.length > 0 ? { append: systemPromptOption.append } : void 0;
	const next = options && {
		model: typeof options.model === "string" ? options.model : void 0,
		allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : void 0,
		max_turns: typeof options.maxTurns === "number" ? options.maxTurns : void 0,
		system_prompt: normalizedSystemPrompt
	};
	if (Boolean(next && (typeof next.model === "string" && next.model.trim().length > 0 || Array.isArray(next.allowed_tools) || typeof next.max_turns === "number" || next.system_prompt !== void 0)) && next) {
		record.acpx = {
			...record.acpx,
			session_options: next
		};
		return;
	}
	if (!record.acpx) return;
	delete record.acpx.session_options;
}
function sessionOptionsFromRecord(record) {
	const stored = record.acpx?.session_options;
	if (!stored) return;
	const sessionOptions = {};
	if (typeof stored.model === "string" && stored.model.trim().length > 0) sessionOptions.model = stored.model;
	if (Array.isArray(stored.allowed_tools)) sessionOptions.allowedTools = [...stored.allowed_tools];
	if (typeof stored.max_turns === "number") sessionOptions.maxTurns = stored.max_turns;
	const storedSystemPrompt = stored.system_prompt;
	if (typeof storedSystemPrompt === "string" && storedSystemPrompt.length > 0) sessionOptions.systemPrompt = storedSystemPrompt;
	else if (storedSystemPrompt && typeof storedSystemPrompt === "object" && typeof storedSystemPrompt.append === "string" && storedSystemPrompt.append.length > 0) sessionOptions.systemPrompt = { append: storedSystemPrompt.append };
	return Object.keys(sessionOptions).length > 0 ? sessionOptions : void 0;
}
const MAX_RUNTIME_MESSAGES = 200;
const MAX_RUNTIME_AGENT_TEXT_CHARS = 8e3;
const MAX_RUNTIME_THINKING_CHARS = 4e3;
const MAX_RUNTIME_TOOL_IO_CHARS = 4e3;
const MAX_RUNTIME_REQUEST_TOKEN_USAGE = 100;
function isoNow$3() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function deepClone(value) {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}
function hasOwn(source, key) {
	return Object.prototype.hasOwnProperty.call(source, key);
}
function normalizeAgentName$2(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function extractText(content) {
	if (content.type === "text") return content.text;
	if (content.type === "resource_link") return content.title ?? content.name ?? content.uri;
	if (content.type === "resource") {
		if ("text" in content.resource && typeof content.resource.text === "string") return content.resource.text;
		return content.resource.uri;
	}
}
function contentToUserContent(content) {
	if (content.type === "text") return { Text: content.text };
	if (content.type === "resource_link") {
		const value = content.title ?? content.name ?? content.uri;
		return { Mention: {
			uri: content.uri,
			content: value
		} };
	}
	if (content.type === "resource") {
		if ("text" in content.resource && typeof content.resource.text === "string") return { Text: content.resource.text };
		return { Mention: {
			uri: content.resource.uri,
			content: content.resource.uri
		} };
	}
	if (content.type === "image") return { Image: {
		source: content.data,
		size: null
	} };
}
function nextUserMessageId() {
	return randomUUID();
}
function isUserMessage(message) {
	return typeof message === "object" && message !== null && hasOwn(message, "User");
}
function isAgentMessage(message) {
	return typeof message === "object" && message !== null && hasOwn(message, "Agent");
}
function isAgentTextContent(content) {
	return hasOwn(content, "Text");
}
function isAgentThinkingContent(content) {
	return hasOwn(content, "Thinking");
}
function isAgentToolUseContent(content) {
	return hasOwn(content, "ToolUse");
}
function updateConversationTimestamp(conversation, timestamp) {
	conversation.updated_at = timestamp;
}
function ensureAgentMessage(conversation) {
	const last = conversation.messages.at(-1);
	if (last && isAgentMessage(last)) return last.Agent;
	const created = {
		content: [],
		tool_results: {}
	};
	conversation.messages.push({ Agent: created });
	return created;
}
function appendAgentText(agent, text) {
	if (!text.trim()) return;
	const last = agent.content.at(-1);
	if (last && isAgentTextContent(last)) {
		last.Text = trimRuntimeText(`${last.Text}${text}`, MAX_RUNTIME_AGENT_TEXT_CHARS);
		return;
	}
	const next = { Text: text };
	agent.content.push(next);
}
function appendAgentThinking(agent, text) {
	if (!text.trim()) return;
	const last = agent.content.at(-1);
	if (last && isAgentThinkingContent(last)) {
		last.Thinking.text = trimRuntimeText(`${last.Thinking.text}${text}`, MAX_RUNTIME_THINKING_CHARS);
		return;
	}
	const next = { Thinking: {
		text,
		signature: null
	} };
	agent.content.push(next);
}
function trimRuntimeText(value, maxChars) {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
function statusIndicatesComplete(status) {
	if (typeof status !== "string") return false;
	const normalized = status.toLowerCase();
	return normalized.includes("complete") || normalized.includes("done") || normalized.includes("success") || normalized.includes("failed") || normalized.includes("error") || normalized.includes("cancel");
}
function statusIndicatesError(status) {
	if (typeof status !== "string") return false;
	const normalized = status.toLowerCase();
	return normalized.includes("fail") || normalized.includes("error");
}
function toToolResultContent(value) {
	if (typeof value === "string") return { Text: trimRuntimeText(value, MAX_RUNTIME_TOOL_IO_CHARS) };
	if (value != null) try {
		return { Text: trimRuntimeText(JSON.stringify(value), MAX_RUNTIME_TOOL_IO_CHARS) };
	} catch {
		return { Text: "[Unserializable value]" };
	}
	return { Text: "" };
}
function toRawInput(value) {
	if (typeof value === "string") return trimRuntimeText(value, MAX_RUNTIME_TOOL_IO_CHARS);
	try {
		return trimRuntimeText(JSON.stringify(value ?? {}), MAX_RUNTIME_TOOL_IO_CHARS);
	} catch {
		return value == null ? "" : "[Unserializable input]";
	}
}
function ensureToolUseContent(agent, toolCallId) {
	for (const content of agent.content) if (isAgentToolUseContent(content) && content.ToolUse.id === toolCallId) return content.ToolUse;
	const created = {
		id: toolCallId,
		name: "tool_call",
		raw_input: "{}",
		input: {},
		is_input_complete: false,
		thought_signature: null
	};
	agent.content.push({ ToolUse: created });
	return created;
}
function upsertToolResult(agent, toolCallId, patch) {
	const existing = agent.tool_results[toolCallId];
	const next = {
		tool_use_id: toolCallId,
		tool_name: patch.tool_name ?? existing?.tool_name ?? "tool_call",
		is_error: patch.is_error ?? existing?.is_error ?? false,
		content: patch.content ?? existing?.content ?? { Text: "" },
		output: patch.output ?? existing?.output
	};
	agent.tool_results[toolCallId] = next;
}
function applyToolCallUpdate(agent, update) {
	const tool = ensureToolUseContent(agent, update.toolCallId);
	if (hasOwn(update, "title")) tool.name = normalizeAgentName$2(update.title) ?? tool.name ?? "tool_call";
	if (hasOwn(update, "kind")) {
		const kindName = normalizeAgentName$2(update.kind);
		if (!tool.name || tool.name === "tool_call") tool.name = kindName ?? tool.name;
	}
	if (hasOwn(update, "rawInput")) {
		const rawInput = deepClone(update.rawInput);
		tool.input = rawInput ?? {};
		tool.raw_input = toRawInput(rawInput);
	}
	if (hasOwn(update, "status")) tool.is_input_complete = statusIndicatesComplete(update.status);
	if (hasOwn(update, "rawOutput") || hasOwn(update, "status") || hasOwn(update, "title") || hasOwn(update, "kind")) {
		const status = update.status;
		const output = hasOwn(update, "rawOutput") ? deepClone(update.rawOutput) : void 0;
		upsertToolResult(agent, update.toolCallId, {
			tool_name: tool.name,
			is_error: statusIndicatesError(status),
			content: output === void 0 ? void 0 : toToolResultContent(output),
			output
		});
	}
}
function asRecord(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	return value;
}
function numberField(source, keys) {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}
}
function usageToTokenUsage(update) {
	const updateRecord = asRecord(update);
	const usageMeta = asRecord(updateRecord?._meta)?.usage;
	const source = asRecord(usageMeta) ?? updateRecord;
	if (!source) return;
	const normalized = {
		input_tokens: numberField(source, ["input_tokens", "inputTokens"]),
		output_tokens: numberField(source, ["output_tokens", "outputTokens"]),
		cache_creation_input_tokens: numberField(source, [
			"cache_creation_input_tokens",
			"cacheCreationInputTokens",
			"cachedWriteTokens"
		]),
		cache_read_input_tokens: numberField(source, [
			"cache_read_input_tokens",
			"cacheReadInputTokens",
			"cachedReadTokens"
		])
	};
	if (normalized.input_tokens === void 0 && normalized.output_tokens === void 0 && normalized.cache_creation_input_tokens === void 0 && normalized.cache_read_input_tokens === void 0) return;
	return normalized;
}
function ensureAcpxState$1(state) {
	return state ?? {};
}
function lastUserMessageId(conversation) {
	for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
		const message = conversation.messages[index];
		if (message && isUserMessage(message)) return message.User.id;
	}
}
function createSessionConversation(timestamp = isoNow$3()) {
	return {
		title: null,
		messages: [],
		updated_at: timestamp,
		cumulative_token_usage: {},
		request_token_usage: {}
	};
}
function cloneSessionConversation(conversation) {
	if (!conversation) return createSessionConversation();
	return {
		title: conversation.title,
		messages: deepClone(conversation.messages ?? []),
		updated_at: conversation.updated_at,
		cumulative_token_usage: deepClone(conversation.cumulative_token_usage ?? {}),
		request_token_usage: deepClone(conversation.request_token_usage ?? {})
	};
}
function cloneSessionAcpxState(state) {
	if (!state) return;
	return {
		current_mode_id: state.current_mode_id,
		desired_mode_id: state.desired_mode_id,
		desired_config_options: state.desired_config_options ? { ...state.desired_config_options } : void 0,
		current_model_id: state.current_model_id,
		available_models: state.available_models ? [...state.available_models] : void 0,
		available_commands: state.available_commands ? [...state.available_commands] : void 0,
		config_options: state.config_options ? deepClone(state.config_options) : void 0,
		session_options: state.session_options ? {
			model: state.session_options.model,
			allowed_tools: state.session_options.allowed_tools ? [...state.session_options.allowed_tools] : void 0,
			max_turns: state.session_options.max_turns,
			...state.session_options.system_prompt !== void 0 ? { system_prompt: typeof state.session_options.system_prompt === "string" ? state.session_options.system_prompt : { append: state.session_options.system_prompt.append } } : {}
		} : void 0
	};
}
function recordPromptSubmission(conversation, prompt, timestamp = isoNow$3()) {
	const userContent = (typeof prompt === "string" ? textPrompt(prompt) : prompt).map((content) => contentToUserContent(content)).filter((content) => content !== void 0);
	if (userContent.length === 0) return;
	const promptMessageId = nextUserMessageId();
	conversation.messages.push({ User: {
		id: promptMessageId,
		content: userContent.map((content) => {
			if ("Text" in content) return { Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS) };
			return content;
		})
	} });
	updateConversationTimestamp(conversation, timestamp);
	trimConversationForRuntime(conversation);
	return promptMessageId;
}
function agentMessageHasObservedReply(message) {
	return message.content.length > 0 || Object.keys(message.tool_results).length > 0;
}
function hasAgentReplyAfterPrompt(conversation, promptMessageId) {
	let sawPrompt = false;
	for (const message of conversation.messages) {
		if (!sawPrompt) {
			if (isUserMessage(message) && message.User.id === promptMessageId) sawPrompt = true;
			continue;
		}
		if (isAgentMessage(message) && agentMessageHasObservedReply(message.Agent)) return true;
	}
	return false;
}
function recordSessionUpdate(conversation, state, notification, timestamp = isoNow$3()) {
	const acpx = ensureAcpxState$1(state);
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			const userContent = contentToUserContent(update.content);
			if (userContent) conversation.messages.push({ User: {
				id: nextUserMessageId(),
				content: [userContent]
			} });
			break;
		}
		case "agent_message_chunk": {
			const text = extractText(update.content);
			if (text) appendAgentText(ensureAgentMessage(conversation), text);
			break;
		}
		case "agent_thought_chunk": {
			const text = extractText(update.content);
			if (text) appendAgentThinking(ensureAgentMessage(conversation), text);
			break;
		}
		case "tool_call":
		case "tool_call_update":
			applyToolCallUpdate(ensureAgentMessage(conversation), update);
			break;
		case "usage_update": {
			const usage = usageToTokenUsage(update);
			if (usage) {
				conversation.cumulative_token_usage = usage;
				const userId = lastUserMessageId(conversation);
				if (userId) conversation.request_token_usage[userId] = usage;
			}
			break;
		}
		case "session_info_update":
			if (hasOwn(update, "title")) conversation.title = update.title ?? null;
			if (hasOwn(update, "updatedAt")) conversation.updated_at = update.updatedAt ?? conversation.updated_at;
			break;
		case "available_commands_update":
			acpx.available_commands = update.availableCommands.map((entry) => entry.name).filter((entry) => typeof entry === "string" && entry.trim().length > 0);
			break;
		case "current_mode_update":
			acpx.current_mode_id = update.currentModeId;
			break;
		case "config_option_update":
			acpx.config_options = deepClone(update.configOptions);
			break;
		default: break;
	}
	updateConversationTimestamp(conversation, timestamp);
	trimConversationForRuntime(conversation);
	return acpx;
}
function recordClientOperation(conversation, state, operation, timestamp = isoNow$3()) {
	const acpx = ensureAcpxState$1(state);
	updateConversationTimestamp(conversation, timestamp);
	trimConversationForRuntime(conversation);
	return acpx;
}
function trimConversationForRuntime(conversation) {
	if (conversation.messages.length > MAX_RUNTIME_MESSAGES) conversation.messages = conversation.messages.slice(-200);
	for (const message of conversation.messages) {
		if (!isAgentMessage(message)) {
			if (isUserMessage(message)) message.User.content = message.User.content.map((content) => {
				if ("Text" in content) return { Text: trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS) };
				return content;
			});
			continue;
		}
		for (const content of message.Agent.content) if ("Text" in content) content.Text = trimRuntimeText(content.Text, MAX_RUNTIME_AGENT_TEXT_CHARS);
		else if ("Thinking" in content) content.Thinking.text = trimRuntimeText(content.Thinking.text, MAX_RUNTIME_THINKING_CHARS);
		else if ("ToolUse" in content) content.ToolUse.raw_input = trimRuntimeText(content.ToolUse.raw_input, MAX_RUNTIME_TOOL_IO_CHARS);
		for (const result of Object.values(message.Agent.tool_results)) {
			if ("Text" in result.content) result.content.Text = trimRuntimeText(result.content.Text, MAX_RUNTIME_TOOL_IO_CHARS);
			if (typeof result.output === "string") result.output = trimRuntimeText(result.output, MAX_RUNTIME_TOOL_IO_CHARS);
		}
	}
	const requestUsageEntries = Object.entries(conversation.request_token_usage);
	if (requestUsageEntries.length > MAX_RUNTIME_REQUEST_TOKEN_USAGE) conversation.request_token_usage = Object.fromEntries(requestUsageEntries.slice(-100));
}
function applyConfigOptionsToRecord(record, result) {
	const configOptions = result?.configOptions;
	if (!configOptions) return;
	const acpxState = cloneSessionAcpxState(record.acpx) ?? {};
	acpxState.config_options = structuredClone(configOptions);
	record.acpx = acpxState;
}
function ensureAcpxState(state) {
	return state ?? {};
}
function normalizeModeId(modeId) {
	if (typeof modeId !== "string") return;
	const trimmed = modeId.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function normalizeModelId(modelId) {
	if (typeof modelId !== "string") return;
	const trimmed = modelId.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function getDesiredModeId(state) {
	return normalizeModeId(state?.desired_mode_id);
}
function getDesiredConfigOptions(state) {
	const desired = state?.desired_config_options;
	if (!desired) return {};
	return Object.fromEntries(Object.entries(desired).flatMap(([configId, value]) => {
		const normalizedConfigId = normalizeModeId(configId);
		return normalizedConfigId && typeof value === "string" ? [[normalizedConfigId, value]] : [];
	}));
}
function setDesiredModeId(record, modeId) {
	const acpx = ensureAcpxState(record.acpx);
	const normalized = normalizeModeId(modeId);
	if (normalized) acpx.desired_mode_id = normalized;
	else delete acpx.desired_mode_id;
	record.acpx = acpx;
}
function setDesiredConfigOption(record, configId, value) {
	const normalizedConfigId = normalizeModeId(configId);
	if (!normalizedConfigId || normalizedConfigId === "mode" || normalizedConfigId === "model") return;
	const acpx = ensureAcpxState(record.acpx);
	const desired = { ...acpx.desired_config_options };
	if (typeof value === "string") desired[normalizedConfigId] = value;
	else delete desired[normalizedConfigId];
	if (Object.keys(desired).length > 0) acpx.desired_config_options = desired;
	else delete acpx.desired_config_options;
	record.acpx = acpx;
}
function getDesiredModelId(state) {
	return normalizeModelId(state?.session_options?.model);
}
function setCurrentModelId(record, modelId) {
	const acpx = ensureAcpxState(record.acpx);
	const normalized = normalizeModelId(modelId);
	if (normalized) acpx.current_model_id = normalized;
	else delete acpx.current_model_id;
	record.acpx = acpx;
}
function syncAdvertisedModelState(record, models) {
	if (!models) return;
	const acpx = ensureAcpxState(record.acpx);
	acpx.current_model_id = models.currentModelId;
	acpx.available_models = models.availableModels.map((model) => model.modelId);
	record.acpx = acpx;
}
var RequestedModelUnsupportedError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "RequestedModelUnsupportedError";
	}
};
function supportsLegacyClaudeCodeModelMetadata(agentCommand) {
	if (!agentCommand) return false;
	const { command, args } = splitCommandLine(agentCommand);
	return isClaudeAcpCommand$1(command, args);
}
function formatAvailableModelIds(models) {
	const ids = models?.availableModels.map((model) => model.modelId.trim()).filter((modelId) => modelId.length > 0) ?? [];
	return ids.length > 0 ? ids.join(", ") : "none advertised";
}
function assertRequestedModelSupported(params) {
	if (!params.models) {
		if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) return;
		throw new RequestedModelUnsupportedError(`Cannot ${params.context === "replay" ? "replay saved model" : "apply --model"} "${params.requestedModel}": the ACP agent did not advertise model support. Generic model selection requires ACP models plus session/set_model support, or an adapter-specific startup model flag.`);
	}
	if (!new Set(params.models.availableModels.map((model) => model.modelId)).has(params.requestedModel)) throw new RequestedModelUnsupportedError(`Cannot ${params.context === "replay" ? "replay saved model" : "apply --model"} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`);
}
async function applyRequestedModelIfAdvertised(params) {
	const requestedModel = typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
	if (!requestedModel) return false;
	assertRequestedModelSupported({
		requestedModel,
		models: params.models,
		agentCommand: params.agentCommand,
		context: "apply"
	});
	if (!params.models) return false;
	if (params.models.currentModelId === requestedModel) return true;
	await withTimeout(params.client.setSessionModel(params.sessionId, requestedModel), params.timeoutMs);
	return true;
}
function applyLifecycleSnapshotToRecord(record, snapshot) {
	if (!snapshot) return;
	record.pid = snapshot.pid;
	record.agentStartedAt = snapshot.startedAt;
	if (snapshot.lastExit) {
		record.lastAgentExitCode = snapshot.lastExit.exitCode;
		record.lastAgentExitSignal = snapshot.lastExit.signal;
		record.lastAgentExitAt = snapshot.lastExit.exitedAt;
		record.lastAgentDisconnectReason = snapshot.lastExit.reason;
		return;
	}
	record.lastAgentExitCode = void 0;
	record.lastAgentExitSignal = void 0;
	record.lastAgentExitAt = void 0;
	record.lastAgentDisconnectReason = void 0;
}
function reconcileAgentSessionId(record, agentSessionId) {
	const normalized = normalizeRuntimeSessionId(agentSessionId);
	if (!normalized) return;
	record.agentSessionId = normalized;
}
function sessionHasAgentMessages(recordOrConversation) {
	return recordOrConversation.messages.some((message) => typeof message === "object" && message !== null && "Agent" in message);
}
function applyConversation(record, conversation) {
	record.title = conversation.title;
	record.updated_at = conversation.updated_at;
	record.messages = conversation.messages;
	record.cumulative_token_usage = conversation.cumulative_token_usage;
	record.request_token_usage = conversation.request_token_usage;
}
function isProcessAlive(pid) {
	if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
const SESSION_LOAD_UNSUPPORTED_CODES = new Set([-32601, -32602]);
function shouldFallbackToNewSession(error, record) {
	if (error instanceof TimeoutError || error instanceof InterruptedError) return false;
	if (isAcpResourceNotFoundError(error)) return true;
	const acp = extractAcpError(error);
	if (acp && SESSION_LOAD_UNSUPPORTED_CODES.has(acp.code)) return true;
	if (!sessionHasAgentMessages(record)) {
		if (isAcpQueryClosedBeforeResponseError(error)) return true;
		if (acp?.code === -32603) return true;
	}
	return false;
}
function requiresSameSession(resumePolicy) {
	return resumePolicy === "same-session-only";
}
function makeSessionResumeRequiredError(params) {
	return new SessionResumeRequiredError(`Persistent ACP session ${params.record.acpSessionId} could not be resumed: ${params.reason}`, { cause: params.cause instanceof Error ? params.cause : void 0 });
}
async function replayDesiredMode(params) {
	if (!params.desiredModeId) return;
	try {
		await withTimeout(params.client.setSessionMode(params.sessionId, params.desiredModeId), params.timeoutMs);
		if (params.verbose) process.stderr.write(`[acpx] replayed desired mode ${params.desiredModeId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
	} catch (error) {
		throw new SessionModeReplayError(`Failed to replay saved session mode ${params.desiredModeId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
			cause: error instanceof Error ? error : void 0,
			retryable: true
		});
	}
}
async function replayDesiredModel(params) {
	if (!params.desiredModelId) return;
	try {
		assertRequestedModelSupported({
			requestedModel: params.desiredModelId,
			models: params.models,
			agentCommand: params.record.agentCommand,
			context: "replay"
		});
		if (!params.models || params.models.currentModelId === params.desiredModelId) return;
		await withTimeout(params.client.setSessionModel(params.sessionId, params.desiredModelId), params.timeoutMs);
		if (params.verbose) process.stderr.write(`[acpx] replayed desired model ${params.desiredModelId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
	} catch (error) {
		throw new SessionModelReplayError(`Failed to replay saved session model ${params.desiredModelId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
			cause: error instanceof Error ? error : void 0,
			retryable: true
		});
	}
}
async function replayDesiredConfigOptions(params) {
	for (const [configId, value] of Object.entries(params.desiredConfigOptions)) try {
		await withTimeout(params.client.setSessionConfigOption(params.sessionId, configId, value), params.timeoutMs);
		if (params.verbose) process.stderr.write(`[acpx] replayed desired config option ${configId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`);
	} catch (error) {
		throw new SessionConfigOptionReplayError(`Failed to replay saved session config option ${configId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`, {
			cause: error instanceof Error ? error : void 0,
			retryable: true
		});
	}
}
function restoreOriginalSessionState(params) {
	params.record.acpSessionId = params.sessionId;
	params.record.agentSessionId = params.agentSessionId;
}
async function connectAndLoadSession(options) {
	const record = options.record;
	const client = options.client;
	const sameSessionOnly = requiresSameSession(options.resumePolicy);
	const originalSessionId = record.acpSessionId;
	const originalAgentSessionId = record.agentSessionId;
	const desiredModeId = getDesiredModeId(record.acpx);
	const desiredModelId = getDesiredModelId(record.acpx);
	const desiredConfigOptions = getDesiredConfigOptions(record.acpx);
	const storedProcessAlive = isProcessAlive(record.pid);
	const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;
	if (options.verbose) {
		if (storedProcessAlive) process.stderr.write(`[acpx] saved session pid ${record.pid} is running; reconnecting with loadSession\n`);
		else if (shouldReconnect) process.stderr.write(`[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session/load\n`);
	}
	const reusingLoadedSession = client.hasReusableSession(record.acpSessionId);
	if (reusingLoadedSession) incrementPerfCounter("runtime.connect_and_load.reused_session");
	else await withTimeout(client.start(), options.timeoutMs);
	options.onClientAvailable?.(options.activeController);
	applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
	record.closed = false;
	record.closedAt = void 0;
	options.onConnectedRecord?.(record);
	let resumed = false;
	let loadError;
	let sessionId = record.acpSessionId;
	let createdFreshSession = false;
	let pendingAgentSessionId = record.agentSessionId;
	let sessionModels;
	if (reusingLoadedSession) resumed = true;
	else if (client.supportsLoadSession()) try {
		const loadResult = await withTimeout(client.loadSessionWithOptions(record.acpSessionId, record.cwd, { suppressReplayUpdates: true }), options.timeoutMs);
		reconcileAgentSessionId(record, loadResult.agentSessionId);
		applyConfigOptionsToRecord(record, loadResult);
		sessionModels = loadResult.models;
		resumed = true;
	} catch (error) {
		loadError = formatErrorMessage(error);
		if (sameSessionOnly) throw makeSessionResumeRequiredError({
			record,
			reason: loadError,
			cause: error
		});
		if (!shouldFallbackToNewSession(error, record)) throw error;
		const createdSession = await withTimeout(client.createSession(record.cwd), options.timeoutMs);
		sessionId = createdSession.sessionId;
		createdFreshSession = true;
		pendingAgentSessionId = createdSession.agentSessionId;
		applyConfigOptionsToRecord(record, createdSession);
		sessionModels = createdSession.models;
	}
	else {
		if (sameSessionOnly) throw makeSessionResumeRequiredError({
			record,
			reason: "agent does not support session/load"
		});
		const createdSession = await withTimeout(client.createSession(record.cwd), options.timeoutMs);
		sessionId = createdSession.sessionId;
		createdFreshSession = true;
		pendingAgentSessionId = createdSession.agentSessionId;
		applyConfigOptionsToRecord(record, createdSession);
		sessionModels = createdSession.models;
	}
	if (createdFreshSession) {
		try {
			await replayDesiredMode({
				client,
				sessionId,
				desiredModeId,
				previousSessionId: originalSessionId,
				timeoutMs: options.timeoutMs,
				verbose: options.verbose
			});
			await replayDesiredModel({
				client,
				sessionId,
				desiredModelId,
				previousSessionId: originalSessionId,
				record,
				models: sessionModels,
				timeoutMs: options.timeoutMs,
				verbose: options.verbose
			});
			await replayDesiredConfigOptions({
				client,
				sessionId,
				desiredConfigOptions,
				previousSessionId: originalSessionId,
				timeoutMs: options.timeoutMs,
				verbose: options.verbose
			});
		} catch (error) {
			restoreOriginalSessionState({
				record,
				sessionId: originalSessionId,
				agentSessionId: originalAgentSessionId
			});
			if (options.verbose) process.stderr.write(`[acpx] ${formatErrorMessage(error)}\n`);
			throw error;
		}
		record.acpSessionId = sessionId;
		reconcileAgentSessionId(record, pendingAgentSessionId);
	}
	syncAdvertisedModelState(record, sessionModels);
	if (createdFreshSession && desiredModelId && sessionModels) setCurrentModelId(record, desiredModelId);
	options.onSessionIdResolved?.(sessionId);
	return {
		sessionId,
		agentSessionId: record.agentSessionId,
		resumed,
		loadError
	};
}
function createActiveSessionController(params) {
	const getActiveSessionId = () => params.getActiveSessionId();
	return {
		hasActivePrompt: () => params.client.hasActivePrompt(),
		requestCancelActivePrompt: async () => await params.client.requestCancelActivePrompt(),
		setSessionMode: async (modeId) => {
			await params.client.setSessionMode(getActiveSessionId(), modeId);
		},
		setSessionModel: async (modelId) => {
			await params.client.setSessionModel(getActiveSessionId(), modelId);
		},
		setSessionConfigOption: async (configId, value) => {
			return await params.client.setSessionConfigOption(getActiveSessionId(), configId, value);
		}
	};
}
async function withConnectedSession(options) {
	const record = await options.loadRecord(options.sessionRecordId);
	const client = options.createClient?.({
		agentCommand: record.agentCommand,
		cwd: absolutePath(record.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode ?? "approve-reads",
		nonInteractivePermissions: options.nonInteractivePermissions,
		onPermissionRequest: options.onPermissionRequest,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		terminal: options.terminal,
		verbose: options.verbose,
		sessionOptions: sessionOptionsFromRecord(record)
	}) ?? new AcpClient({
		agentCommand: record.agentCommand,
		cwd: absolutePath(record.cwd),
		mcpServers: options.mcpServers,
		permissionMode: options.permissionMode ?? "approve-reads",
		nonInteractivePermissions: options.nonInteractivePermissions,
		onPermissionRequest: options.onPermissionRequest,
		authCredentials: options.authCredentials,
		authPolicy: options.authPolicy,
		terminal: options.terminal,
		verbose: options.verbose,
		sessionOptions: sessionOptionsFromRecord(record)
	});
	let activeSessionIdForControl = record.acpSessionId;
	let notifiedClientAvailable = false;
	const activeController = createActiveSessionController({
		client,
		getActiveSessionId: () => activeSessionIdForControl
	});
	try {
		return await withInterrupt(async () => {
			const { sessionId, resumed, loadError } = await connectAndLoadSession({
				client,
				record,
				resumePolicy: options.resumePolicy,
				timeoutMs: options.timeoutMs,
				verbose: options.verbose,
				activeController,
				onClientAvailable: (controller) => {
					options.onClientAvailable?.(controller);
					notifiedClientAvailable = true;
				},
				onConnectedRecord: options.onConnectedRecord,
				onSessionIdResolved: (sessionIdValue) => {
					activeSessionIdForControl = sessionIdValue;
				}
			});
			const value = await options.run({
				record,
				client,
				activeController,
				sessionId,
				resumed,
				loadError
			});
			record.lastUsedAt = isoNow$2();
			record.closed = false;
			record.closedAt = void 0;
			record.protocolVersion = client.initializeResult?.protocolVersion;
			record.agentCapabilities = client.initializeResult?.agentCapabilities;
			applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
			await options.saveRecord(record);
			return {
				value,
				record,
				resumed,
				loadError
			};
		}, async () => {
			if (options.onInterrupt) await options.onInterrupt({
				client,
				record
			});
			else await client.cancelActivePrompt(2500);
			applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
			record.lastUsedAt = isoNow$2();
			await options.saveRecord(record).catch(() => {});
			await client.close();
		});
	} finally {
		if (notifiedClientAvailable) options.onClientClosed?.();
		await client.close();
		applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
		await options.saveRecord(record).catch(() => {});
	}
}
const SESSION_REPLY_IDLE_MS = 1e3;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5e3;
async function runPromptTurn(params) {
	try {
		const promptPromise = params.client.prompt(params.sessionId, params.prompt);
		await params.onPromptStarted?.();
		const response = await withTimeout(promptPromise, params.timeoutMs);
		await params.client.waitForSessionUpdatesIdle?.({
			idleMs: SESSION_REPLY_IDLE_MS,
			timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS
		}).catch(() => {});
		return {
			stopReason: response.stopReason,
			source: "rpc"
		};
	} catch (error) {
		if (!(error instanceof TimeoutError) || !params.promptMessageId) throw error;
		await params.client.waitForSessionUpdatesIdle?.({
			idleMs: SESSION_REPLY_IDLE_MS,
			timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS
		}).catch(() => {});
		if (hasAgentReplyAfterPrompt(params.conversation, params.promptMessageId)) return {
			stopReason: "end_turn",
			source: "session"
		};
		throw error;
	}
}
const DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS = 500;
var LiveSessionCheckpoint = class {
	save;
	intervalMs;
	onError;
	dirty = false;
	flushing;
	timer;
	constructor(options) {
		this.save = options.save;
		this.intervalMs = options.intervalMs ?? DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS;
		this.onError = options.onError;
	}
	request() {
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.flush().catch((error) => {
				this.onError?.(error);
			});
		}, this.intervalMs);
		this.timer.unref?.();
	}
	async checkpoint() {
		this.dirty = true;
		await this.flush();
	}
	async flush() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		if (this.flushing) {
			await this.flushing;
			if (!this.dirty) return;
		}
		this.flushing = this.flushDirty();
		try {
			await this.flushing;
		} finally {
			this.flushing = void 0;
		}
	}
	async flushDirty() {
		while (this.dirty) {
			this.dirty = false;
			await this.save();
		}
	}
};
//#endregion
//#region node_modules/acpx/dist/runtime.js
var AcpRuntimeError = class extends Error {
	code;
	cause;
	constructor(code, message, options) {
		super(message);
		this.name = "AcpRuntimeError";
		this.code = code;
		this.cause = options?.cause;
	}
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asTrimmedString(value) {
	return typeof value === "string" ? value.trim() : "";
}
function asString(value) {
	return typeof value === "string" ? value : void 0;
}
function asOptionalString(value) {
	return asTrimmedString(value) || void 0;
}
function deriveAgentFromSessionKey(sessionKey, fallbackAgent) {
	const match = sessionKey.match(/^agent:([^:]+):/i);
	return (match?.[1] ? asTrimmedString(match[1]) : "") || fallbackAgent;
}
const TOOL_OUTPUT_SUMMARY_MAX_CHARS = 500;
function safeParseJsonObject(line) {
	try {
		const parsed = JSON.parse(line);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
function asOptionalFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function resolveStructuredPromptPayload(parsed) {
	if (asTrimmedString(parsed.method) === "session/update") {
		const params = parsed.params;
		if (isRecord(params) && isRecord(params.update)) {
			const update = params.update;
			const tag = asOptionalString(update.sessionUpdate);
			return {
				type: tag ?? "",
				payload: update,
				...tag ? { tag } : {}
			};
		}
	}
	const sessionUpdate = asOptionalString(parsed.sessionUpdate);
	if (sessionUpdate) return {
		type: sessionUpdate,
		payload: parsed,
		tag: sessionUpdate
	};
	const type = asTrimmedString(parsed.type);
	const tag = asOptionalString(parsed.tag);
	return {
		type,
		payload: parsed,
		...tag ? { tag } : {}
	};
}
function resolveStatusTextForTag(params) {
	const { tag, payload } = params;
	if (tag === "available_commands_update") {
		const commands = Array.isArray(payload.availableCommands) ? payload.availableCommands : [];
		return commands.length > 0 ? `available commands updated (${commands.length})` : "available commands updated";
	}
	if (tag === "current_mode_update") {
		const mode = asTrimmedString(payload.currentModeId) || asTrimmedString(payload.modeId) || asTrimmedString(payload.mode);
		return mode ? `mode updated: ${mode}` : "mode updated";
	}
	if (tag === "config_option_update") {
		const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
		const value = asTrimmedString(payload.currentValue) || asTrimmedString(payload.value) || asTrimmedString(payload.optionValue);
		if (id && value) return `config updated: ${id}=${value}`;
		if (id) return `config updated: ${id}`;
		return "config updated";
	}
	if (tag === "session_info_update") return asTrimmedString(payload.summary) || asTrimmedString(payload.message) || "session updated";
	if (tag === "plan") {
		const content = asTrimmedString((Array.isArray(payload.entries) ? payload.entries : []).find((entry) => isRecord(entry))?.content);
		return content ? `plan: ${content}` : null;
	}
	return null;
}
function resolveTextChunk(params) {
	const contentRaw = params.payload.content;
	if (isRecord(contentRaw)) {
		const contentType = asTrimmedString(contentRaw.type);
		if (contentType && contentType !== "text") return null;
		const text = asString(contentRaw.text);
		if (text && text.length > 0) return {
			type: "text_delta",
			text,
			stream: params.stream,
			tag: params.tag
		};
	}
	const text = asString(params.payload.text);
	if (!text || text.length === 0) return null;
	return {
		type: "text_delta",
		text,
		stream: params.stream,
		tag: params.tag
	};
}
function createTextDeltaEvent(params) {
	if (params.content == null || params.content.length === 0) return null;
	return {
		type: "text_delta",
		text: params.content,
		stream: params.stream,
		...params.tag ? { tag: params.tag } : {}
	};
}
function readFirstString(record, keys) {
	for (const key of keys) {
		const value = asOptionalString(record[key]);
		if (value) return value;
	}
}
function readFirstStringArray(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (!Array.isArray(value)) continue;
		const entries = value.map((entry) => asOptionalString(entry)).filter((entry) => entry !== void 0);
		if (entries.length > 0) return entries;
	}
}
function summarizeToolInput(rawInput) {
	if (rawInput == null) return;
	if (typeof rawInput === "string" || typeof rawInput === "number" || typeof rawInput === "boolean") return String(rawInput);
	if (!isRecord(rawInput)) return;
	const command = readFirstString(rawInput, [
		"command",
		"cmd",
		"program"
	]);
	const args = readFirstStringArray(rawInput, ["args", "arguments"]);
	if (command) return [command, ...args ?? []].join(" ");
	return readFirstString(rawInput, [
		"path",
		"file",
		"filePath",
		"filepath",
		"target",
		"uri",
		"url",
		"query",
		"pattern",
		"text",
		"search"
	]);
}
function truncateToolSummary(value) {
	if (value.length <= TOOL_OUTPUT_SUMMARY_MAX_CHARS) return value;
	return `${value.slice(0, TOOL_OUTPUT_SUMMARY_MAX_CHARS - 1)}…`;
}
function readToolContentText(value) {
	const record = isRecord(value) ? value : void 0;
	if (!record) return;
	if (record.type === "content") return readToolContentText(record.content);
	if (record.type === "text") return asString(record.text);
	if (record.type === "resource_link") return asOptionalString(record.title) || asOptionalString(record.name) || asOptionalString(record.uri);
	if (record.type === "resource") {
		const resource = isRecord(record.resource) ? record.resource : void 0;
		return asString(resource?.text) || asOptionalString(resource?.uri);
	}
	if (record.type === "diff") return `diff ${asOptionalString(record.path) || "file"}`;
	if (record.type === "terminal") {
		const terminalId = asOptionalString(record.terminalId) || asOptionalString(record.id);
		return terminalId ? `[terminal] ${terminalId}` : "[terminal]";
	}
}
function summarizeToolContent(content) {
	if (!Array.isArray(content)) return;
	const fragments = content.map((entry) => readToolContentText(entry)?.trim()).filter((entry) => Boolean(entry));
	if (fragments.length === 0) return;
	return truncateToolSummary([...new Set(fragments)].join("\n"));
}
function summarizeToolOutput(rawOutput) {
	if (rawOutput == null) return;
	if (typeof rawOutput === "string" || typeof rawOutput === "number" || typeof rawOutput === "boolean") return truncateToolSummary(String(rawOutput));
	const record = isRecord(rawOutput) ? rawOutput : void 0;
	if (!record) return;
	return truncateToolSummary(readFirstString(record, [
		"text",
		"message",
		"error",
		"stdout",
		"stderr",
		"content"
	]) ?? "") || void 0;
}
function shouldForwardArray(value) {
	return Array.isArray(value);
}
function readToolKind(value) {
	const kind = asOptionalString(value);
	if (kind === "read" || kind === "edit" || kind === "delete" || kind === "move" || kind === "search" || kind === "execute" || kind === "fetch" || kind === "think" || kind === "other") return kind;
}
function createToolCallEvent(params) {
	const title = asTrimmedString(params.payload.title) || "tool call";
	const status = asTrimmedString(params.payload.status);
	const inputSummary = summarizeToolInput(params.payload.rawInput);
	const outputSummary = summarizeToolContent(params.payload.content) ?? summarizeToolOutput(params.payload.rawOutput);
	const toolCallId = asOptionalString(params.payload.toolCallId);
	const kind = readToolKind(params.payload.kind);
	const summaryText = status ? `${title} (${status})` : title;
	const detailSummary = params.tag === "tool_call_update" ? outputSummary ?? inputSummary : inputSummary ?? outputSummary;
	return {
		type: "tool_call",
		text: detailSummary ? `${summaryText}: ${detailSummary}` : summaryText,
		tag: params.tag,
		...toolCallId ? { toolCallId } : {},
		...status ? { status } : {},
		...kind ? { kind } : {},
		...shouldForwardArray(params.payload.locations) ? { locations: params.payload.locations } : {},
		...Object.prototype.hasOwnProperty.call(params.payload, "rawInput") ? { rawInput: params.payload.rawInput } : {},
		...Object.prototype.hasOwnProperty.call(params.payload, "rawOutput") ? { rawOutput: params.payload.rawOutput } : {},
		...shouldForwardArray(params.payload.content) ? { content: params.payload.content } : {},
		title
	};
}
function parsePromptEventLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	const parsed = safeParseJsonObject(trimmed);
	if (!parsed) return {
		type: "status",
		text: trimmed
	};
	const structured = resolveStructuredPromptPayload(parsed);
	const type = structured.type;
	const payload = structured.payload;
	const tag = structured.tag;
	switch (type) {
		case "text": return createTextDeltaEvent({
			content: asString(payload.content),
			stream: "output",
			tag
		});
		case "thought": return createTextDeltaEvent({
			content: asString(payload.content),
			stream: "thought",
			tag
		});
		case "tool_call": return createToolCallEvent({
			payload,
			tag: tag ?? "tool_call"
		});
		case "tool_call_update": return createToolCallEvent({
			payload,
			tag: tag ?? "tool_call_update"
		});
		case "agent_message_chunk": return resolveTextChunk({
			payload,
			stream: "output",
			tag: "agent_message_chunk"
		});
		case "agent_thought_chunk": return resolveTextChunk({
			payload,
			stream: "thought",
			tag: "agent_thought_chunk"
		});
		case "usage_update": {
			const used = asOptionalFiniteNumber(payload.used);
			const size = asOptionalFiniteNumber(payload.size);
			return {
				type: "status",
				text: used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated",
				tag: "usage_update",
				...used != null ? { used } : {},
				...size != null ? { size } : {}
			};
		}
		case "available_commands_update":
		case "current_mode_update":
		case "config_option_update":
		case "session_info_update":
		case "plan": {
			const text = resolveStatusTextForTag({
				tag: type,
				payload
			});
			if (!text) return null;
			return {
				type: "status",
				text,
				tag: type
			};
		}
		case "client_operation": {
			const text = [
				asTrimmedString(payload.method) || "operation",
				asTrimmedString(payload.status),
				asTrimmedString(payload.summary)
			].filter(Boolean).join(" ");
			if (!text) return null;
			return {
				type: "status",
				text,
				...tag ? { tag } : {}
			};
		}
		case "update": {
			const update = asTrimmedString(payload.update);
			if (!update) return null;
			return {
				type: "status",
				text: update,
				...tag ? { tag } : {}
			};
		}
		case "done":
		case "error": return null;
		default: return null;
	}
}
function shouldReuseExistingRecord(record, params) {
	if (record.acpx?.reset_on_next_ensure === true) return false;
	if (path.resolve(record.cwd) !== path.resolve(params.cwd)) return false;
	if (record.agentCommand !== params.agentCommand) return false;
	if (params.resumeSessionId && record.acpSessionId !== params.resumeSessionId) return false;
	return true;
}
function createDeferred() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
var AsyncEventQueue = class {
	items = [];
	waits = [];
	closed = false;
	push(item) {
		if (this.closed) return;
		const waiter = this.waits.shift();
		if (waiter) {
			waiter.resolve(item);
			return;
		}
		this.items.push(item);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waits.splice(0)) waiter.resolve(null);
	}
	clear() {
		this.items.length = 0;
	}
	async next() {
		if (this.items.length > 0) return this.items.shift() ?? null;
		if (this.closed) return null;
		const waiter = createDeferred();
		this.waits.push(waiter);
		return await waiter.promise;
	}
	async *iterate() {
		while (true) {
			const next = await this.next();
			if (!next) return;
			yield next;
		}
	}
};
function isoNow() {
	return (/* @__PURE__ */ new Date()).toISOString();
}
function isUnsupportedSessionCloseError(error) {
	const acp = extractAcpError(error);
	if (!acp) return false;
	if (acp.code === -32601 || acp.code === -32602) return true;
	if (acp.code !== -32603 || !acp.data || typeof acp.data !== "object") return false;
	const details = acp.data.details;
	return typeof details === "string" && details.toLowerCase().includes("invalid params");
}
function toPromptInput(text, attachments) {
	if (!attachments || attachments.length === 0) return text;
	const blocks = [];
	if (text) blocks.push({
		type: "text",
		text
	});
	for (const attachment of attachments) {
		if (!attachment.mediaType.startsWith("image/")) throw new AcpRuntimeError("ACP_TURN_FAILED", `Unsupported ACP runtime attachment media type: ${attachment.mediaType}`);
		blocks.push({
			type: "image",
			mimeType: attachment.mediaType,
			data: attachment.data
		});
	}
	return blocks.length > 0 ? blocks : textPrompt(text);
}
function createInitialRecord(params) {
	const now = isoNow();
	return {
		schema: "acpx.session.v1",
		acpxRecordId: params.recordId,
		acpSessionId: params.sessionId,
		agentSessionId: params.agentSessionId,
		agentCommand: params.agentCommand,
		cwd: params.cwd,
		name: params.sessionName,
		createdAt: now,
		lastUsedAt: now,
		lastSeq: 0,
		eventLog: defaultSessionEventLog(params.recordId),
		closed: false,
		closedAt: void 0,
		...createSessionConversation(now),
		acpx: {}
	};
}
function createRecordId(sessionKey, mode) {
	if (mode === "persistent") return sessionKey;
	return `${sessionKey}:oneshot:${randomUUID()}`;
}
function resumePolicyForSessionMode(mode) {
	return mode === "persistent" ? "same-session-only" : "allow-new";
}
function legacyTerminalEventFromTurnResult(result) {
	if (result.status === "failed") return {
		type: "error",
		message: result.error.message,
		...result.error.code ? { code: result.error.code } : {},
		...result.error.detailCode ? { detailCode: result.error.detailCode } : {},
		...result.error.retryable === void 0 ? {} : { retryable: result.error.retryable }
	};
	return {
		type: "done",
		...result.stopReason ? { stopReason: result.stopReason } : {}
	};
}
function statusSummary(record) {
	return [
		`session=${record.acpxRecordId}`,
		`backendSessionId=${record.acpSessionId}`,
		record.agentSessionId ? `agentSessionId=${record.agentSessionId}` : null,
		record.pid != null ? `pid=${record.pid}` : null,
		record.closed ? "closed" : "open"
	].filter(Boolean).join(" ");
}
function buildModelsField(record) {
	const available = record.acpx?.available_models;
	const currentModelId = record.acpx?.current_model_id;
	if (!available || available.length === 0) return currentModelId === void 0 ? {} : { models: {
		currentModelId,
		availableModelIds: []
	} };
	return { models: {
		...currentModelId !== void 0 ? { currentModelId } : {},
		availableModelIds: [...available]
	} };
}
function advertisedConfigOptionIds(record) {
	const configOptions = record.acpx?.config_options;
	if (!configOptions) return;
	return new Set(configOptions.map((option) => option.id).filter((id) => typeof id === "string" && id.trim().length > 0));
}
function resolveSupportedConfigOptionId(record, configId) {
	const advertisedIds = advertisedConfigOptionIds(record);
	if (!advertisedIds) return configId;
	if (advertisedIds.has(configId)) return configId;
	if (configId === "thinking" && advertisedIds.has("effort")) return "effort";
	const supported = [...advertisedIds].toSorted();
	const supportedText = supported.length > 0 ? supported.join(", ") : "none";
	throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `ACP session ${record.acpxRecordId} does not advertise config option '${configId}'. Supported config options: ${supportedText}.`);
}
var AcpRuntimeManager = class {
	options;
	deps;
	activeControllers = /* @__PURE__ */ new Map();
	pendingPersistentClients = /* @__PURE__ */ new Map();
	closingActiveRecords = /* @__PURE__ */ new Set();
	constructor(options, deps = {}) {
		this.options = options;
		this.deps = deps;
	}
	createClient(options) {
		return this.deps.clientFactory?.(options) ?? new AcpClient(options);
	}
	async readPendingPersistentClient(record, options) {
		const pendingClient = this.pendingPersistentClients.get(record.acpxRecordId);
		if (!pendingClient) return;
		if (!pendingClient.hasReusableSession(record.acpSessionId)) {
			this.pendingPersistentClients.delete(record.acpxRecordId);
			await pendingClient.close().catch(() => {});
			return;
		}
		if (options.consume) this.pendingPersistentClients.delete(record.acpxRecordId);
		return pendingClient;
	}
	async closePendingPersistentClient(recordId) {
		const pendingClient = this.pendingPersistentClients.get(recordId);
		if (!pendingClient) return;
		this.pendingPersistentClients.delete(recordId);
		await pendingClient.close().catch(() => {});
	}
	async refreshClosedState(record) {
		if (!this.closingActiveRecords.has(record.acpxRecordId)) return record.closed === true;
		const latest = await this.options.sessionStore.load(record.acpxRecordId).catch(() => void 0);
		record.closed = true;
		record.closedAt = latest?.closedAt ?? record.closedAt ?? isoNow();
		if (latest?.acpx) record.acpx = {
			...record.acpx,
			...latest.acpx
		};
		return true;
	}
	async retainPersistentClientAfterTurn(input) {
		const { record, client } = input;
		if (!!record.acpxRecordId.includes(":oneshot:") || record.closed || !client.hasReusableSession(record.acpSessionId)) return false;
		const previousClient = this.pendingPersistentClients.get(record.acpxRecordId);
		this.pendingPersistentClients.set(record.acpxRecordId, client);
		if (previousClient && previousClient !== client) await previousClient.close().catch(() => {});
		return true;
	}
	async withRuntimeControlSession(record, sessionMode, run) {
		const pendingClient = await this.readPendingPersistentClient(record, { consume: false });
		if (pendingClient) {
			const value = await run({
				client: pendingClient,
				sessionId: record.acpSessionId,
				record
			});
			record.lastUsedAt = isoNow();
			record.closed = false;
			record.closedAt = void 0;
			record.protocolVersion = pendingClient.initializeResult?.protocolVersion;
			record.agentCapabilities = pendingClient.initializeResult?.agentCapabilities;
			applyLifecycleSnapshotToRecord(record, pendingClient.getAgentLifecycleSnapshot());
			return {
				value,
				record
			};
		}
		const result = await withConnectedSession({
			sessionRecordId: record.acpxRecordId,
			loadRecord: async (sessionRecordId) => await this.requireRecord(sessionRecordId),
			saveRecord: async (connectedRecord) => await this.options.sessionStore.save(connectedRecord),
			createClient: (options) => this.createClient(options),
			mcpServers: [...this.options.mcpServers ?? []],
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onPermissionRequest: this.options.onPermissionRequest,
			verbose: this.options.verbose,
			timeoutMs: this.options.timeoutMs,
			resumePolicy: resumePolicyForSessionMode(sessionMode),
			run
		});
		return {
			value: result.value,
			record: result.record
		};
	}
	async ensureSession(input) {
		const cwd = path.resolve(input.cwd?.trim() || this.options.cwd);
		const agentCommand = this.options.agentRegistry.resolve(input.agent);
		const existing = await this.options.sessionStore.load(input.sessionKey);
		if (input.mode === "persistent" && existing && shouldReuseExistingRecord(existing, {
			cwd,
			agentCommand,
			resumeSessionId: input.resumeSessionId
		})) {
			existing.closed = false;
			existing.closedAt = void 0;
			this.closingActiveRecords.delete(existing.acpxRecordId);
			await this.options.sessionStore.save(existing);
			return existing;
		}
		const client = this.createClient({
			agentCommand,
			cwd,
			mcpServers: [...this.options.mcpServers ?? []],
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onPermissionRequest: this.options.onPermissionRequest,
			verbose: this.options.verbose,
			sessionOptions: input.sessionOptions
		});
		let keepClientOpen = false;
		try {
			await client.start();
			let sessionId;
			let agentSessionId;
			let sessionResult;
			if (input.resumeSessionId) {
				const loaded = await client.loadSession(input.resumeSessionId, cwd);
				sessionId = input.resumeSessionId;
				agentSessionId = loaded.agentSessionId;
				sessionResult = loaded;
			} else {
				const created = await client.createSession(cwd);
				sessionId = created.sessionId;
				agentSessionId = created.agentSessionId;
				sessionResult = created;
			}
			const record = createInitialRecord({
				recordId: createRecordId(input.sessionKey, input.mode),
				sessionName: input.sessionKey,
				sessionId,
				agentCommand,
				cwd,
				agentSessionId
			});
			this.closingActiveRecords.delete(record.acpxRecordId);
			record.protocolVersion = client.initializeResult?.protocolVersion;
			record.agentCapabilities = client.initializeResult?.agentCapabilities;
			applyConfigOptionsToRecord(record, sessionResult);
			const requestedModelApplied = await applyRequestedModelIfAdvertised({
				client,
				sessionId,
				requestedModel: input.sessionOptions?.model,
				models: sessionResult.models,
				agentCommand,
				timeoutMs: this.options.timeoutMs
			});
			syncAdvertisedModelState(record, sessionResult.models);
			if (requestedModelApplied) setCurrentModelId(record, input.sessionOptions?.model);
			applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
			persistSessionOptions(record, input.sessionOptions);
			await this.options.sessionStore.save(record);
			if (input.mode === "persistent") {
				const previousClient = this.pendingPersistentClients.get(record.acpxRecordId);
				this.pendingPersistentClients.set(record.acpxRecordId, client);
				keepClientOpen = true;
				await previousClient?.close().catch(() => {});
			}
			return record;
		} finally {
			if (!keepClientOpen) await client.close();
		}
	}
	startTurn(input) {
		const promptInput = toPromptInput(input.text, input.attachments);
		const queue = new AsyncEventQueue();
		const result = createDeferred();
		const sessionReady = createDeferred();
		sessionReady.promise.catch(() => {});
		let resultSettled = false;
		let pendingCancel = false;
		let turnActive = true;
		let streamClosed = false;
		let activeController = null;
		const settleResult = (next) => {
			if (resultSettled) return;
			resultSettled = true;
			result.resolve(next);
		};
		const closeStream = () => {
			if (streamClosed) return;
			streamClosed = true;
			queue.clear();
			queue.close();
		};
		const requestCancel = async () => {
			if (activeController) return await activeController.requestCancelActivePrompt();
			if (!turnActive) return false;
			pendingCancel = true;
			return true;
		};
		const abortHandler = () => {
			requestCancel();
		};
		if (input.signal) {
			if (input.signal.aborted) {
				closeStream();
				settleResult({
					status: "cancelled",
					stopReason: "cancelled"
				});
				return {
					requestId: input.requestId,
					events: queue.iterate(),
					result: result.promise,
					cancel: async () => {},
					closeStream: async () => {}
				};
			}
			input.signal.addEventListener("abort", abortHandler, { once: true });
		}
		(async () => {
			let record = null;
			let conversation = null;
			let acpxState;
			let liveCheckpoint;
			let client = null;
			try {
				record = await this.requireRecord(input.handle.acpxRecordId ?? input.handle.sessionKey);
				conversation = cloneSessionConversation(record);
				acpxState = cloneSessionAcpxState(record.acpx);
				const promptStartedAt = isoNow();
				const promptMessageId = recordPromptSubmission(conversation, promptInput, promptStartedAt);
				trimConversationForRuntime(conversation);
				record.lastPromptAt = promptStartedAt;
				record.lastUsedAt = promptStartedAt;
				record.acpx = acpxState;
				applyConversation(record, conversation);
				await this.options.sessionStore.save(record);
				const pendingClient = await this.readPendingPersistentClient(record, { consume: true });
				client = pendingClient ?? this.createClient({
					agentCommand: record.agentCommand,
					cwd: record.cwd,
					mcpServers: [...this.options.mcpServers ?? []],
					permissionMode: this.options.permissionMode,
					nonInteractivePermissions: this.options.nonInteractivePermissions,
					onPermissionRequest: this.options.onPermissionRequest,
					verbose: this.options.verbose
				});
				const runtimeClient = client;
				const runtimeConversation = conversation;
				const runtimeRecord = record;
				liveCheckpoint = new LiveSessionCheckpoint({ save: async () => {
					runtimeRecord.lastUsedAt = isoNow();
					runtimeRecord.acpx = acpxState;
					applyConversation(runtimeRecord, runtimeConversation);
					await this.refreshClosedState(runtimeRecord);
					await this.options.sessionStore.save(runtimeRecord);
				} });
				let activeSessionId = record.acpSessionId;
				const applyPendingCancel = async () => {
					if (!pendingCancel || !runtimeClient.hasActivePrompt()) return false;
					const cancelled = await runtimeClient.requestCancelActivePrompt();
					if (cancelled) pendingCancel = false;
					return cancelled;
				};
				activeController = {
					hasActivePrompt: () => runtimeClient.hasActivePrompt(),
					requestCancelActivePrompt: async () => {
						if (runtimeClient.hasActivePrompt()) return await runtimeClient.requestCancelActivePrompt();
						if (!turnActive) return false;
						pendingCancel = true;
						return true;
					},
					setSessionMode: async (modeId) => {
						if (!runtimeClient.hasActivePrompt()) await sessionReady.promise;
						await runtimeClient.setSessionMode(activeSessionId, modeId);
						const nextState = cloneSessionAcpxState(acpxState) ?? {};
						nextState.desired_mode_id = modeId;
						acpxState = nextState;
					},
					setSessionModel: async (modelId) => {
						if (!runtimeClient.hasActivePrompt()) await sessionReady.promise;
						await runtimeClient.setSessionModel(activeSessionId, modelId);
					},
					setSessionConfigOption: async (configId, value) => {
						return (await activeController.setResolvedSessionConfigOption(configId, value)).response;
					},
					setResolvedSessionConfigOption: async (configId, value) => {
						if (!runtimeClient.hasActivePrompt()) await sessionReady.promise;
						const resolvedConfigId = resolveSupportedConfigOptionId({
							...runtimeRecord,
							acpx: acpxState ?? void 0
						}, configId);
						const response = await runtimeClient.setSessionConfigOption(activeSessionId, resolvedConfigId, value);
						if (response?.configOptions) {
							const nextState = cloneSessionAcpxState(acpxState) ?? {};
							nextState.config_options = structuredClone(response.configOptions);
							acpxState = nextState;
						}
						if (resolvedConfigId === "mode") {
							const nextState = cloneSessionAcpxState(acpxState) ?? {};
							nextState.desired_mode_id = value;
							acpxState = nextState;
						} else if (resolvedConfigId !== "model") {
							const nextState = cloneSessionAcpxState(acpxState) ?? {};
							nextState.desired_config_options = {
								...nextState.desired_config_options,
								[resolvedConfigId]: value
							};
							acpxState = nextState;
						}
						return {
							configId: resolvedConfigId,
							response
						};
					}
				};
				const emitParsed = (payload) => {
					if (streamClosed) return;
					const parsed = parsePromptEventLine(JSON.stringify(payload));
					if (!parsed) return;
					queue.push(parsed);
				};
				this.activeControllers.set(runtimeRecord.acpxRecordId, activeController);
				runtimeClient.setEventHandlers({
					onSessionUpdate: (notification) => {
						acpxState = recordSessionUpdate(runtimeConversation, acpxState, notification);
						trimConversationForRuntime(runtimeConversation);
						liveCheckpoint?.request();
						emitParsed({
							jsonrpc: "2.0",
							method: "session/update",
							params: notification
						});
					},
					onClientOperation: (operation) => {
						acpxState = recordClientOperation(runtimeConversation, acpxState, operation);
						trimConversationForRuntime(runtimeConversation);
						liveCheckpoint?.request();
						emitParsed({
							type: "client_operation",
							...operation
						});
					}
				});
				const { sessionId, resumed, loadError } = pendingClient ? {
					sessionId: record.acpSessionId,
					resumed: false,
					loadError: void 0
				} : await connectAndLoadSession({
					client: runtimeClient,
					record: runtimeRecord,
					resumePolicy: resumePolicyForSessionMode(input.sessionMode),
					timeoutMs: this.options.timeoutMs,
					activeController,
					onClientAvailable: () => {
						if (activeController) this.activeControllers.set(runtimeRecord.acpxRecordId, activeController);
					},
					onConnectedRecord: (connectedRecord) => {
						connectedRecord.lastPromptAt = isoNow();
					},
					onSessionIdResolved: (sessionIdValue) => {
						activeSessionId = sessionIdValue;
					}
				});
				acpxState = cloneSessionAcpxState(runtimeRecord.acpx);
				sessionReady.resolve();
				runtimeRecord.lastRequestId = input.requestId;
				runtimeRecord.lastPromptAt = isoNow();
				runtimeRecord.closed = false;
				runtimeRecord.closedAt = void 0;
				runtimeRecord.lastUsedAt = isoNow();
				await liveCheckpoint.checkpoint();
				if (resumed || loadError) emitParsed({
					type: "status",
					text: loadError ? `load fallback: ${loadError}` : "session resumed"
				});
				if (pendingCancel || input.signal?.aborted) {
					pendingCancel = false;
					settleResult({
						status: "cancelled",
						stopReason: "cancelled"
					});
					return;
				}
				await applyPendingCancel();
				const response = await runPromptTurn({
					client: runtimeClient,
					sessionId,
					prompt: promptInput,
					timeoutMs: input.timeoutMs ?? this.options.timeoutMs,
					conversation: runtimeConversation,
					promptMessageId
				});
				runtimeRecord.acpSessionId = activeSessionId;
				reconcileAgentSessionId(runtimeRecord, runtimeRecord.agentSessionId);
				runtimeRecord.protocolVersion = runtimeClient.initializeResult?.protocolVersion;
				runtimeRecord.agentCapabilities = runtimeClient.initializeResult?.agentCapabilities;
				runtimeRecord.acpx = acpxState;
				applyConversation(runtimeRecord, runtimeConversation);
				applyLifecycleSnapshotToRecord(runtimeRecord, runtimeClient.getAgentLifecycleSnapshot());
				await this.options.sessionStore.save(runtimeRecord);
				settleResult({
					status: response.stopReason === "cancelled" ? "cancelled" : "completed",
					...response.stopReason ? { stopReason: response.stopReason } : {}
				});
			} catch (error) {
				sessionReady.reject(error);
				const normalized = normalizeOutputError(error, { origin: "runtime" });
				settleResult({
					status: "failed",
					error: {
						message: normalized.message,
						...normalized.code ? { code: normalized.code } : {},
						...normalized.detailCode ? { detailCode: normalized.detailCode } : {},
						...normalized.retryable !== void 0 ? { retryable: normalized.retryable } : {}
					}
				});
			} finally {
				turnActive = false;
				if (input.signal) input.signal.removeEventListener("abort", abortHandler);
				client?.clearEventHandlers();
				let pooled = false;
				if (record && conversation) {
					applyLifecycleSnapshotToRecord(record, client?.getAgentLifecycleSnapshot() ?? { running: false });
					record.acpx = acpxState;
					applyConversation(record, conversation);
					record.lastUsedAt = isoNow();
					await liveCheckpoint?.flush().catch(() => {});
					const closed = await this.refreshClosedState(record);
					await this.options.sessionStore.save(record).catch(() => {});
					if (!closed && client) pooled = await this.retainPersistentClientAfterTurn({
						record,
						client
					});
				}
				if (!pooled) await client?.close().catch(() => {});
				if (record) {
					this.activeControllers.delete(record.acpxRecordId);
					this.closingActiveRecords.delete(record.acpxRecordId);
				}
				queue.close();
			}
		})();
		return {
			requestId: input.requestId,
			events: queue.iterate(),
			result: result.promise,
			cancel: async () => {
				await requestCancel();
			},
			closeStream: async () => {
				closeStream();
			}
		};
	}
	async *runTurn(input) {
		const turn = this.startTurn(input);
		yield* turn.events;
		yield legacyTerminalEventFromTurnResult(await turn.result);
	}
	async getStatus(handle) {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		return {
			summary: statusSummary(record),
			acpxRecordId: record.acpxRecordId,
			backendSessionId: record.acpSessionId,
			agentSessionId: record.agentSessionId,
			...buildModelsField(record),
			details: {
				cwd: record.cwd,
				lastUsedAt: record.lastUsedAt,
				closed: record.closed === true,
				...record.acpx?.config_options !== void 0 ? { configOptions: structuredClone(record.acpx.config_options) } : {}
			}
		};
	}
	async setMode(handle, mode, sessionMode = "persistent") {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		const controller = this.activeControllers.get(record.acpxRecordId);
		let targetRecord = record;
		if (controller) await controller.setSessionMode(mode);
		else targetRecord = (await this.withRuntimeControlSession(record, sessionMode, async ({ client, sessionId }) => {
			await client.setSessionMode(sessionId, mode);
		})).record;
		setDesiredModeId(targetRecord, mode);
		await this.options.sessionStore.save(targetRecord);
	}
	async setConfigOption(handle, key, value, sessionMode = "persistent") {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		const controller = this.activeControllers.get(record.acpxRecordId);
		if (controller) {
			const { configId, response } = await controller.setResolvedSessionConfigOption(key, value);
			applyConfigOptionsToRecord(record, response);
			if (configId === "mode") setDesiredModeId(record, value);
			else setDesiredConfigOption(record, configId, value);
			await this.options.sessionStore.save(record);
			return;
		}
		const result = await this.withRuntimeControlSession(record, sessionMode, async ({ client, sessionId, record: connectedRecord }) => {
			const configId = resolveSupportedConfigOptionId(connectedRecord, key);
			applyConfigOptionsToRecord(connectedRecord, await client.setSessionConfigOption(sessionId, configId, value));
			if (configId === "mode") setDesiredModeId(connectedRecord, value);
			else setDesiredConfigOption(connectedRecord, configId, value);
		});
		await this.options.sessionStore.save(result.record);
	}
	async cancel(handle) {
		await this.activeControllers.get(handle.acpxRecordId ?? handle.sessionKey)?.requestCancelActivePrompt();
	}
	async close(handle, options = {}) {
		const record = await this.requireRecord(handle.acpxRecordId ?? handle.sessionKey);
		if (this.activeControllers.has(record.acpxRecordId)) this.closingActiveRecords.add(record.acpxRecordId);
		await this.cancel(handle);
		if (options.discardPersistentState) {
			await this.closeBackendSession(record);
			record.acpx = {
				...record.acpx,
				reset_on_next_ensure: true
			};
		} else await this.closePendingPersistentClient(record.acpxRecordId);
		record.closed = true;
		record.closedAt = isoNow();
		await this.options.sessionStore.save(record);
	}
	async closeBackendSession(record) {
		const pendingClient = await this.readPendingPersistentClient(record, { consume: true });
		const client = pendingClient ?? this.createClient({
			agentCommand: record.agentCommand,
			cwd: record.cwd,
			mcpServers: [...this.options.mcpServers ?? []],
			permissionMode: this.options.permissionMode,
			nonInteractivePermissions: this.options.nonInteractivePermissions,
			onPermissionRequest: this.options.onPermissionRequest,
			verbose: this.options.verbose
		});
		try {
			if (!pendingClient) await withTimeout(client.start(), this.options.timeoutMs);
			if (!client.supportsCloseSession()) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `Agent does not support session/close for ${record.acpxRecordId}.`);
			await withTimeout(client.closeSession(record.acpSessionId), this.options.timeoutMs);
		} catch (error) {
			if (isUnsupportedSessionCloseError(error)) throw new AcpRuntimeError("ACP_BACKEND_UNSUPPORTED_CONTROL", `Agent does not support session/close for ${record.acpxRecordId}.`, { cause: error });
			if (isAcpResourceNotFoundError(error)) return;
			throw error;
		} finally {
			await client.close().catch(() => {});
		}
	}
	async requireRecord(sessionId) {
		const record = await this.options.sessionStore.load(sessionId);
		if (!record) throw new Error(`ACP session not found: ${sessionId}`);
		return record;
	}
};
function safeSessionId(sessionId) {
	return encodeURIComponent(sessionId);
}
var FileSessionStore = class {
	stateDir;
	constructor(stateDir) {
		this.stateDir = stateDir;
	}
	get sessionDir() {
		return path.join(this.stateDir, "sessions");
	}
	filePath(sessionId) {
		return path.join(this.sessionDir, `${safeSessionId(sessionId)}.json`);
	}
	async ensureDir() {
		await fs$1.mkdir(this.sessionDir, { recursive: true });
	}
	async load(sessionId) {
		await this.ensureDir();
		try {
			const payload = await fs$1.readFile(this.filePath(sessionId), "utf8");
			return parseSessionRecord(JSON.parse(payload)) ?? void 0;
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
	}
	async save(record) {
		await this.ensureDir();
		const persisted = serializeSessionRecordForDisk(record);
		assertPersistedKeyPolicy(persisted);
		const file = this.filePath(record.acpxRecordId);
		const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
		const payload = JSON.stringify(persisted, null, 2);
		await fs$1.writeFile(tempFile, `${payload}\n`, "utf8");
		await fs$1.rename(tempFile, file);
	}
};
function createFileSessionStore(options) {
	return new FileSessionStore(path.resolve(options.stateDir));
}
const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v2:";
function encodeAcpxRuntimeHandleState(state) {
	return `${ACPX_RUNTIME_HANDLE_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}
function decodeAcpxRuntimeHandleState(runtimeSessionName) {
	const trimmed = runtimeSessionName.trim();
	if (!trimmed.startsWith(ACPX_RUNTIME_HANDLE_PREFIX)) return null;
	try {
		const raw = Buffer.from(trimmed.slice(8), "base64url").toString("utf8");
		const parsed = JSON.parse(raw);
		const name = asOptionalString(parsed.name);
		const agent = asOptionalString(parsed.agent);
		const cwd = asOptionalString(parsed.cwd);
		const mode = asOptionalString(parsed.mode);
		if (!name || !agent || !cwd || mode !== "persistent" && mode !== "oneshot") return null;
		return {
			name,
			agent,
			cwd,
			mode,
			acpxRecordId: asOptionalString(parsed.acpxRecordId),
			backendSessionId: asOptionalString(parsed.backendSessionId),
			agentSessionId: asOptionalString(parsed.agentSessionId)
		};
	} catch {
		return null;
	}
}
function writeHandleState(handle, state) {
	handle.runtimeSessionName = encodeAcpxRuntimeHandleState(state);
	handle.cwd = state.cwd;
	handle.acpxRecordId = state.acpxRecordId;
	handle.backendSessionId = state.backendSessionId;
	handle.agentSessionId = state.agentSessionId;
}
function formatRuntimeDetail(value) {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	if (value == null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") return String(value);
	if (typeof value === "function") return value.name ? `[Function ${value.name}]` : "[Function]";
	const seen = /* @__PURE__ */ new WeakSet();
	try {
		return JSON.stringify(value, (_key, nested) => {
			if (nested instanceof Error) return nested.message || nested.name;
			if (nested && typeof nested === "object") {
				if (seen.has(nested)) return "[Circular]";
				seen.add(nested);
			}
			return nested;
		}) ?? "undefined";
	} catch {
		return "unserializable object";
	}
}
function normalizeRuntimeDetails(details) {
	return details?.map((detail) => formatRuntimeDetail(detail));
}
async function probeRuntime(options, deps = {}) {
	const agentName = options.probeAgent?.trim() || "codex";
	const agentCommand = options.agentRegistry.resolve(agentName);
	const client = deps.clientFactory?.({
		agentCommand,
		cwd: options.cwd,
		mcpServers: [...options.mcpServers ?? []],
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		verbose: options.verbose
	}) ?? new AcpClient({
		agentCommand,
		cwd: options.cwd,
		mcpServers: [...options.mcpServers ?? []],
		permissionMode: options.permissionMode,
		nonInteractivePermissions: options.nonInteractivePermissions,
		verbose: options.verbose
	});
	try {
		await client.start();
		return {
			ok: true,
			message: "embedded ACP runtime ready",
			details: [
				`agent=${agentName}`,
				`command=${agentCommand}`,
				`cwd=${options.cwd}`,
				...client.initializeResult?.protocolVersion ? [`protocolVersion=${client.initializeResult.protocolVersion}`] : []
			]
		};
	} catch (error) {
		return {
			ok: false,
			message: "embedded ACP runtime probe failed",
			details: [
				`agent=${agentName}`,
				`command=${agentCommand}`,
				`cwd=${options.cwd}`,
				formatRuntimeDetail(error)
			]
		};
	} finally {
		await client.close().catch(() => {});
	}
}
const ACPX_BACKEND_ID = "acpx";
const ACPX_CAPABILITIES = { controls: [
	"session/set_mode",
	"session/set_config_option",
	"session/status"
] };
function createAgentRegistry(params) {
	return {
		resolve(agentName) {
			return resolveAgentCommand$1(agentName, params?.overrides);
		},
		list() {
			return listBuiltInAgents(params?.overrides);
		}
	};
}
var AcpxRuntime$1 = class {
	options;
	testOptions;
	healthy = false;
	manager = null;
	managerPromise = null;
	constructor(options, testOptions) {
		this.options = options;
		this.testOptions = testOptions;
	}
	isHealthy() {
		return this.healthy;
	}
	async probeAvailability() {
		const report = await this.runProbe();
		this.healthy = report.ok;
	}
	async doctor() {
		const report = await this.runProbe();
		this.healthy = report.ok;
		return {
			ok: report.ok,
			code: report.ok ? void 0 : "ACP_BACKEND_UNAVAILABLE",
			message: report.message,
			details: normalizeRuntimeDetails(report.details)
		};
	}
	async ensureSession(input) {
		const sessionName = input.sessionKey.trim();
		if (!sessionName) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		const agent = input.agent.trim();
		if (!agent) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
		const record = await (await this.getManager()).ensureSession({
			sessionKey: sessionName,
			agent,
			mode: input.mode,
			cwd: input.cwd ?? this.options.cwd,
			resumeSessionId: input.resumeSessionId,
			sessionOptions: input.sessionOptions
		});
		const handle = {
			sessionKey: input.sessionKey,
			backend: ACPX_BACKEND_ID,
			runtimeSessionName: "",
			cwd: record.cwd,
			acpxRecordId: record.acpxRecordId,
			backendSessionId: record.acpSessionId,
			agentSessionId: record.agentSessionId
		};
		writeHandleState(handle, {
			name: sessionName,
			agent,
			cwd: record.cwd,
			mode: input.mode,
			acpxRecordId: record.acpxRecordId,
			backendSessionId: record.acpSessionId,
			agentSessionId: record.agentSessionId
		});
		return handle;
	}
	startTurn(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		const turnPromise = this.getManager().then((manager) => manager.startTurn({
			handle,
			text: input.text,
			attachments: input.attachments,
			mode: input.mode,
			sessionMode: state.mode,
			requestId: input.requestId,
			timeoutMs: input.timeoutMs,
			signal: input.signal
		}));
		return {
			requestId: input.requestId,
			events: { async *[Symbol.asyncIterator]() {
				yield* (await turnPromise).events;
			} },
			get result() {
				return turnPromise.then((turn) => turn.result);
			},
			cancel(inputArgs) {
				return turnPromise.then((turn) => turn.cancel(inputArgs));
			},
			closeStream(inputArgs) {
				return turnPromise.then((turn) => turn.closeStream(inputArgs));
			}
		};
	}
	async *runTurn(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		yield* (await this.getManager()).runTurn({
			handle,
			text: input.text,
			attachments: input.attachments,
			mode: input.mode,
			sessionMode: state.mode,
			requestId: input.requestId,
			timeoutMs: input.timeoutMs,
			signal: input.signal
		});
	}
	async getCapabilities(input) {
		if (!input?.handle) return ACPX_CAPABILITIES;
		const { handle } = this.resolveManagerHandle(input.handle);
		const record = await this.options.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey);
		if (!record?.acpx?.config_options) return ACPX_CAPABILITIES;
		const configOptionKeys = Array.from(new Set(record.acpx.config_options.map((option) => option.id).filter((id) => typeof id === "string" && id.trim().length > 0)));
		return {
			...ACPX_CAPABILITIES,
			...configOptionKeys.length > 0 ? { configOptionKeys } : {}
		};
	}
	async getStatus(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		return await (await this.getManager()).getStatus(handle);
	}
	async setMode(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).setMode(handle, input.mode, state.mode);
	}
	async setConfigOption(input) {
		const { handle, state } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).setConfigOption(handle, input.key, input.value, state.mode);
	}
	async cancel(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).cancel(handle);
	}
	async close(input) {
		const { handle } = this.resolveManagerHandle(input.handle);
		await (await this.getManager()).close(handle, { discardPersistentState: input.discardPersistentState });
	}
	async getManager() {
		if (this.manager) return this.manager;
		if (!this.managerPromise) this.managerPromise = Promise.resolve(this.testOptions?.managerFactory?.(this.options) ?? new AcpRuntimeManager(this.options)).then((manager) => {
			this.manager = manager;
			return manager;
		});
		return await this.managerPromise;
	}
	async runProbe() {
		return await (this.testOptions?.probeRunner?.(this.options) ?? probeRuntime(this.options));
	}
	resolveManagerHandle(handle) {
		const state = this.resolveHandleState(handle);
		return {
			handle: {
				...handle,
				acpxRecordId: state.acpxRecordId ?? handle.acpxRecordId ?? handle.sessionKey
			},
			state
		};
	}
	resolveHandleState(handle) {
		const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
		if (decoded) return {
			...decoded,
			acpxRecordId: decoded.acpxRecordId ?? handle.acpxRecordId,
			backendSessionId: decoded.backendSessionId ?? handle.backendSessionId,
			agentSessionId: decoded.agentSessionId ?? handle.agentSessionId
		};
		const runtimeSessionName = handle.runtimeSessionName.trim();
		if (!runtimeSessionName) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Invalid embedded ACP runtime handle: runtimeSessionName is missing.");
		return {
			name: runtimeSessionName,
			agent: deriveAgentFromSessionKey(handle.sessionKey, DEFAULT_AGENT_NAME),
			cwd: handle.cwd ?? this.options.cwd,
			mode: "persistent",
			acpxRecordId: handle.acpxRecordId,
			backendSessionId: handle.backendSessionId,
			agentSessionId: handle.agentSessionId
		};
	}
};
function createAcpRuntime(options) {
	return new AcpxRuntime$1(options);
}
//#endregion
//#region extensions/acpx/src/runtime.ts
function withOpenClawManagedTurnTimeout(input) {
	return {
		...input,
		timeoutMs: 0
	};
}
const CODEX_WRAPPER_STDERR_LOG_PREFIX = "codex-acp-wrapper.stderr";
function safeDiagnosticFilePart(value) {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
function codexWrapperStderrLogFileName(leaseId) {
	return `${CODEX_WRAPPER_STDERR_LOG_PREFIX}.${safeDiagnosticFilePart(leaseId)}.log`;
}
function compactDiagnosticText(value) {
	return value.replace(/\s+/g, " ").trim();
}
function isGenericInternalAcpErrorMessage(message) {
	return message.trim() === "Internal error";
}
function isGenericInternalAcpError(error) {
	if (!(error instanceof Error)) return false;
	return isGenericInternalAcpErrorMessage(error.message);
}
async function readCodexWrapperStderrTail(params) {
	if (!params.wrapperRoot || !params.leaseId) return "";
	try {
		return compactDiagnosticText(redactSensitiveText((await fs$1.readFile(path.join(params.wrapperRoot, codexWrapperStderrLogFileName(params.leaseId)), "utf8")).slice(-6e3)));
	} catch {
		return "";
	}
}
function readSessionRecordName(record) {
	if (typeof record !== "object" || record === null) return "";
	const { name } = record;
	return typeof name === "string" ? name.trim() : "";
}
function readRecordAgentCommand(record) {
	if (typeof record !== "object" || record === null) return;
	const { agentCommand } = record;
	return typeof agentCommand === "string" ? agentCommand.trim() || void 0 : void 0;
}
function readRecordCwd(record) {
	if (typeof record !== "object" || record === null) return;
	const { cwd } = record;
	return typeof cwd === "string" ? cwd.trim() || void 0 : void 0;
}
function readRecordResetOnNextEnsure(record) {
	if (typeof record !== "object" || record === null) return false;
	const { acpx } = record;
	if (typeof acpx !== "object" || acpx === null) return false;
	return acpx.reset_on_next_ensure === true;
}
function readRecordAgentPid(record) {
	if (typeof record !== "object" || record === null) return;
	const { pid, processId } = record;
	const rawPid = pid ?? processId;
	const numericPid = typeof rawPid === "number" ? rawPid : typeof rawPid === "string" ? Number.parseInt(rawPid, 10) : void 0;
	return numericPid && Number.isInteger(numericPid) && numericPid > 0 ? numericPid : void 0;
}
function readOpenClawLeaseIdFromRecord(record) {
	if (typeof record !== "object" || record === null) return;
	const { openclawLeaseId } = record;
	return typeof openclawLeaseId === "string" ? openclawLeaseId.trim() || void 0 : void 0;
}
function extractGeneratedWrapperPath(command) {
	return splitCommandParts(command ?? "").find((part) => basename$1(part) === "codex-acp-wrapper.mjs" || basename$1(part) === "claude-agent-acp-wrapper.mjs") ?? "";
}
function selectCurrentSessionLease(params) {
	const sessionKeys = new Set(params.sessionKeys.map((entry) => entry.trim()).filter(Boolean));
	const candidates = params.leases.filter((lease) => sessionKeys.has(lease.sessionKey));
	if (params.rootPid) return candidates.find((lease) => lease.rootPid === params.rootPid);
	let selected;
	for (const lease of candidates) if (!selected || lease.startedAt > selected.startedAt) selected = lease;
	return selected;
}
function createResetAwareSessionStore(baseStore, params) {
	const freshSessionKeys = /* @__PURE__ */ new Set();
	return {
		async load(sessionId) {
			const normalized = sessionId.trim();
			if (normalized && freshSessionKeys.has(normalized)) return;
			const record = await baseStore.load(sessionId);
			if (!record || !params?.leaseStore || !params.gatewayInstanceId) return record;
			const sessionName = readSessionRecordName(record) || normalized;
			const lease = selectCurrentSessionLease({
				leases: await params.leaseStore.listOpen(params.gatewayInstanceId),
				sessionKeys: [sessionName, normalized],
				rootPid: readRecordAgentPid(record)
			});
			if (!lease) return record;
			return {
				...record,
				openclawLeaseId: lease.leaseId,
				openclawGatewayInstanceId: lease.gatewayInstanceId
			};
		},
		async save(record) {
			let recordToSave = record;
			const launch = params?.launchScope?.getStore();
			const sessionName = readSessionRecordName(record);
			const rootPid = readRecordAgentPid(record);
			const agentCommand = readRecordAgentCommand(record);
			const stableAgentCommand = launch?.stableCommand ?? agentCommand;
			if (launch && params?.leaseStore && sessionName === launch.sessionKey && rootPid && stableAgentCommand) {
				const lease = {
					leaseId: launch.leaseId,
					gatewayInstanceId: launch.gatewayInstanceId,
					sessionKey: launch.sessionKey,
					wrapperRoot: launch.wrapperRoot,
					wrapperPath: extractGeneratedWrapperPath(stableAgentCommand),
					rootPid,
					commandHash: hashAcpxProcessCommand(stableAgentCommand),
					startedAt: Date.now(),
					state: "open"
				};
				await params.leaseStore.save(lease);
				recordToSave = {
					...record,
					agentCommand: stableAgentCommand,
					openclawLeaseId: launch.leaseId,
					openclawGatewayInstanceId: launch.gatewayInstanceId
				};
			}
			await baseStore.save(recordToSave);
			if (sessionName) freshSessionKeys.delete(sessionName);
		},
		markFresh(sessionKey) {
			const normalized = sessionKey.trim();
			if (normalized) freshSessionKeys.add(normalized);
		}
	};
}
const OPENCLAW_BRIDGE_EXECUTABLE = "openclaw";
const OPENCLAW_BRIDGE_SUBCOMMAND = "acp";
const CODEX_ACP_AGENT_ID = "codex";
const CODEX_ACP_OPENCLAW_PREFIX = "openai-codex/";
const CODEX_ACP_REASONING_EFFORTS = new Set([
	"low",
	"medium",
	"high",
	"xhigh"
]);
const CODEX_ACP_THINKING_ALIASES = new Map([
	["off", void 0],
	["minimal", "low"],
	["low", "low"],
	["medium", "medium"],
	["high", "high"],
	["x-high", "xhigh"],
	["x_high", "xhigh"],
	["extra-high", "xhigh"],
	["extra_high", "xhigh"],
	["extra high", "xhigh"],
	["xhigh", "xhigh"]
]);
function normalizeAgentName(value) {
	const normalized = value?.trim().toLowerCase();
	return normalized ? normalized : void 0;
}
function readAgentFromSessionKey(sessionKey) {
	const normalized = sessionKey?.trim();
	if (!normalized) return;
	return normalizeAgentName(/^agent:(?<agent>[^:]+):/i.exec(normalized)?.groups?.agent);
}
function readAgentFromHandle(handle) {
	const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
	if (typeof decoded === "object" && decoded !== null) {
		const { agent } = decoded;
		if (typeof agent === "string") return normalizeAgentName(agent) ?? readAgentFromSessionKey(handle.sessionKey);
	}
	return readAgentFromSessionKey(handle.sessionKey);
}
function readAgentCommandFromRecord(record) {
	return readRecordAgentCommand(record);
}
function readAgentPidFromRecord(record) {
	return readRecordAgentPid(record);
}
function basename$1(value) {
	return value.split(/[\\/]/).pop() ?? value;
}
function isEnvAssignment(value) {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}
function unwrapEnvCommand(parts) {
	if (!parts.length || basename$1(parts[0]) !== "env") return parts;
	let index = 1;
	while (index < parts.length && isEnvAssignment(parts[index])) index += 1;
	return parts.slice(index);
}
function matchesExecutableName(value, executableName) {
	const normalized = basename$1(value).toLowerCase();
	return normalized === executableName || normalized === `${executableName}.exe`;
}
function matchesPackageSpec(value, packageName) {
	const normalized = value.trim().toLowerCase();
	return normalized === packageName || normalized.startsWith(`${packageName}@`);
}
function stripModuleExtension(value) {
	return value.replace(/\.[cm]?js$/i, "").toLowerCase();
}
function isAcpCommand(command, params) {
	if (!command) return false;
	const parts = unwrapEnvCommand(splitCommandParts(command.trim()));
	if (!parts.length) return false;
	if (parts.some((part) => matchesPackageSpec(part, params.packageName))) return true;
	const commandName = basename$1(parts[0] ?? "");
	if (matchesExecutableName(commandName, params.executableName)) return true;
	if (!matchesExecutableName(commandName, "node")) return false;
	const scriptName = stripModuleExtension(basename$1(parts[1] ?? ""));
	return scriptName === params.executableName || scriptName === `${params.executableName}-wrapper`;
}
function isOpenClawBridgeCommand(command) {
	if (!command) return false;
	const parts = unwrapEnvCommand(splitCommandParts(command.trim()));
	if (basename$1(parts[0] ?? "") === OPENCLAW_BRIDGE_EXECUTABLE) return parts[1] === OPENCLAW_BRIDGE_SUBCOMMAND;
	if (basename$1(parts[0] ?? "") !== "node") return false;
	const scriptName = basename$1(parts[1] ?? "");
	return /^openclaw(?:\.[cm]?js)?$/i.test(scriptName) && parts[2] === OPENCLAW_BRIDGE_SUBCOMMAND;
}
function isCodexAcpCommand(command) {
	return isAcpCommand(command, {
		packageName: "@zed-industries/codex-acp",
		executableName: "codex-acp"
	});
}
function isClaudeAcpCommand(command) {
	return isAcpCommand(command, {
		packageName: "@agentclientprotocol/claude-agent-acp",
		executableName: "claude-agent-acp"
	});
}
function failUnsupportedCodexAcpModel(rawModel, detail) {
	throw new AcpRuntimeError$1("ACP_INVALID_RUNTIME_OPTION", detail ?? `Codex ACP model "${rawModel}" is not supported. Use openai-codex/<model> or <model>/<reasoning-effort>.`);
}
const SUPPORTED_RUNTIME_SESSION_MODES = new Set(["persistent", "oneshot"]);
const WIRE_TIMEOUT_CONFIG_KEYS = new Set(["timeout", "timeout_seconds"]);
function assertSupportedRuntimeSessionMode(mode) {
	if (typeof mode === "string" && SUPPORTED_RUNTIME_SESSION_MODES.has(mode)) return;
	const supported = Array.from(SUPPORTED_RUNTIME_SESSION_MODES).join(", ");
	throw new AcpRuntimeError$1("ACP_INVALID_RUNTIME_OPTION", `Unsupported ACP runtime session mode ${JSON.stringify(mode)}. Expected one of: ${supported}.`);
}
function failUnsupportedCodexAcpThinking(rawThinking) {
	throw new AcpRuntimeError$1("ACP_INVALID_RUNTIME_OPTION", `Codex ACP thinking level "${rawThinking}" is not supported. Use off, minimal, low, medium, high, or xhigh.`);
}
function normalizeCodexAcpReasoningEffort(rawThinking) {
	const normalized = rawThinking?.trim().toLowerCase();
	if (!normalized) return;
	if (!CODEX_ACP_THINKING_ALIASES.has(normalized)) failUnsupportedCodexAcpThinking(rawThinking ?? "");
	return CODEX_ACP_THINKING_ALIASES.get(normalized);
}
function normalizeCodexAcpModelOverride(rawModel, rawThinking) {
	const raw = rawModel?.trim();
	const thinkingReasoningEffort = normalizeCodexAcpReasoningEffort(rawThinking);
	if (!raw) return thinkingReasoningEffort ? { reasoningEffort: thinkingReasoningEffort } : void 0;
	let value = raw;
	if (value.toLowerCase().startsWith(CODEX_ACP_OPENCLAW_PREFIX)) value = value.slice(13);
	const parts = value.split("/");
	if (parts.length > 2) failUnsupportedCodexAcpModel(raw, `Codex ACP model "${raw}" is not supported. Use openai-codex/<model> or <model>/<reasoning-effort>.`);
	const model = (parts[0] ?? "").trim();
	const modelReasoningEffort = normalizeCodexAcpReasoningEffort(parts[1]);
	if (!model) failUnsupportedCodexAcpModel(raw, `Codex ACP model "${raw}" is not supported. Use openai-codex/<model> or <model>/<reasoning-effort>.`);
	const reasoningEffort = thinkingReasoningEffort ?? modelReasoningEffort;
	if (reasoningEffort && !CODEX_ACP_REASONING_EFFORTS.has(reasoningEffort)) failUnsupportedCodexAcpThinking(reasoningEffort);
	return {
		model,
		...reasoningEffort ? { reasoningEffort } : {}
	};
}
function codexAcpSessionModelId(override) {
	if (!override.model) return "";
	return override.reasoningEffort ? `${override.model}/${override.reasoningEffort}` : override.model;
}
function quoteShellArg(value) {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}
function appendCodexAcpConfigOverrides(command, override) {
	const configArgs = override.model ? [`model=${override.model}`] : [];
	if (override.reasoningEffort) configArgs.push(`model_reasoning_effort=${override.reasoningEffort}`);
	if (configArgs.length === 0) return command;
	return `${command} ${configArgs.map((arg) => `-c ${quoteShellArg(arg)}`).join(" ")}`;
}
function createModelScopedAgentRegistry(params) {
	return {
		resolve(agentName) {
			const command = params.agentRegistry.resolve(agentName);
			const override = params.scope.getStore();
			if (!override || normalizeAgentName(agentName) !== CODEX_ACP_AGENT_ID || typeof command !== "string" || !isCodexAcpCommand(command)) return params.leaseCommand(command);
			return params.leaseCommand(appendCodexAcpConfigOverrides(command, override));
		},
		list() {
			return params.agentRegistry.list();
		}
	};
}
function resolveAgentCommand(params) {
	const normalizedAgentName = normalizeAgentName(params.agentName);
	if (!normalizedAgentName) return;
	const resolvedCommand = params.agentRegistry.resolve(normalizedAgentName);
	return typeof resolvedCommand === "string" ? resolvedCommand.trim() || void 0 : void 0;
}
function resolveProbeAgentName(options) {
	const { probeAgent } = options;
	return normalizeAgentName(typeof probeAgent === "string" ? probeAgent : void 0) ?? "codex";
}
function resolveAgentCommandForName(params) {
	return resolveAgentCommand(params);
}
function shouldUseBridgeSafeDelegateForCommand(command) {
	return isOpenClawBridgeCommand(command);
}
function shouldUseDistinctBridgeDelegate(options) {
	const { mcpServers } = options;
	return Array.isArray(mcpServers) && mcpServers.length > 0;
}
var AcpxRuntime = class {
	constructor(options, testOptions) {
		this.codexAcpModelOverrideScope = new AsyncLocalStorage();
		this.launchLeaseScope = new AsyncLocalStorage();
		const { openclawProcessCleanup, ...delegateTestOptions } = testOptions ?? {};
		this.processCleanupDeps = openclawProcessCleanup;
		this.wrapperRoot = options.openclawWrapperRoot;
		this.gatewayInstanceId = options.openclawGatewayInstanceId;
		this.processLeaseStore = options.openclawProcessLeaseStore;
		this.cwd = options.cwd;
		this.sessionStore = createResetAwareSessionStore(options.sessionStore, {
			gatewayInstanceId: this.gatewayInstanceId,
			leaseStore: this.processLeaseStore,
			launchScope: this.launchLeaseScope
		});
		this.agentRegistry = options.agentRegistry;
		this.scopedAgentRegistry = createModelScopedAgentRegistry({
			agentRegistry: this.agentRegistry,
			scope: this.codexAcpModelOverrideScope,
			leaseCommand: (command) => this.commandWithLaunchLease(command)
		});
		const sharedOptions = {
			...options,
			sessionStore: this.sessionStore,
			agentRegistry: this.scopedAgentRegistry
		};
		this.delegate = new AcpxRuntime$1(sharedOptions, delegateTestOptions);
		this.bridgeSafeDelegate = shouldUseDistinctBridgeDelegate(options) ? new AcpxRuntime$1({
			...sharedOptions,
			mcpServers: []
		}, delegateTestOptions) : this.delegate;
		this.probeDelegate = this.resolveDelegateForAgent(resolveProbeAgentName(options));
	}
	resolveDelegateForAgent(agentName) {
		const command = resolveAgentCommandForName({
			agentName,
			agentRegistry: this.agentRegistry
		});
		return this.resolveDelegateForCommand(command);
	}
	resolveDelegateForCommand(command) {
		return shouldUseBridgeSafeDelegateForCommand(command) ? this.bridgeSafeDelegate : this.delegate;
	}
	async resolveDelegateForHandle(handle) {
		const record = await this.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey);
		return this.resolveDelegateForLoadedRecord(handle, record);
	}
	resolveDelegateForLoadedRecord(handle, record) {
		const recordCommand = readAgentCommandFromRecord(record);
		if (recordCommand) return this.resolveDelegateForCommand(recordCommand);
		return this.resolveDelegateForAgent(readAgentFromHandle(handle));
	}
	async resolveCommandForHandle(handle) {
		const recordCommand = readAgentCommandFromRecord(await this.sessionStore.load(handle.acpxRecordId ?? handle.sessionKey));
		if (recordCommand) return recordCommand;
		return resolveAgentCommandForName({
			agentName: readAgentFromHandle(handle),
			agentRegistry: this.agentRegistry
		});
	}
	commandWithLaunchLease(command) {
		const launch = this.launchLeaseScope.getStore();
		if (!command || !launch) return command;
		launch.stableCommand = command;
		return withAcpxLeaseEnvironment({
			command,
			leaseId: launch.leaseId,
			gatewayInstanceId: launch.gatewayInstanceId
		});
	}
	async canReuseStablePersistentSession(params) {
		if (params.mode !== "persistent" || !params.command) return false;
		const existing = await this.sessionStore.load(params.sessionKey);
		if (!existing || readRecordResetOnNextEnsure(existing)) return false;
		const recordCwd = readRecordCwd(existing);
		if (!recordCwd || resolve(recordCwd) !== resolve(params.cwd?.trim() || this.cwd)) return false;
		if (readRecordAgentCommand(existing) !== params.command) return false;
		const existingSessionId = typeof existing === "object" && existing !== null ? existing.acpSessionId : void 0;
		return !params.resumeSessionId || existingSessionId === params.resumeSessionId;
	}
	async runWithLaunchLease(params) {
		if (params.enabled === false || !params.command || !this.wrapperRoot || !this.gatewayInstanceId || !this.processLeaseStore || !isOpenClawLeaseAwareAcpxProcessCommand({
			command: params.command,
			wrapperRoot: this.wrapperRoot
		})) return await params.run();
		const launch = {
			leaseId: createAcpxProcessLeaseId(),
			gatewayInstanceId: this.gatewayInstanceId,
			sessionKey: params.sessionKey,
			wrapperRoot: this.wrapperRoot,
			stableCommand: params.command
		};
		await this.processLeaseStore.save({
			leaseId: launch.leaseId,
			gatewayInstanceId: launch.gatewayInstanceId,
			sessionKey: launch.sessionKey,
			wrapperRoot: launch.wrapperRoot,
			wrapperPath: extractGeneratedWrapperPath(params.command),
			rootPid: 0,
			commandHash: hashAcpxProcessCommand(params.command),
			startedAt: Date.now(),
			state: "open"
		});
		return await this.launchLeaseScope.run(launch, params.run);
	}
	async withCodexWrapperDiagnostics(params) {
		try {
			return await params.run();
		} catch (error) {
			if (!isCodexAcpCommand(params.command) || !isGenericInternalAcpError(error)) throw error;
			const stderrTail = await readCodexWrapperStderrTail({
				wrapperRoot: this.wrapperRoot,
				leaseId: this.launchLeaseScope.getStore()?.leaseId
			});
			if (!stderrTail) throw error;
			throw new AcpRuntimeError$1(params.fallbackCode, `Internal error: ${stderrTail}`, { cause: error });
		}
	}
	async readCodexTurnFailureStderr(params) {
		const record = await this.sessionStore.load(params.handle.acpxRecordId ?? params.handle.sessionKey);
		return readCodexWrapperStderrTail({
			wrapperRoot: this.wrapperRoot,
			leaseId: readOpenClawLeaseIdFromRecord(record)
		});
	}
	async cleanupProcessTreeForRecord(handle, record) {
		const leaseId = readOpenClawLeaseIdFromRecord(record);
		const rootPid = readAgentPidFromRecord(record);
		const sessionKeys = [handle.sessionKey, readSessionRecordName(record)];
		const selectedLease = selectCurrentSessionLease({
			leases: this.gatewayInstanceId && this.processLeaseStore ? await this.processLeaseStore.listOpen(this.gatewayInstanceId) : [],
			sessionKeys,
			rootPid
		});
		const loadedLease = leaseId ? await this.processLeaseStore?.load(leaseId) : void 0;
		const lease = selectedLease ?? (loadedLease && loadedLease.gatewayInstanceId === this.gatewayInstanceId && (!rootPid || loadedLease.rootPid === rootPid) && sessionKeys.includes(loadedLease.sessionKey) ? loadedLease : void 0);
		if (lease && lease.gatewayInstanceId === this.gatewayInstanceId && lease.rootPid > 0) {
			await this.processLeaseStore?.markState(lease.leaseId, "closing");
			const result = await cleanupOpenClawOwnedAcpxProcessTree({
				rootPid: lease.rootPid,
				rootCommand: readAgentCommandFromRecord(record),
				expectedLeaseId: lease.leaseId,
				expectedGatewayInstanceId: lease.gatewayInstanceId,
				wrapperRoot: lease.wrapperRoot,
				deps: this.processCleanupDeps
			});
			await this.processLeaseStore?.markState(lease.leaseId, result.terminatedPids.length > 0 || result.skippedReason === "missing-root" ? "closed" : "lost");
			return;
		}
		const rootCommand = readAgentCommandFromRecord(record) ?? resolveAgentCommandForName({
			agentName: readAgentFromHandle(handle),
			agentRegistry: this.agentRegistry
		});
		if (!rootPid || !rootCommand) return;
		await cleanupOpenClawOwnedAcpxProcessTree({
			rootPid,
			rootCommand,
			wrapperRoot: this.wrapperRoot,
			deps: this.processCleanupDeps
		});
	}
	isHealthy() {
		return this.probeDelegate.isHealthy();
	}
	probeAvailability() {
		return this.probeDelegate.probeAvailability();
	}
	doctor() {
		return this.probeDelegate.doctor();
	}
	async ensureSession(input) {
		assertSupportedRuntimeSessionMode(input.mode);
		const command = resolveAgentCommandForName({
			agentName: input.agent,
			agentRegistry: this.agentRegistry
		});
		const delegate = this.resolveDelegateForCommand(command);
		const codexModelOverride = normalizeAgentName(input.agent) === CODEX_ACP_AGENT_ID && isCodexAcpCommand(command) ? normalizeCodexAcpModelOverride(input.model, input.thinking) : void 0;
		const stableLaunchCommand = codexModelOverride && command ? appendCodexAcpConfigOverrides(command, codexModelOverride) : command;
		const shouldStartWithLease = !await this.canReuseStablePersistentSession({
			sessionKey: input.sessionKey,
			mode: input.mode,
			cwd: input.cwd,
			command: stableLaunchCommand,
			resumeSessionId: input.resumeSessionId
		});
		if (!codexModelOverride) return await this.runWithLaunchLease({
			sessionKey: input.sessionKey,
			command: stableLaunchCommand,
			enabled: shouldStartWithLease,
			run: () => this.withCodexWrapperDiagnostics({
				command: stableLaunchCommand,
				fallbackCode: "ACP_SESSION_INIT_FAILED",
				run: () => delegate.ensureSession(input)
			})
		});
		const normalizedInput = {
			...input,
			...codexAcpSessionModelId(codexModelOverride) ? { model: codexAcpSessionModelId(codexModelOverride) } : {}
		};
		return await this.runWithLaunchLease({
			sessionKey: input.sessionKey,
			command: stableLaunchCommand,
			enabled: shouldStartWithLease,
			run: () => this.codexAcpModelOverrideScope.run(codexModelOverride, () => this.withCodexWrapperDiagnostics({
				command: stableLaunchCommand,
				fallbackCode: "ACP_SESSION_INIT_FAILED",
				run: () => delegate.ensureSession(normalizedInput)
			}))
		});
	}
	async *runTurn(input) {
		const command = await this.resolveCommandForHandle(input.handle);
		const delegate = await this.resolveDelegateForHandle(input.handle);
		try {
			for await (const event of delegate.runTurn(withOpenClawManagedTurnTimeout(input))) {
				if (event.type !== "error" || !isCodexAcpCommand(command) || !isGenericInternalAcpErrorMessage(event.message)) {
					yield event;
					continue;
				}
				const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
				if (!stderrTail) {
					yield event;
					continue;
				}
				yield {
					...event,
					code: "ACP_TURN_FAILED",
					message: `Internal error: ${stderrTail}`
				};
			}
		} catch (error) {
			if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) throw error;
			const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
			if (!stderrTail) throw error;
			throw new AcpRuntimeError$1("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, { cause: error });
		}
	}
	startTurn(input) {
		const readCodexTurnFailureStderr = () => this.readCodexTurnFailureStderr({ handle: input.handle });
		const turnPromise = Promise.all([this.resolveCommandForHandle(input.handle), this.resolveDelegateForHandle(input.handle)]).then(async ([command, delegate]) => {
			try {
				return {
					command,
					turn: delegate.startTurn(withOpenClawManagedTurnTimeout(input))
				};
			} catch (error) {
				if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) throw error;
				const stderrTail = await readCodexTurnFailureStderr();
				if (!stderrTail) throw error;
				throw new AcpRuntimeError$1("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, { cause: error });
			}
		});
		return {
			requestId: input.requestId,
			events: { async *[Symbol.asyncIterator]() {
				const { command, turn } = await turnPromise;
				try {
					for await (const event of turn.events) {
						if (event.type !== "error" || !isCodexAcpCommand(command) || !isGenericInternalAcpErrorMessage(event.message)) {
							yield event;
							continue;
						}
						const stderrTail = await readCodexTurnFailureStderr();
						if (!stderrTail) {
							yield event;
							continue;
						}
						yield {
							...event,
							code: "ACP_TURN_FAILED",
							message: `Internal error: ${stderrTail}`
						};
					}
				} catch (error) {
					if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) throw error;
					const stderrTail = await readCodexTurnFailureStderr();
					if (!stderrTail) throw error;
					throw new AcpRuntimeError$1("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, { cause: error });
				}
			} },
			result: turnPromise.then(async ({ command, turn }) => {
				try {
					const result = await turn.result;
					if (result.status !== "failed" || !isCodexAcpCommand(command) || !isGenericInternalAcpErrorMessage(result.error.message)) return result;
					const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
					if (!stderrTail) return result;
					return {
						status: "failed",
						error: {
							...result.error,
							code: "ACP_TURN_FAILED",
							message: `Internal error: ${stderrTail}`
						}
					};
				} catch (error) {
					if (!isCodexAcpCommand(command) || !isGenericInternalAcpError(error)) throw error;
					const stderrTail = await this.readCodexTurnFailureStderr({ handle: input.handle });
					if (!stderrTail) throw error;
					throw new AcpRuntimeError$1("ACP_TURN_FAILED", `Internal error: ${stderrTail}`, { cause: error });
				}
			}),
			cancel(inputArgs) {
				return turnPromise.then(({ turn }) => turn.cancel(inputArgs));
			},
			closeStream(inputArgs) {
				return turnPromise.then(({ turn }) => turn.closeStream(inputArgs));
			}
		};
	}
	getCapabilities() {
		return this.delegate.getCapabilities();
	}
	async getStatus(input) {
		return (await this.resolveDelegateForHandle(input.handle)).getStatus(input);
	}
	async setMode(input) {
		await (await this.resolveDelegateForHandle(input.handle)).setMode(input);
	}
	async setConfigOption(input) {
		const delegate = await this.resolveDelegateForHandle(input.handle);
		const command = await this.resolveCommandForHandle(input.handle);
		const key = input.key.trim().toLowerCase();
		const isCodexAcp = isCodexAcpCommand(command);
		if (WIRE_TIMEOUT_CONFIG_KEYS.has(key) && (isCodexAcp || isClaudeAcpCommand(command))) return;
		if (isCodexAcp) {
			if (key === "model" || key === "thinking" || key === "thought_level" || key === "reasoning_effort") {
				const override = key === "model" ? normalizeCodexAcpModelOverride(input.value) : normalizeCodexAcpModelOverride(void 0, input.value);
				if (!override && key !== "model") return;
				if (override) {
					if (override.model) await delegate.setConfigOption({
						...input,
						key: "model",
						value: override.model
					});
					if (override.reasoningEffort) await delegate.setConfigOption({
						...input,
						key: "reasoning_effort",
						value: override.reasoningEffort
					});
					return;
				}
			}
		}
		await delegate.setConfigOption(input);
	}
	async cancel(input) {
		const record = await this.sessionStore.load(input.handle.acpxRecordId ?? input.handle.sessionKey);
		await this.resolveDelegateForLoadedRecord(input.handle, record).cancel(input);
	}
	async prepareFreshSession(input) {
		this.sessionStore.markFresh(input.sessionKey);
	}
	async close(input) {
		const record = await this.sessionStore.load(input.handle.acpxRecordId ?? input.handle.sessionKey);
		let closeSucceeded = false;
		try {
			await this.resolveDelegateForLoadedRecord(input.handle, record).close({
				handle: input.handle,
				reason: input.reason,
				discardPersistentState: input.discardPersistentState
			});
			closeSucceeded = true;
		} finally {
			await this.cleanupProcessTreeForRecord(input.handle, record);
		}
		if (closeSucceeded && input.discardPersistentState) this.sessionStore.markFresh(input.handle.sessionKey);
	}
};
const testing = {
	appendCodexAcpConfigOverrides,
	assertSupportedRuntimeSessionMode,
	codexAcpSessionModelId,
	isClaudeAcpCommand,
	isCodexAcpCommand,
	normalizeCodexAcpModelOverride
};
//#endregion
export { ACPX_BACKEND_ID, AcpxRuntime, testing as __testing, testing, createAcpRuntime, createAgentRegistry, createFileSessionStore, decodeAcpxRuntimeHandleState, encodeAcpxRuntimeHandleState };
