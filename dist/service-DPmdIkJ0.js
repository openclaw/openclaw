import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { At as boolean, Et as array, Ln as strictObject, Nn as record, Rn as string, Tn as object, wn as number, yt as _enum } from "./schemas-Del5uzR8.js";
import { a as unregisterAcpRuntimeBackend, n as registerAcpRuntimeBackend } from "./registry-KuKuvijT.js";
import { n as readJsonFileWithFallback } from "./json-store-ChgPP2Sf.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { s as formatPluginConfigIssue } from "./extension-shared-DSIp8QS_.js";
import "./runtime-api-woL2syfn.js";
import { a as splitCommandParts, c as OPENCLAW_GATEWAY_INSTANCE_ID_ARG, i as quoteCommandPart, o as OPENCLAW_ACPX_LEASE_ID_ARG, r as reapStaleOpenClawOwnedAcpxOrphans, s as OPENCLAW_ACPX_LEASE_ID_ENV, t as cleanupOpenClawOwnedAcpxProcessTree, u as createAcpxProcessLeaseStore } from "./process-reaper-DKzsV1k3.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
//#region extensions/acpx/src/codex-trust-config.ts
function stripTomlComment(line) {
	let quote = null;
	let escaping = false;
	for (let index = 0; index < line.length; index += 1) {
		const ch = line[index];
		if (escaping) {
			escaping = false;
			continue;
		}
		if (quote === "\"" && ch === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			continue;
		}
		if (ch === "#") return line.slice(0, index);
	}
	return line;
}
function parseTomlString(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
}
function parseTomlDottedKey(value) {
	const parts = [];
	let current = "";
	let quote = null;
	let escaping = false;
	for (const ch of value.trim()) {
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (quote === "\"" && ch === "\\") {
			current += ch;
			escaping = true;
			continue;
		}
		if (quote) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ".") {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	return parts.map((part) => parseTomlString(part) ?? part);
}
function parseProjectHeader(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]") || trimmed.startsWith("[[")) return;
	const parts = parseTomlDottedKey(trimmed.slice(1, -1));
	return parts.length === 2 && parts[0] === "projects" ? parts[1] : void 0;
}
function parseTrustedInlineProjectEntries(value) {
	const trusted = [];
	for (const match of value.matchAll(/(?<key>"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_\-/.~:]+)\s*=\s*\{(?<body>[^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
		const key = match.groups?.key;
		const body = match.groups?.body;
		if (!key || !body || !/\btrust_level\s*=\s*["']trusted["']/.test(body)) continue;
		const projectPath = parseTomlString(key) ?? key.trim();
		if (projectPath) trusted.push(projectPath);
	}
	return trusted;
}
function extractTrustedCodexProjectPaths(configToml) {
	const trusted = /* @__PURE__ */ new Set();
	let currentProjectPath;
	let inProjectsTable = false;
	for (const rawLine of configToml.split(/\r?\n/)) {
		const line = stripTomlComment(rawLine).trim();
		if (!line) continue;
		if (line.startsWith("[")) {
			currentProjectPath = parseProjectHeader(line);
			inProjectsTable = line === "[projects]";
			continue;
		}
		if (currentProjectPath && /^trust_level\s*=\s*["']trusted["']\s*$/.test(line)) {
			trusted.add(currentProjectPath);
			continue;
		}
		const assignment = /^(?<key>"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_\-/.~:]+)\s*=\s*(?<value>.+)$/.exec(line);
		if (!assignment?.groups) continue;
		const key = parseTomlString(assignment.groups.key) ?? assignment.groups.key;
		const value = assignment.groups.value.trim();
		if (inProjectsTable && /^\{.*\}$/.test(value)) {
			if (/\btrust_level\s*=\s*["']trusted["']/.test(value) && key) trusted.add(key);
			continue;
		}
		if (key === "projects" || inProjectsTable) for (const projectPath of parseTrustedInlineProjectEntries(value)) trusted.add(projectPath);
	}
	return Array.from(trusted);
}
const INHERITED_TOP_LEVEL_CODEX_CONFIG_KEYS = new Set([
	"model",
	"model_provider",
	"model_reasoning_effort",
	"sandbox_mode"
]);
const INHERITED_MODEL_PROVIDER_CONFIG_KEYS = new Set([
	"name",
	"base_url",
	"wire_api",
	"env_key",
	"env_key_instructions",
	"requires_openai_auth",
	"request_max_retries",
	"stream_max_retries",
	"stream_idle_timeout_ms"
]);
function parseTableHeader(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]") || trimmed.startsWith("[[")) return;
	return parseTomlDottedKey(trimmed.slice(1, -1));
}
function isInheritedModelProviderTable(parts) {
	return parts?.[0] === "model_providers" && parts.length === 2;
}
function parseTopLevelAssignmentKey(line) {
	return /^(?<key>[A-Za-z0-9_-]+)\s*=\s*(?<value>.+)$/.exec(line)?.groups?.key;
}
function extractInheritedCodexRuntimeConfig(configToml) {
	const inheritedLines = [];
	let inAnyTable = false;
	let inInheritedTable = false;
	let pendingInheritedTableHeader = "";
	function flushInheritedTableHeader() {
		if (!pendingInheritedTableHeader) return;
		if (inheritedLines.length > 0 && inheritedLines[inheritedLines.length - 1] !== "") inheritedLines.push("");
		inheritedLines.push(pendingInheritedTableHeader);
		pendingInheritedTableHeader = "";
	}
	for (const rawLine of configToml.split(/\r?\n/)) {
		const trimmedLine = rawLine.trim();
		const semanticLine = stripTomlComment(rawLine).trim();
		if (trimmedLine.startsWith("[")) {
			const tableParts = parseTableHeader(trimmedLine);
			inAnyTable = true;
			inInheritedTable = isInheritedModelProviderTable(tableParts);
			if (inInheritedTable) pendingInheritedTableHeader = rawLine.trimEnd();
			else pendingInheritedTableHeader = "";
			continue;
		}
		if (inInheritedTable) {
			if (!semanticLine) continue;
			const key = parseTopLevelAssignmentKey(semanticLine);
			if (!key || !INHERITED_MODEL_PROVIDER_CONFIG_KEYS.has(key)) continue;
			flushInheritedTableHeader();
			inheritedLines.push(rawLine.trimEnd());
			continue;
		}
		if (inAnyTable) continue;
		const key = parseTopLevelAssignmentKey(semanticLine);
		if (!key) continue;
		if (!INHERITED_TOP_LEVEL_CODEX_CONFIG_KEYS.has(key)) continue;
		inheritedLines.push(rawLine.trimEnd());
	}
	while (inheritedLines.length > 0 && inheritedLines[inheritedLines.length - 1] === "") inheritedLines.pop();
	return inheritedLines.join("\n");
}
function renderIsolatedCodexConfig(params) {
	const normalized = Array.from(new Set(params.projectPaths.map((projectPath) => projectPath.trim()).filter(Boolean).map((projectPath) => path.resolve(projectPath)))).toSorted((left, right) => left.localeCompare(right));
	return [
		"# Generated by OpenClaw for Codex ACP sessions.",
		params.sourceConfigToml ? extractInheritedCodexRuntimeConfig(params.sourceConfigToml) : "",
		...normalized.flatMap((projectPath) => [
			"",
			`[projects.${JSON.stringify(projectPath)}]`,
			"trust_level = \"trusted\""
		]),
		""
	].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");
}
//#endregion
//#region extensions/acpx/src/config-schema.ts
const ACPX_PERMISSION_MODES = [
	"approve-all",
	"approve-reads",
	"deny-all"
];
const ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"];
const nonEmptyTrimmedString = (message) => string({ error: message }).trim().min(1, { error: message });
const McpServerConfigSchema = object({
	command: nonEmptyTrimmedString("command must be a non-empty string").describe("Command to run the MCP server"),
	args: array(string({ error: "args must be an array of strings" }), { error: "args must be an array of strings" }).optional().describe("Arguments to pass to the command"),
	env: record(string(), string({ error: "env values must be strings" }), { error: "env must be an object of strings" }).optional().describe("Environment variables for the MCP server")
});
const AcpxPluginConfigSchema = strictObject({
	cwd: nonEmptyTrimmedString("cwd must be a non-empty string").optional(),
	stateDir: nonEmptyTrimmedString("stateDir must be a non-empty string").optional(),
	probeAgent: nonEmptyTrimmedString("probeAgent must be a non-empty string").optional(),
	permissionMode: _enum(ACPX_PERMISSION_MODES, { error: `permissionMode must be one of: ${ACPX_PERMISSION_MODES.join(", ")}` }).optional(),
	nonInteractivePermissions: _enum(ACPX_NON_INTERACTIVE_POLICIES, { error: `nonInteractivePermissions must be one of: ${ACPX_NON_INTERACTIVE_POLICIES.join(", ")}` }).optional(),
	pluginToolsMcpBridge: boolean({ error: "pluginToolsMcpBridge must be a boolean" }).optional(),
	openClawToolsMcpBridge: boolean({ error: "openClawToolsMcpBridge must be a boolean" }).optional(),
	strictWindowsCmdWrapper: boolean({ error: "strictWindowsCmdWrapper must be a boolean" }).optional(),
	timeoutSeconds: number({ error: "timeoutSeconds must be a number >= 0.001" }).min(.001, { error: "timeoutSeconds must be a number >= 0.001" }).default(120),
	queueOwnerTtlSeconds: number({ error: "queueOwnerTtlSeconds must be a number >= 0" }).min(0, { error: "queueOwnerTtlSeconds must be a number >= 0" }).optional(),
	mcpServers: record(string(), McpServerConfigSchema).optional(),
	agents: record(string(), strictObject({
		command: nonEmptyTrimmedString("agents.<id>.command must be a non-empty string"),
		args: array(string({ error: "args must be an array of strings" })).optional()
	})).optional()
});
//#endregion
//#region extensions/acpx/src/config.ts
const ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME = "openclaw-plugin-tools";
const ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME = "openclaw-tools";
const requireFromHere$1 = createRequire(import.meta.url);
function isAcpxPluginRoot(dir) {
	return fs.existsSync(path.join(dir, "openclaw.plugin.json")) && fs.existsSync(path.join(dir, "package.json"));
}
function resolveNearestAcpxPluginRoot(moduleUrl) {
	let cursor = path.dirname(fileURLToPath(moduleUrl));
	for (let i = 0; i < 3; i += 1) {
		if (isAcpxPluginRoot(cursor)) return cursor;
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}
function resolveWorkspaceAcpxPluginRoot(currentRoot) {
	if (path.basename(currentRoot) !== "acpx" || path.basename(path.dirname(currentRoot)) !== "extensions" || path.basename(path.dirname(path.dirname(currentRoot))) !== "dist") return null;
	const workspaceRoot = path.resolve(currentRoot, "..", "..", "..", "extensions", "acpx");
	return isAcpxPluginRoot(workspaceRoot) ? workspaceRoot : null;
}
function resolveRepoAcpxPluginRoot(currentRoot) {
	const workspaceRoot = path.join(currentRoot, "extensions", "acpx");
	return isAcpxPluginRoot(workspaceRoot) ? workspaceRoot : null;
}
function resolveAcpxPluginRootFromOpenClawLayout(moduleUrl) {
	let cursor = path.dirname(fileURLToPath(moduleUrl));
	for (let i = 0; i < 5; i += 1) {
		const candidates = [
			path.join(cursor, "extensions", "acpx"),
			path.join(cursor, "dist", "extensions", "acpx"),
			path.join(cursor, "dist-runtime", "extensions", "acpx")
		];
		for (const candidate of candidates) if (isAcpxPluginRoot(candidate)) return candidate;
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return null;
}
function resolveAcpxPluginRoot(moduleUrl = import.meta.url) {
	const resolvedRoot = resolveNearestAcpxPluginRoot(moduleUrl);
	return resolveWorkspaceAcpxPluginRoot(resolvedRoot) ?? resolveRepoAcpxPluginRoot(resolvedRoot) ?? resolveAcpxPluginRootFromOpenClawLayout(moduleUrl) ?? resolvedRoot;
}
const DEFAULT_PERMISSION_MODE = "approve-reads";
const DEFAULT_NON_INTERACTIVE_POLICY = "fail";
const DEFAULT_QUEUE_OWNER_TTL_SECONDS = .1;
const DEFAULT_STRICT_WINDOWS_CMD_WRAPPER = true;
function parseAcpxPluginConfig(value) {
	if (value === void 0) return {
		ok: true,
		value: void 0
	};
	const parsed = AcpxPluginConfigSchema.safeParse(value);
	if (!parsed.success) return {
		ok: false,
		message: formatPluginConfigIssue(parsed.error.issues[0])
	};
	return {
		ok: true,
		value: parsed.data
	};
}
function resolveOpenClawRoot(currentRoot) {
	if (path.basename(currentRoot) === "acpx" && path.basename(path.dirname(currentRoot)) === "extensions") {
		const parent = path.dirname(path.dirname(currentRoot));
		if (path.basename(parent) === "dist") return path.dirname(parent);
		return parent;
	}
	return path.resolve(currentRoot, "..");
}
function resolveTsxImportSpecifier() {
	try {
		return requireFromHere$1.resolve("tsx");
	} catch {
		return "tsx";
	}
}
function shellQuoteCommandArg(arg) {
	if (!/[\s'"\\$|&;<>{}()*?[\]~`]/.test(arg)) return arg;
	return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}
function resolvePluginToolsMcpServerConfig(moduleUrl = import.meta.url) {
	const openClawRoot = resolveOpenClawRoot(resolveAcpxPluginRoot(moduleUrl));
	const distEntry = path.join(openClawRoot, "dist", "mcp", "plugin-tools-serve.js");
	if (fs.existsSync(distEntry)) return {
		command: process.execPath,
		args: [distEntry]
	};
	const sourceEntry = path.join(openClawRoot, "src", "mcp", "plugin-tools-serve.ts");
	return {
		command: process.execPath,
		args: [
			"--import",
			resolveTsxImportSpecifier(),
			sourceEntry
		]
	};
}
function resolveOpenClawToolsMcpServerConfig(moduleUrl = import.meta.url) {
	const openClawRoot = resolveOpenClawRoot(resolveAcpxPluginRoot(moduleUrl));
	const distEntry = path.join(openClawRoot, "dist", "mcp", "openclaw-tools-serve.js");
	if (fs.existsSync(distEntry)) return {
		command: process.execPath,
		args: [distEntry]
	};
	const sourceEntry = path.join(openClawRoot, "src", "mcp", "openclaw-tools-serve.ts");
	return {
		command: process.execPath,
		args: [
			"--import",
			resolveTsxImportSpecifier(),
			sourceEntry
		]
	};
}
function resolveConfiguredMcpServers(params) {
	const resolved = { ...params.mcpServers };
	if (params.pluginToolsMcpBridge && resolved[ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME]) throw new Error(`mcpServers.${ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME} is reserved when pluginToolsMcpBridge=true`);
	if (params.openClawToolsMcpBridge && resolved[ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME]) throw new Error(`mcpServers.${ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME} is reserved when openClawToolsMcpBridge=true`);
	if (params.pluginToolsMcpBridge) resolved[ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME] = resolvePluginToolsMcpServerConfig(params.moduleUrl);
	if (params.openClawToolsMcpBridge) resolved[ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME] = resolveOpenClawToolsMcpServerConfig(params.moduleUrl);
	return resolved;
}
function toAcpMcpServers(mcpServers) {
	return Object.entries(mcpServers).map(([name, server]) => ({
		name,
		command: server.command,
		args: [...server.args ?? []],
		env: Object.entries(server.env ?? {}).map(([envName, value]) => ({
			name: envName,
			value
		}))
	}));
}
function resolveAcpxPluginConfig(params) {
	const parsed = parseAcpxPluginConfig(params.rawConfig);
	if (!parsed.ok) throw new Error(parsed.message);
	const normalized = parsed.value ?? {};
	const workspaceDir = params.workspaceDir?.trim() || process.cwd();
	const fallbackCwd = workspaceDir;
	const cwd = path.resolve(normalized.cwd?.trim() || fallbackCwd);
	const stateDir = path.resolve(normalized.stateDir?.trim() || path.join(workspaceDir, "state"));
	const pluginToolsMcpBridge = normalized.pluginToolsMcpBridge === true;
	const openClawToolsMcpBridge = normalized.openClawToolsMcpBridge === true;
	const mcpServers = resolveConfiguredMcpServers({
		mcpServers: normalized.mcpServers,
		pluginToolsMcpBridge,
		openClawToolsMcpBridge,
		moduleUrl: params.moduleUrl
	});
	const agents = Object.fromEntries(Object.entries(normalized.agents ?? {}).map(([name, entry]) => {
		const cmd = entry.command.trim();
		const cmdArgs = entry.args ?? [];
		const fullCommand = cmdArgs.length > 0 ? `${cmd} ${cmdArgs.map(shellQuoteCommandArg).join(" ")}` : cmd;
		return [normalizeLowercaseStringOrEmpty(name), fullCommand];
	}));
	return {
		cwd,
		stateDir,
		probeAgent: normalizeLowercaseStringOrEmpty(normalized.probeAgent) || void 0,
		permissionMode: normalized.permissionMode ?? DEFAULT_PERMISSION_MODE,
		nonInteractivePermissions: normalized.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE_POLICY,
		pluginToolsMcpBridge,
		openClawToolsMcpBridge,
		strictWindowsCmdWrapper: normalized.strictWindowsCmdWrapper ?? DEFAULT_STRICT_WINDOWS_CMD_WRAPPER,
		timeoutSeconds: normalized.timeoutSeconds ?? 120,
		queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds ?? DEFAULT_QUEUE_OWNER_TTL_SECONDS,
		legacyCompatibilityConfig: {
			strictWindowsCmdWrapper: normalized.strictWindowsCmdWrapper,
			queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds
		},
		mcpServers,
		agents
	};
}
//#endregion
//#region extensions/acpx/src/codex-auth-bridge.ts
const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
const CODEX_ACP_BIN = "codex-acp";
const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_BIN = "claude-agent-acp";
const RUN_CONFIGURED_COMMAND_SENTINEL = "--openclaw-run-configured";
const requireFromHere = createRequire(import.meta.url);
function readSelfManifest() {
	const manifestPath = path.join(resolveAcpxPluginRoot(import.meta.url), "package.json");
	return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}
function readManifestDependencyVersion(packageName) {
	const version = readSelfManifest().dependencies?.[packageName];
	if (typeof version !== "string" || version.trim() === "") throw new Error(`Missing ${packageName} dependency version in @openclaw/acpx manifest`);
	return version;
}
const CODEX_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CODEX_ACP_PACKAGE);
const CLAUDE_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CLAUDE_ACP_PACKAGE);
function basename$1(value) {
	return value.split(/[\\/]/).pop() ?? value;
}
function resolvePackageBinPath(packageJsonPath, manifest, binName) {
	const { bin } = manifest;
	const relativeBinPath = typeof bin === "string" ? bin : bin && typeof bin === "object" ? bin[binName] : void 0;
	if (typeof relativeBinPath !== "string" || relativeBinPath.trim() === "") return;
	return path.resolve(path.dirname(packageJsonPath), relativeBinPath);
}
async function resolveInstalledAcpPackageBinPath(packageName, binName) {
	try {
		const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
		const { value: manifest } = await readJsonFileWithFallback(packageJsonPath, {});
		if (manifest.name !== packageName) return;
		const binPath = resolvePackageBinPath(packageJsonPath, manifest, binName);
		if (!binPath) return;
		await fs$1.access(binPath);
		return binPath;
	} catch {
		return;
	}
}
async function resolveInstalledCodexAcpBinPath() {
	return await resolveInstalledAcpPackageBinPath(CODEX_ACP_PACKAGE, CODEX_ACP_BIN);
}
async function resolveInstalledClaudeAcpBinPath() {
	return await resolveInstalledAcpPackageBinPath(CLAUDE_ACP_PACKAGE, CLAUDE_ACP_BIN);
}
const DIAGNOSTIC_REDACTION_RULES = [
	{
		source: String.raw`(authorization\s*[:=]\s*bearer\s+)[^\s'"<>]+`,
		flags: "gi",
		replacement: "$1[REDACTED]"
	},
	{
		source: String.raw`((?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|credential)\s*[:=]\s*)[^\s'"<>]+`,
		flags: "gi",
		replacement: "$1[REDACTED]"
	},
	{
		source: String.raw`("(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*")[^"]+`,
		flags: "g",
		replacement: "$1[REDACTED]"
	},
	{
		source: String.raw`(["']?(?:api[-_]?key|apiKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|token|secret|password|passwd|credential)["']?\s*[:=]\s*["']?)[^"',}\s<>]+`,
		flags: "gi",
		replacement: "$1[REDACTED]"
	},
	{
		source: String.raw`([?&](?:access[-_]?token|auth[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature)=)[^&\s'"<>]+`,
		flags: "gi",
		replacement: "$1[REDACTED]"
	},
	{
		source: String.raw`(--(?:api[-_]?key|token|secret|password|passwd)\s+)[^\s'"]+`,
		flags: "gi",
		replacement: "$1[REDACTED]"
	},
	{
		source: String.raw`-----BEGIN [A-Z ]*PRI` + String.raw`VATE KEY-----[\s\S]+?-----END [A-Z ]*PRI` + String.raw`VATE KEY-----`,
		flags: "g",
		replacement: "[REDACTED_PRIVATE_KEY]"
	},
	{
		source: String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
		flags: "g",
		replacement: "[REDACTED_OPENAI_KEY]"
	},
	{
		source: String.raw`\b(gh[pousr]_[A-Za-z0-9_]{20,})\b`,
		flags: "g",
		replacement: "[REDACTED_GITHUB_TOKEN]"
	},
	{
		source: String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
		flags: "g",
		replacement: "[REDACTED_GITHUB_TOKEN]"
	},
	{
		source: String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_SLACK_TOKEN]"
	},
	{
		source: String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_API_KEY]"
	},
	{
		source: String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
		flags: "g",
		replacement: "[REDACTED_GOOGLE_KEY]"
	},
	{
		source: String.raw`\b(ya29\.[0-9A-Za-z_\-./+=]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_GOOGLE_TOKEN]"
	},
	{
		source: String.raw`\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_JWT]"
	},
	{
		source: String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_API_KEY]"
	},
	{
		source: String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_NPM_TOKEN]"
	},
	{
		source: String.raw`\b(LTAI[A-Za-z0-9]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_ACCESS_KEY]"
	},
	{
		source: String.raw`\b(hf_[A-Za-z0-9]{10,})\b`,
		flags: "g",
		replacement: "[REDACTED_API_KEY]"
	},
	{
		source: String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
		flags: "g",
		replacement: "bot[REDACTED_TELEGRAM_TOKEN]"
	},
	{
		source: String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
		flags: "g",
		replacement: "[REDACTED_TELEGRAM_TOKEN]"
	}
];
function renderDiagnosticRedactionRuleSpecs() {
	return JSON.stringify(DIAGNOSTIC_REDACTION_RULES);
}
function buildAdapterWrapperScript(params) {
	return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

${params.envSetup}
const stderrLogFileNamePrefix = ${params.stderrLogFileNamePrefix ? JSON.stringify(params.stderrLogFileNamePrefix) : "undefined"};
const stderrLogMaxChars = 256 * 1024;

const openClawWrapperArgs = new Set([
  ${quoteCommandPart(OPENCLAW_ACPX_LEASE_ID_ARG)},
  ${quoteCommandPart(OPENCLAW_GATEWAY_INSTANCE_ID_ARG)},
]);

function readOpenClawWrapperArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeDiagnosticFilePart(value) {
  const sanitized = String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return sanitized || "pid-" + process.pid;
}

function resolveStderrLogPath(args) {
  if (!stderrLogFileNamePrefix) {
    return undefined;
  }
  const leaseId =
    process.env[${JSON.stringify(OPENCLAW_ACPX_LEASE_ID_ENV)}] ||
    readOpenClawWrapperArg(args, ${quoteCommandPart(OPENCLAW_ACPX_LEASE_ID_ARG)}) ||
    "pid-" + process.pid;
  const fileName = stderrLogFileNamePrefix + "." + safeDiagnosticFilePart(leaseId) + ".log";
  return fileURLToPath(new URL("./" + fileName, import.meta.url));
}

const diagnosticRedactionRules = ${renderDiagnosticRedactionRuleSpecs()}.map((rule) => [
  new RegExp(rule.source, rule.flags),
  rule.replacement,
]);

function redactDiagnosticText(text) {
  let redacted = text;
  for (const [pattern, replacement] of diagnosticRedactionRules) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

let pendingStderrLogText = "";
const stderrPrivateKeyEndPattern = /-----END [A-Z ]*PRIVATE KEY-----/;

function hasUnclosedPrivateKeyBlock(text) {
  let lastBeginIndex = -1;
  for (const match of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    lastBeginIndex = match.index ?? lastBeginIndex;
  }
  if (lastBeginIndex === -1) {
    return -1;
  }
  return stderrPrivateKeyEndPattern.test(text.slice(lastBeginIndex)) ? -1 : lastBeginIndex;
}

function writeRedactedStderrLog(text) {
  if (!stderrLogPath) {
    return;
  }
  if (!text) {
    return;
  }
  try {
    appendFileSync(stderrLogPath, redactDiagnosticText(text), "utf8");
    const current = readFileSync(stderrLogPath, "utf8");
    if (current.length > stderrLogMaxChars) {
      writeFileSync(stderrLogPath, current.slice(-stderrLogMaxChars), "utf8");
    }
  } catch {
    // Stderr capture is diagnostic-only; never break the ACP adapter.
  }
}

function redactIncompletePrivateKeyTail(text) {
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(text);
  if (unclosedPrivateKeyStart === -1) {
    return text;
  }
  return text.slice(0, unclosedPrivateKeyStart) + "[REDACTED_PRIVATE_KEY]";
}

function flushFinalizedStderrLogText() {
  const lastLineBreak = pendingStderrLogText.lastIndexOf("\\n");
  if (lastLineBreak === -1) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = pendingStderrLogText.slice(-stderrLogMaxChars);
    }
    return;
  }
  let flushEnd = lastLineBreak + 1;
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(
    pendingStderrLogText.slice(0, flushEnd),
  );
  if (unclosedPrivateKeyStart !== -1) {
    flushEnd = unclosedPrivateKeyStart;
  }
  if (flushEnd <= 0) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = pendingStderrLogText.slice(-stderrLogMaxChars);
    }
    return;
  }
  const finalizedText = pendingStderrLogText.slice(0, flushEnd);
  pendingStderrLogText = pendingStderrLogText.slice(flushEnd);
  writeRedactedStderrLog(finalizedText);
}

function appendStderrLog(chunk) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (!text) {
    return;
  }
  pendingStderrLogText += text;
  flushFinalizedStderrLogText();
}

function finishStderrLog() {
  const text = redactIncompletePrivateKeyTail(pendingStderrLogText);
  pendingStderrLogText = "";
  writeRedactedStderrLog(text);
}

function stripOpenClawWrapperArgs(args) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (openClawWrapperArgs.has(value)) {
      index += 1;
      continue;
    }
    stripped.push(value);
  }
  return stripped;
}

const rawConfiguredArgs = process.argv.slice(2);
const stderrLogPath = resolveStderrLogPath(rawConfiguredArgs);

try {
  if (stderrLogPath) {
    writeFileSync(stderrLogPath, "", "utf8");
  }
} catch {
  // Stderr capture is diagnostic-only; never break the ACP adapter.
}

const configuredArgs = stripOpenClawWrapperArgs(rawConfiguredArgs);

function resolveNpmCliPath() {
  const candidate = path.resolve(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(candidate) ? candidate : undefined;
}

const npmCliPath = resolveNpmCliPath();
const installedBinPath = ${params.installedBinPath ? quoteCommandPart(params.installedBinPath) : "undefined"};
let defaultCommand;
let defaultArgs;
if (installedBinPath) {
  defaultCommand = process.execPath;
  defaultArgs = [installedBinPath];
} else if (npmCliPath) {
  defaultCommand = process.execPath;
  defaultArgs = [npmCliPath, "exec", "--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
} else {
  defaultCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  defaultArgs = ["--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
}
const command =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}" ? configuredArgs[1] : defaultCommand;
const args =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}"
    ? configuredArgs.slice(2)
    : [...defaultArgs, ...configuredArgs];

if (!command) {
  console.error("[openclaw] missing configured ${params.displayName} ACP command");
  process.exit(1);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  env,
  stdio: ["inherit", "inherit", "pipe"],
  windowsHide: true,
});

child.stderr?.on("data", (chunk) => {
  appendStderrLog(chunk);
  process.stderr.write(chunk);
});

let forceKillTimer;
let orphanCleanupStarted = false;
let childExitCode = 1;

function killChildTree(signal, options = {}) {
  if (!child.pid || (!options.force && child.killed)) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      // The adapter can spawn grandchildren; signaling the process group keeps
      // the generated wrapper from leaving an ACP tree behind.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to direct child signaling below.
    }
  }
  child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    killChildTree(signal);
  });
}

const originalParentPid = process.ppid;
const parentWatcher =
  process.platform === "win32"
    ? undefined
    : setInterval(() => {
        if (process.ppid === originalParentPid || process.ppid !== 1) {
          return;
        }
        if (orphanCleanupStarted) {
          return;
        }
        orphanCleanupStarted = true;
        if (parentWatcher) {
          clearInterval(parentWatcher);
        }
        killChildTree("SIGTERM");
        // Keep the wrapper alive long enough for stubborn adapters to receive
        // a forced fallback signal after SIGTERM.
        forceKillTimer = setTimeout(() => {
          killChildTree("SIGKILL", { force: true });
          childExitCode = 1;
        }, 1_500);
      }, 1_000);
parentWatcher?.unref?.();

child.on("error", (error) => {
  console.error(\`[openclaw] failed to launch ${params.displayName} ACP wrapper: \${error.message}\`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (parentWatcher) {
    clearInterval(parentWatcher);
  }
  if (orphanCleanupStarted) {
    return;
  }
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }
  if (code !== null) {
    childExitCode = code;
    return;
  }
  childExitCode = signal ? 1 : 0;
});

child.on("close", () => {
  finishStderrLog();
  process.exit(childExitCode);
});
`;
}
function buildCodexAcpWrapperScript(installedBinPath) {
	return buildAdapterWrapperScript({
		displayName: "Codex",
		packageSpec: `${CODEX_ACP_PACKAGE}@${CODEX_ACP_PACKAGE_VERSION}`,
		binName: CODEX_ACP_BIN,
		installedBinPath,
		stderrLogFileNamePrefix: "codex-acp-wrapper.stderr",
		envSetup: `const codexHome = fileURLToPath(new URL("./codex-home/", import.meta.url));
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
};`
	});
}
function buildClaudeAcpWrapperScript(installedBinPath) {
	return buildAdapterWrapperScript({
		displayName: "Claude",
		packageSpec: `${CLAUDE_ACP_PACKAGE}@${CLAUDE_ACP_PACKAGE_VERSION}`,
		binName: CLAUDE_ACP_BIN,
		installedBinPath,
		envSetup: `const env = {
  ...process.env,
};`
	});
}
async function readSourceCodexConfig(codexHome) {
	try {
		return await fs$1.readFile(path.join(codexHome, "config.toml"), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
}
async function prepareIsolatedCodexHome(params) {
	const sourceConfig = await readSourceCodexConfig(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
	const trustedProjectPaths = [...sourceConfig ? extractTrustedCodexProjectPaths(sourceConfig) : [], params.workspaceDir];
	const codexHome = path.join(params.baseDir, "codex-home");
	await fs$1.mkdir(codexHome, { recursive: true });
	await fs$1.writeFile(path.join(codexHome, "config.toml"), renderIsolatedCodexConfig({
		sourceConfigToml: sourceConfig,
		projectPaths: trustedProjectPaths
	}), "utf8");
	return codexHome;
}
async function makeGeneratedWrapperExecutableIfPossible(wrapperPath) {
	try {
		await fs$1.chmod(wrapperPath, 493);
	} catch {}
}
async function writeCodexAcpWrapper(baseDir, installedBinPath) {
	await fs$1.mkdir(baseDir, { recursive: true });
	const wrapperPath = path.join(baseDir, "codex-acp-wrapper.mjs");
	await fs$1.writeFile(wrapperPath, buildCodexAcpWrapperScript(installedBinPath), { encoding: "utf8" });
	await makeGeneratedWrapperExecutableIfPossible(wrapperPath);
	return wrapperPath;
}
async function writeClaudeAcpWrapper(baseDir, installedBinPath) {
	await fs$1.mkdir(baseDir, { recursive: true });
	const wrapperPath = path.join(baseDir, "claude-agent-acp-wrapper.mjs");
	await fs$1.writeFile(wrapperPath, buildClaudeAcpWrapperScript(installedBinPath), { encoding: "utf8" });
	await makeGeneratedWrapperExecutableIfPossible(wrapperPath);
	return wrapperPath;
}
function buildWrapperCommand(wrapperPath, args = []) {
	return [
		process.execPath,
		wrapperPath,
		...args
	].map(quoteCommandPart).join(" ");
}
function isAcpPackageSpec(value, packageName) {
	const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escapedPackageName}(?:@.+)?$`, "i").test(value.trim());
}
function isAcpBinName(value, binName) {
	const commandName = basename$1(value);
	const escapedBinName = binName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escapedBinName}(?:\\.exe|\\.[cm]?js)?$`, "i").test(commandName);
}
function isPackageRunnerCommand(value) {
	return /^(?:npx|npm|pnpm|bunx)(?:\.cmd|\.exe)?$/i.test(basename$1(value));
}
function extractConfiguredAdapterArgs(params) {
	const trimmedConfiguredCommand = params.configuredCommand?.trim();
	if (!trimmedConfiguredCommand) return [];
	const parts = splitCommandParts(trimmedConfiguredCommand);
	if (!parts.length) return [];
	const packageIndex = parts.findIndex((part) => isAcpPackageSpec(part, params.packageName));
	if (packageIndex >= 0) {
		if (!isPackageRunnerCommand(parts[0] ?? "")) return;
		const afterPackage = parts.slice(packageIndex + 1);
		if (afterPackage[0] === "--" && isAcpBinName(afterPackage[1] ?? "", params.binName)) return afterPackage.slice(2);
		if (isAcpBinName(afterPackage[0] ?? "", params.binName)) return afterPackage.slice(1);
		return afterPackage[0] === "--" ? afterPackage.slice(1) : afterPackage;
	}
	if (isAcpBinName(parts[0] ?? "", params.binName)) return parts.slice(1);
	if (basename$1(parts[0] ?? "") === "node" && isAcpBinName(parts[1] ?? "", params.binName)) return parts.slice(2);
}
function buildCodexAcpWrapperCommand(wrapperPath, configuredCommand) {
	const configuredAdapterArgs = extractConfiguredAdapterArgs({
		configuredCommand,
		packageName: CODEX_ACP_PACKAGE,
		binName: CODEX_ACP_BIN
	});
	if (configuredAdapterArgs) return buildWrapperCommand(wrapperPath, configuredAdapterArgs);
	return buildWrapperCommand(wrapperPath, [RUN_CONFIGURED_COMMAND_SENTINEL, ...splitCommandParts(configuredCommand?.trim() ?? "")]);
}
function buildClaudeAcpWrapperCommand(wrapperPath, configuredCommand) {
	const configuredAdapterArgs = extractConfiguredAdapterArgs({
		configuredCommand,
		packageName: CLAUDE_ACP_PACKAGE,
		binName: CLAUDE_ACP_BIN
	});
	if (configuredAdapterArgs) return buildWrapperCommand(wrapperPath, configuredAdapterArgs);
	return configuredCommand?.trim() || buildWrapperCommand(wrapperPath);
}
async function prepareAcpxCodexAuthConfig(params) {
	params.logger;
	const codexBaseDir = path.join(params.stateDir, "acpx");
	await prepareIsolatedCodexHome({
		baseDir: codexBaseDir,
		workspaceDir: params.pluginConfig.cwd
	});
	const installedCodexBinPath = await (params.resolveInstalledCodexAcpBinPath ?? resolveInstalledCodexAcpBinPath)();
	const installedClaudeBinPath = await (params.resolveInstalledClaudeAcpBinPath ?? resolveInstalledClaudeAcpBinPath)();
	const wrapperPath = await writeCodexAcpWrapper(codexBaseDir, installedCodexBinPath);
	const claudeWrapperPath = await writeClaudeAcpWrapper(codexBaseDir, installedClaudeBinPath);
	const configuredCodexCommand = params.pluginConfig.agents.codex;
	const configuredClaudeCommand = params.pluginConfig.agents.claude;
	return {
		...params.pluginConfig,
		agents: {
			...params.pluginConfig.agents,
			codex: buildCodexAcpWrapperCommand(wrapperPath, configuredCodexCommand),
			claude: buildClaudeAcpWrapperCommand(claudeWrapperPath, configuredClaudeCommand)
		}
	};
}
//#endregion
//#region extensions/acpx/src/service.ts
const ENABLE_STARTUP_PROBE_ENV = "OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE";
const SKIP_RUNTIME_PROBE_ENV = "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE";
const ACPX_BACKEND_ID = "acpx";
let runtimeModulePromise = null;
function loadRuntimeModule() {
	runtimeModulePromise ??= import("./runtime-BY4zyHR_.js");
	return runtimeModulePromise;
}
function createDeferredResult() {
	let resolve;
	let reject;
	return {
		promise: new Promise((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		}),
		resolve,
		reject
	};
}
var LegacyRunTurnEventQueue = class {
	constructor() {
		this.items = [];
		this.waits = [];
		this.closed = false;
	}
	push(item) {
		if (this.closed) return;
		const waiter = this.waits.shift();
		if (waiter) {
			waiter.resolve(item);
			return;
		}
		this.items.push(item);
	}
	clear() {
		this.items.length = 0;
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		for (const waiter of this.waits.splice(0)) waiter.resolve(null);
	}
	fail(error) {
		if (this.closed) return;
		this.error = error;
		this.closed = true;
		for (const waiter of this.waits.splice(0)) waiter.reject(error);
	}
	async next() {
		const item = this.items.shift();
		if (item) return item;
		if (this.error) throw this.error;
		if (this.closed) return null;
		return await new Promise((resolve, reject) => {
			this.waits.push({
				resolve,
				reject
			});
		});
	}
	async *iterate() {
		for (;;) {
			const item = await this.next();
			if (!item) return;
			yield item;
		}
	}
};
function legacyRunTurnAsStartTurn(runtime, input) {
	const result = createDeferredResult();
	result.promise.catch(() => {});
	const queue = new LegacyRunTurnEventQueue();
	let resultSettled = false;
	const settleResult = (next) => {
		if (resultSettled) return;
		resultSettled = true;
		result.resolve(next);
	};
	(async () => {
		try {
			for await (const event of runtime.runTurn(input)) {
				if (event.type === "done") {
					settleResult({
						status: "completed",
						...event.stopReason ? { stopReason: event.stopReason } : {}
					});
					continue;
				}
				if (event.type === "error") {
					settleResult({
						status: "failed",
						error: {
							message: event.message,
							...event.code ? { code: event.code } : {},
							...event.detailCode ? { detailCode: event.detailCode } : {},
							...event.retryable === void 0 ? {} : { retryable: event.retryable }
						}
					});
					continue;
				}
				queue.push(event);
			}
			settleResult({
				status: "failed",
				error: {
					code: "ACP_TURN_FAILED",
					message: "ACP turn ended without a terminal done event."
				}
			});
		} catch (error) {
			result.reject(error);
			queue.fail(error);
			return;
		}
		queue.close();
	})();
	return {
		requestId: input.requestId,
		events: queue.iterate(),
		result: result.promise,
		async cancel(inputArgs) {
			await runtime.cancel({
				handle: input.handle,
				reason: inputArgs?.reason
			});
		},
		async closeStream() {
			queue.clear();
			queue.close();
		}
	};
}
function startRuntimeTurn(runtime, input) {
	return runtime.startTurn?.(input) ?? legacyRunTurnAsStartTurn(runtime, input);
}
function createLazyDefaultRuntime(params) {
	let runtime = null;
	let runtimePromise = null;
	async function resolveRuntime() {
		if (runtime) return runtime;
		runtimePromise ??= loadRuntimeModule().then((module) => {
			runtime = new module.AcpxRuntime({
				cwd: params.pluginConfig.cwd,
				openclawGatewayInstanceId: params.gatewayInstanceId,
				openclawProcessLeaseStore: params.processLeaseStore,
				openclawWrapperRoot: params.wrapperRoot,
				sessionStore: module.createFileSessionStore({ stateDir: params.pluginConfig.stateDir }),
				agentRegistry: module.createAgentRegistry({ overrides: params.pluginConfig.agents }),
				probeAgent: params.pluginConfig.probeAgent,
				mcpServers: toAcpMcpServers(params.pluginConfig.mcpServers),
				permissionMode: params.pluginConfig.permissionMode,
				nonInteractivePermissions: params.pluginConfig.nonInteractivePermissions,
				timeoutMs: params.pluginConfig.timeoutSeconds != null ? params.pluginConfig.timeoutSeconds * 1e3 : void 0
			});
			return runtime;
		});
		return await runtimePromise;
	}
	return {
		async ensureSession(input) {
			return await (await resolveRuntime()).ensureSession(input);
		},
		startTurn(input) {
			const turnPromise = resolveRuntime().then((resolved) => startRuntimeTurn(resolved, input));
			return {
				requestId: input.requestId,
				events: { async *[Symbol.asyncIterator]() {
					yield* (await turnPromise).events;
				} },
				result: turnPromise.then((turn) => turn.result),
				cancel(inputArgs) {
					return turnPromise.then((turn) => turn.cancel(inputArgs));
				},
				closeStream(inputArgs) {
					return turnPromise.then((turn) => turn.closeStream(inputArgs));
				}
			};
		},
		async *runTurn(input) {
			yield* (await resolveRuntime()).runTurn(input);
		},
		async getCapabilities(input) {
			return await (await resolveRuntime()).getCapabilities?.(input) ?? { controls: [] };
		},
		async getStatus(input) {
			return await (await resolveRuntime()).getStatus?.(input) ?? {};
		},
		async setMode(input) {
			await (await resolveRuntime()).setMode?.(input);
		},
		async setConfigOption(input) {
			await (await resolveRuntime()).setConfigOption?.(input);
		},
		async doctor() {
			return await (await resolveRuntime()).doctor?.() ?? {
				ok: true,
				message: "ok"
			};
		},
		async prepareFreshSession(input) {
			await (await resolveRuntime()).prepareFreshSession?.(input);
		},
		async cancel(input) {
			await (await resolveRuntime()).cancel(input);
		},
		async close(input) {
			await (await resolveRuntime()).close(input);
		},
		async probeAvailability() {
			await (await resolveRuntime()).probeAvailability();
		},
		isHealthy() {
			return runtime?.isHealthy() ?? false;
		}
	};
}
function warnOnIgnoredLegacyCompatibilityConfig(params) {
	const ignoredFields = [];
	if (params.pluginConfig.legacyCompatibilityConfig.queueOwnerTtlSeconds != null) ignoredFields.push("queueOwnerTtlSeconds");
	if (params.pluginConfig.legacyCompatibilityConfig.strictWindowsCmdWrapper === false) ignoredFields.push("strictWindowsCmdWrapper=false");
	if (ignoredFields.length === 0) return;
	params.logger?.warn(`embedded acpx runtime ignores legacy compatibility config: ${ignoredFields.join(", ")}`);
}
function formatDoctorDetail(detail) {
	if (!detail) return null;
	if (typeof detail === "string") return detail.trim() || null;
	if (detail instanceof Error) return formatErrorMessage(detail);
	if (typeof detail === "object") try {
		return JSON.stringify(detail) ?? inspect(detail, {
			breakLength: Infinity,
			depth: 3
		});
	} catch {
		return inspect(detail, {
			breakLength: Infinity,
			depth: 3
		});
	}
	if (typeof detail === "number" || typeof detail === "boolean" || typeof detail === "bigint" || typeof detail === "symbol") return detail.toString();
	return inspect(detail, {
		breakLength: Infinity,
		depth: 3
	});
}
function formatDoctorFailureMessage(report) {
	const detailText = report.details?.map(formatDoctorDetail).filter(Boolean).join("; ").trim();
	return detailText ? `${report.message} (${detailText})` : report.message;
}
function normalizeProbeAgent(value) {
	const normalized = value?.trim().toLowerCase();
	return normalized ? normalized : void 0;
}
function resolveAllowedAgentsProbeAgent(ctx) {
	for (const agent of ctx.config.acp?.allowedAgents ?? []) {
		const normalized = normalizeProbeAgent(agent);
		if (normalized) return normalized;
	}
}
async function measureAcpxStartup(ctx, name, run) {
	return ctx.startupTrace ? await ctx.startupTrace.measure(name, run) : await run();
}
function detailAcpxStartup(ctx, name, metrics) {
	ctx.startupTrace?.detail?.(name, metrics);
}
function shouldRunStartupProbe(env = process.env) {
	return env[ENABLE_STARTUP_PROBE_ENV] !== "0";
}
function shouldProbeRuntimeAtStartup(env = process.env) {
	return shouldRunStartupProbe(env) && env[SKIP_RUNTIME_PROBE_ENV] !== "1";
}
async function withStartupProbeTimeout(params) {
	let timeout;
	const timeoutMs = Math.max(1, params.timeoutSeconds * 1e3);
	try {
		return await Promise.race([params.promise, new Promise((_, reject) => {
			timeout = setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`embedded acpx runtime backend startup probe timed out after ${params.timeoutSeconds}s`));
			}, timeoutMs);
			timeout.unref?.();
		})]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
async function resolveGatewayInstanceId(stateDir) {
	const filePath = path.join(stateDir, "gateway-instance-id");
	try {
		const existing = (await fs$1.readFile(filePath, "utf8")).trim();
		if (existing) return existing;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const next = randomUUID();
	await fs$1.mkdir(stateDir, { recursive: true });
	await fs$1.writeFile(filePath, `${next}\n`, { mode: 384 });
	return next;
}
async function reapOpenAcpxProcessLeases(params) {
	const leases = await params.leaseStore.listOpen(params.gatewayInstanceId);
	const inspectedPids = [];
	const terminatedPids = [];
	const pendingLeaseRootResults = /* @__PURE__ */ new Map();
	for (const lease of leases) {
		if (lease.rootPid <= 0) {
			await params.leaseStore.markState(lease.leaseId, "closing");
			let result = pendingLeaseRootResults.get(lease.wrapperRoot);
			if (!result) {
				result = await reapStaleOpenClawOwnedAcpxOrphans({
					wrapperRoot: lease.wrapperRoot,
					deps: params.deps
				});
				pendingLeaseRootResults.set(lease.wrapperRoot, result);
				inspectedPids.push(...result.inspectedPids);
				terminatedPids.push(...result.terminatedPids);
			}
			await params.leaseStore.markState(lease.leaseId, result.terminatedPids.length > 0 ? "closed" : "lost");
			continue;
		}
		await params.leaseStore.markState(lease.leaseId, "closing");
		const result = await cleanupOpenClawOwnedAcpxProcessTree({
			rootPid: lease.rootPid,
			expectedLeaseId: lease.leaseId,
			expectedGatewayInstanceId: lease.gatewayInstanceId,
			wrapperRoot: lease.wrapperRoot,
			deps: params.deps
		});
		inspectedPids.push(...result.inspectedPids);
		terminatedPids.push(...result.terminatedPids);
		await params.leaseStore.markState(lease.leaseId, result.terminatedPids.length > 0 ? "closed" : "lost");
	}
	return {
		inspectedPids,
		terminatedPids
	};
}
function createAcpxRuntimeService(params = {}) {
	let runtime = null;
	let lifecycleRevision = 0;
	return {
		id: "acpx-runtime",
		async start(ctx) {
			if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME === "1") {
				ctx.logger.info("skipping embedded acpx runtime backend (OPENCLAW_SKIP_ACPX_RUNTIME=1)");
				return;
			}
			const basePluginConfig = await measureAcpxStartup(ctx, "config.resolve", () => resolveAcpxPluginConfig({
				rawConfig: params.pluginConfig,
				workspaceDir: ctx.workspaceDir
			}));
			const effectiveBasePluginConfig = {
				...basePluginConfig,
				probeAgent: basePluginConfig.probeAgent ?? resolveAllowedAgentsProbeAgent(ctx)
			};
			const pluginConfig = await measureAcpxStartup(ctx, "config.prepare-codex-auth", () => prepareAcpxCodexAuthConfig({
				pluginConfig: effectiveBasePluginConfig,
				stateDir: ctx.stateDir,
				logger: ctx.logger
			}));
			const wrapperRoot = path.join(ctx.stateDir, "acpx");
			await measureAcpxStartup(ctx, "filesystem.prepare", async () => {
				await fs$1.mkdir(pluginConfig.stateDir, { recursive: true });
				await fs$1.mkdir(wrapperRoot, { recursive: true });
			});
			const gatewayInstanceId = await measureAcpxStartup(ctx, "gateway-instance-id", () => resolveGatewayInstanceId(ctx.stateDir));
			const processLeaseStore = createAcpxProcessLeaseStore({ stateDir: wrapperRoot });
			const startupReap = await measureAcpxStartup(ctx, "process-leases.reap", () => reapOpenAcpxProcessLeases({
				gatewayInstanceId,
				leaseStore: processLeaseStore,
				deps: params.processCleanupDeps
			}));
			if (startupReap.terminatedPids.length > 0) ctx.logger.info(`reaped ${startupReap.terminatedPids.length} stale OpenClaw-owned ACPX process${startupReap.terminatedPids.length === 1 ? "" : "es"}`);
			warnOnIgnoredLegacyCompatibilityConfig({
				pluginConfig,
				logger: ctx.logger
			});
			const startedRuntime = await measureAcpxStartup(ctx, "runtime.create", () => params.runtimeFactory ? params.runtimeFactory({
				pluginConfig,
				gatewayInstanceId,
				processLeaseStore,
				wrapperRoot,
				logger: ctx.logger
			}) : createLazyDefaultRuntime({
				pluginConfig,
				gatewayInstanceId,
				processLeaseStore,
				wrapperRoot,
				logger: ctx.logger
			}));
			runtime = startedRuntime;
			const shouldProbeRuntime = shouldProbeRuntimeAtStartup();
			detailAcpxStartup(ctx, "probe-policy", [["startupProbeEnabledCount", shouldProbeRuntime ? 1 : 0], ["probeAgent", pluginConfig.probeAgent ?? "default"]]);
			await measureAcpxStartup(ctx, "backend.register", () => {
				registerAcpRuntimeBackend({
					id: ACPX_BACKEND_ID,
					runtime: startedRuntime,
					...shouldProbeRuntime ? { healthy: () => runtime?.isHealthy() ?? false } : {}
				});
				ctx.logger.info(`embedded acpx runtime backend registered (cwd: ${pluginConfig.cwd})`);
			});
			if (!shouldProbeRuntime) return;
			lifecycleRevision += 1;
			const currentRevision = lifecycleRevision;
			try {
				await measureAcpxStartup(ctx, "probe.availability", () => withStartupProbeTimeout({
					promise: startedRuntime.probeAvailability(),
					timeoutSeconds: pluginConfig.timeoutSeconds ?? 120
				}));
				if (currentRevision !== lifecycleRevision) return;
				if (startedRuntime.isHealthy()) {
					detailAcpxStartup(ctx, "probe.result", [["healthyCount", 1]]);
					ctx.logger.info("embedded acpx runtime backend ready");
					return;
				}
				const doctorReport = await measureAcpxStartup(ctx, "probe.doctor", () => startedRuntime.doctor?.());
				if (currentRevision !== lifecycleRevision) return;
				detailAcpxStartup(ctx, "probe.result", [["healthyCount", 0]]);
				ctx.logger.warn(`embedded acpx runtime backend probe failed: ${doctorReport ? formatDoctorFailureMessage(doctorReport) : "backend remained unhealthy after probe"}`);
			} catch (err) {
				if (currentRevision !== lifecycleRevision) return;
				detailAcpxStartup(ctx, "probe.result", [["healthyCount", 0]]);
				ctx.logger.warn(`embedded acpx runtime setup failed: ${formatErrorMessage(err)}`);
			}
		},
		async stop(_ctx) {
			lifecycleRevision += 1;
			unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
			runtime = null;
		}
	};
}
//#endregion
export { createAcpxRuntimeService };
