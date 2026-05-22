import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { a as unregisterAcpRuntimeBackend, r as registerAcpRuntimeBackend } from "./registry-BgRpFBbZ.js";
import "./text-runtime-icMZVCaq.js";
import "./error-runtime-B9i9dR6-.js";
import { s as formatPluginConfigIssue } from "./extension-shared-CGFuE4qV.js";
import { t as zod_exports } from "./zod-T1E2m_oP.js";
import "./runtime-api-BnY99r81.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { inspect } from "node:util";
//#region extensions/acpx/src/codex-auth-bridge.ts
const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
const CODEX_ACP_PACKAGE_RANGE = "^0.12.0";
const CODEX_ACP_BIN = "codex-acp";
const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_PACKAGE_VERSION = "0.31.4";
const CLAUDE_ACP_BIN = "claude-agent-acp";
const RUN_CONFIGURED_COMMAND_SENTINEL = "--openclaw-run-configured";
const requireFromHere$1 = createRequire(import.meta.url);
function quoteCommandPart(value) {
	return JSON.stringify(value);
}
function splitCommandParts(value) {
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
			if (current) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (escaping) current += "\\";
	if (current) parts.push(current);
	return parts;
}
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
		const packageJsonPath = requireFromHere$1.resolve(`${packageName}/package.json`);
		const manifest = JSON.parse(await fs$1.readFile(packageJsonPath, "utf8"));
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
function buildAdapterWrapperScript(params) {
	return `#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

${params.envSetup}
const configuredArgs = process.argv.slice(2);

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
  env,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(\`[openclaw] failed to launch ${params.displayName} ACP wrapper: \${error.message}\`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (code !== null) {
    process.exit(code);
  }
  process.exit(signal ? 1 : 0);
});
`;
}
function buildCodexAcpWrapperScript(installedBinPath) {
	return buildAdapterWrapperScript({
		displayName: "Codex",
		packageSpec: `${CODEX_ACP_PACKAGE}@${CODEX_ACP_PACKAGE_RANGE}`,
		binName: CODEX_ACP_BIN,
		installedBinPath,
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
async function prepareIsolatedCodexHome(baseDir) {
	const codexHome = path.join(baseDir, "codex-home");
	await fs$1.mkdir(codexHome, { recursive: true });
	await fs$1.writeFile(path.join(codexHome, "config.toml"), "# Generated by OpenClaw for Codex ACP sessions.\n", "utf8");
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
	await prepareIsolatedCodexHome(codexBaseDir);
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
//#region extensions/acpx/src/config-schema.ts
const ACPX_PERMISSION_MODES = [
	"approve-all",
	"approve-reads",
	"deny-all"
];
const ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"];
const nonEmptyTrimmedString = (message) => zod_exports.z.string({ error: message }).trim().min(1, { error: message });
const McpServerConfigSchema = zod_exports.z.object({
	command: nonEmptyTrimmedString("command must be a non-empty string").describe("Command to run the MCP server"),
	args: zod_exports.z.array(zod_exports.z.string({ error: "args must be an array of strings" }), { error: "args must be an array of strings" }).optional().describe("Arguments to pass to the command"),
	env: zod_exports.z.record(zod_exports.z.string(), zod_exports.z.string({ error: "env values must be strings" }), { error: "env must be an object of strings" }).optional().describe("Environment variables for the MCP server")
});
const AcpxPluginConfigSchema = zod_exports.z.strictObject({
	cwd: nonEmptyTrimmedString("cwd must be a non-empty string").optional(),
	stateDir: nonEmptyTrimmedString("stateDir must be a non-empty string").optional(),
	probeAgent: nonEmptyTrimmedString("probeAgent must be a non-empty string").optional(),
	permissionMode: zod_exports.z.enum(ACPX_PERMISSION_MODES, { error: `permissionMode must be one of: ${ACPX_PERMISSION_MODES.join(", ")}` }).optional(),
	nonInteractivePermissions: zod_exports.z.enum(ACPX_NON_INTERACTIVE_POLICIES, { error: `nonInteractivePermissions must be one of: ${ACPX_NON_INTERACTIVE_POLICIES.join(", ")}` }).optional(),
	pluginToolsMcpBridge: zod_exports.z.boolean({ error: "pluginToolsMcpBridge must be a boolean" }).optional(),
	openClawToolsMcpBridge: zod_exports.z.boolean({ error: "openClawToolsMcpBridge must be a boolean" }).optional(),
	strictWindowsCmdWrapper: zod_exports.z.boolean({ error: "strictWindowsCmdWrapper must be a boolean" }).optional(),
	timeoutSeconds: zod_exports.z.number({ error: "timeoutSeconds must be a number >= 0.001" }).min(.001, { error: "timeoutSeconds must be a number >= 0.001" }).default(120),
	queueOwnerTtlSeconds: zod_exports.z.number({ error: "queueOwnerTtlSeconds must be a number >= 0" }).min(0, { error: "queueOwnerTtlSeconds must be a number >= 0" }).optional(),
	mcpServers: zod_exports.z.record(zod_exports.z.string(), McpServerConfigSchema).optional(),
	agents: zod_exports.z.record(zod_exports.z.string(), zod_exports.z.strictObject({ command: nonEmptyTrimmedString("agents.<id>.command must be a non-empty string") })).optional()
});
//#endregion
//#region extensions/acpx/src/config.ts
const ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME = "openclaw-plugin-tools";
const ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME = "openclaw-tools";
const requireFromHere = createRequire(import.meta.url);
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
		return requireFromHere.resolve("tsx");
	} catch {
		return "tsx";
	}
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
	const agents = Object.fromEntries(Object.entries(normalized.agents ?? {}).map(([name, entry]) => [normalizeLowercaseStringOrEmpty(name), entry.command.trim()]));
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
//#region extensions/acpx/src/service.ts
const ENABLE_STARTUP_PROBE_ENV = "OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE";
const ACPX_BACKEND_ID = "acpx";
let runtimeModulePromise = null;
function loadRuntimeModule() {
	runtimeModulePromise ??= import("./runtime-CRWyuU8y.js");
	return runtimeModulePromise;
}
function createLazyDefaultRuntime(params) {
	let runtime = null;
	let runtimePromise = null;
	async function resolveRuntime() {
		if (runtime) return runtime;
		runtimePromise ??= loadRuntimeModule().then((module) => {
			runtime = new module.AcpxRuntime({
				cwd: params.pluginConfig.cwd,
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
function shouldRunStartupProbe(env = process.env) {
	return env[ENABLE_STARTUP_PROBE_ENV] === "1";
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
			const basePluginConfig = resolveAcpxPluginConfig({
				rawConfig: params.pluginConfig,
				workspaceDir: ctx.workspaceDir
			});
			const pluginConfig = await prepareAcpxCodexAuthConfig({
				pluginConfig: {
					...basePluginConfig,
					probeAgent: basePluginConfig.probeAgent ?? resolveAllowedAgentsProbeAgent(ctx)
				},
				stateDir: ctx.stateDir,
				logger: ctx.logger
			});
			await fs$1.mkdir(pluginConfig.stateDir, { recursive: true });
			warnOnIgnoredLegacyCompatibilityConfig({
				pluginConfig,
				logger: ctx.logger
			});
			runtime = params.runtimeFactory ? await params.runtimeFactory({
				pluginConfig,
				logger: ctx.logger
			}) : createLazyDefaultRuntime({
				pluginConfig,
				logger: ctx.logger
			});
			registerAcpRuntimeBackend({
				id: ACPX_BACKEND_ID,
				runtime,
				...shouldRunStartupProbe() ? { healthy: () => runtime?.isHealthy() ?? false } : {}
			});
			ctx.logger.info(`embedded acpx runtime backend registered (cwd: ${pluginConfig.cwd})`);
			if (!shouldRunStartupProbe() || process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE === "1") return;
			lifecycleRevision += 1;
			const currentRevision = lifecycleRevision;
			(async () => {
				try {
					await runtime?.probeAvailability();
					if (currentRevision !== lifecycleRevision) return;
					if (runtime?.isHealthy()) {
						ctx.logger.info("embedded acpx runtime backend ready");
						return;
					}
					const doctorReport = await runtime?.doctor?.();
					if (currentRevision !== lifecycleRevision) return;
					ctx.logger.warn(`embedded acpx runtime backend probe failed: ${doctorReport ? formatDoctorFailureMessage(doctorReport) : "backend remained unhealthy after probe"}`);
				} catch (err) {
					if (currentRevision !== lifecycleRevision) return;
					ctx.logger.warn(`embedded acpx runtime setup failed: ${formatErrorMessage(err)}`);
				}
			})();
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
