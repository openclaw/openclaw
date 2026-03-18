import { c as unregisterAcpRuntimeBackend, i as omitEnvKeysCaseInsensitive, o as registerAcpRuntimeBackend, r as listKnownProviderAuthEnvVarNames, u as AcpRuntimeError } from "../../provider-env-vars-BfZUtZAn.js";
import { i as resolveWindowsSpawnProgramCandidate, n as materializeWindowsSpawnProgram, t as applyWindowsSpawnProgramPolicy } from "../../windows-spawn-BDUzfT2H.js";
import fs, { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
//#region extensions/acpx/src/config.ts
const ACPX_PERMISSION_MODES = [
	"approve-all",
	"approve-reads",
	"deny-all"
];
const ACPX_NON_INTERACTIVE_POLICIES = ["deny", "fail"];
const ACPX_PINNED_VERSION = "0.1.16";
const ACPX_BIN_NAME = process.platform === "win32" ? "acpx.cmd" : "acpx";
function resolveAcpxPluginRoot(moduleUrl = import.meta.url) {
	let cursor = path.dirname(fileURLToPath(moduleUrl));
	for (let i = 0; i < 3; i += 1) {
		if (fs.existsSync(path.join(cursor, "openclaw.plugin.json")) && fs.existsSync(path.join(cursor, "package.json"))) return cursor;
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}
const ACPX_PLUGIN_ROOT = resolveAcpxPluginRoot();
const ACPX_BUNDLED_BIN = path.join(ACPX_PLUGIN_ROOT, "node_modules", ".bin", ACPX_BIN_NAME);
function buildAcpxLocalInstallCommand(version = ACPX_PINNED_VERSION) {
	return `npm install --omit=dev --no-save acpx@${version}`;
}
buildAcpxLocalInstallCommand();
const DEFAULT_PERMISSION_MODE = "approve-reads";
const DEFAULT_NON_INTERACTIVE_POLICY = "fail";
const DEFAULT_QUEUE_OWNER_TTL_SECONDS = .1;
const DEFAULT_STRICT_WINDOWS_CMD_WRAPPER = true;
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPermissionMode(value) {
	return ACPX_PERMISSION_MODES.includes(value);
}
function isNonInteractivePermissionPolicy(value) {
	return ACPX_NON_INTERACTIVE_POLICIES.includes(value);
}
function isMcpServerConfig(value) {
	if (!isRecord$1(value)) return false;
	if (typeof value.command !== "string" || value.command.trim() === "") return false;
	if (value.args !== void 0) {
		if (!Array.isArray(value.args)) return false;
		for (const arg of value.args) if (typeof arg !== "string") return false;
	}
	if (value.env !== void 0) {
		if (!isRecord$1(value.env)) return false;
		for (const envValue of Object.values(value.env)) if (typeof envValue !== "string") return false;
	}
	return true;
}
function parseAcpxPluginConfig(value) {
	if (value === void 0) return {
		ok: true,
		value: void 0
	};
	if (!isRecord$1(value)) return {
		ok: false,
		message: "expected config object"
	};
	const allowedKeys = new Set([
		"command",
		"expectedVersion",
		"cwd",
		"permissionMode",
		"nonInteractivePermissions",
		"strictWindowsCmdWrapper",
		"timeoutSeconds",
		"queueOwnerTtlSeconds",
		"mcpServers"
	]);
	for (const key of Object.keys(value)) if (!allowedKeys.has(key)) return {
		ok: false,
		message: `unknown config key: ${key}`
	};
	const command = value.command;
	if (command !== void 0 && (typeof command !== "string" || command.trim() === "")) return {
		ok: false,
		message: "command must be a non-empty string"
	};
	const expectedVersion = value.expectedVersion;
	if (expectedVersion !== void 0 && (typeof expectedVersion !== "string" || expectedVersion.trim() === "")) return {
		ok: false,
		message: "expectedVersion must be a non-empty string"
	};
	const cwd = value.cwd;
	if (cwd !== void 0 && (typeof cwd !== "string" || cwd.trim() === "")) return {
		ok: false,
		message: "cwd must be a non-empty string"
	};
	const permissionMode = value.permissionMode;
	if (permissionMode !== void 0 && (typeof permissionMode !== "string" || !isPermissionMode(permissionMode))) return {
		ok: false,
		message: `permissionMode must be one of: ${ACPX_PERMISSION_MODES.join(", ")}`
	};
	const nonInteractivePermissions = value.nonInteractivePermissions;
	if (nonInteractivePermissions !== void 0 && (typeof nonInteractivePermissions !== "string" || !isNonInteractivePermissionPolicy(nonInteractivePermissions))) return {
		ok: false,
		message: `nonInteractivePermissions must be one of: ${ACPX_NON_INTERACTIVE_POLICIES.join(", ")}`
	};
	const timeoutSeconds = value.timeoutSeconds;
	if (timeoutSeconds !== void 0 && (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) return {
		ok: false,
		message: "timeoutSeconds must be a positive number"
	};
	const strictWindowsCmdWrapper = value.strictWindowsCmdWrapper;
	if (strictWindowsCmdWrapper !== void 0 && typeof strictWindowsCmdWrapper !== "boolean") return {
		ok: false,
		message: "strictWindowsCmdWrapper must be a boolean"
	};
	const queueOwnerTtlSeconds = value.queueOwnerTtlSeconds;
	if (queueOwnerTtlSeconds !== void 0 && (typeof queueOwnerTtlSeconds !== "number" || !Number.isFinite(queueOwnerTtlSeconds) || queueOwnerTtlSeconds < 0)) return {
		ok: false,
		message: "queueOwnerTtlSeconds must be a non-negative number"
	};
	const mcpServers = value.mcpServers;
	if (mcpServers !== void 0) {
		if (!isRecord$1(mcpServers)) return {
			ok: false,
			message: "mcpServers must be an object"
		};
		for (const [key, serverConfig] of Object.entries(mcpServers)) if (!isMcpServerConfig(serverConfig)) return {
			ok: false,
			message: `mcpServers.${key} must have a command string, optional args array, and optional env object`
		};
	}
	return {
		ok: true,
		value: {
			command: typeof command === "string" ? command.trim() : void 0,
			expectedVersion: typeof expectedVersion === "string" ? expectedVersion.trim() : void 0,
			cwd: typeof cwd === "string" ? cwd.trim() : void 0,
			permissionMode: typeof permissionMode === "string" ? permissionMode : void 0,
			nonInteractivePermissions: typeof nonInteractivePermissions === "string" ? nonInteractivePermissions : void 0,
			strictWindowsCmdWrapper: typeof strictWindowsCmdWrapper === "boolean" ? strictWindowsCmdWrapper : void 0,
			timeoutSeconds: typeof timeoutSeconds === "number" ? timeoutSeconds : void 0,
			queueOwnerTtlSeconds: typeof queueOwnerTtlSeconds === "number" ? queueOwnerTtlSeconds : void 0,
			mcpServers
		}
	};
}
function resolveConfiguredCommand(params) {
	const configured = params.configured?.trim();
	if (!configured) return ACPX_BUNDLED_BIN;
	if (path.isAbsolute(configured) || configured.includes(path.sep) || configured.includes("/")) {
		const baseDir = params.workspaceDir?.trim() || process.cwd();
		return path.resolve(baseDir, configured);
	}
	return configured;
}
function createAcpxPluginConfigSchema() {
	return {
		safeParse(value) {
			const parsed = parseAcpxPluginConfig(value);
			if (parsed.ok) return {
				success: true,
				data: parsed.value
			};
			return {
				success: false,
				error: { issues: [{
					path: [],
					message: parsed.message
				}] }
			};
		},
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				command: { type: "string" },
				expectedVersion: { type: "string" },
				cwd: { type: "string" },
				permissionMode: {
					type: "string",
					enum: [...ACPX_PERMISSION_MODES]
				},
				nonInteractivePermissions: {
					type: "string",
					enum: [...ACPX_NON_INTERACTIVE_POLICIES]
				},
				strictWindowsCmdWrapper: { type: "boolean" },
				timeoutSeconds: {
					type: "number",
					minimum: .001
				},
				queueOwnerTtlSeconds: {
					type: "number",
					minimum: 0
				},
				mcpServers: {
					type: "object",
					additionalProperties: {
						type: "object",
						properties: {
							command: { type: "string" },
							args: {
								type: "array",
								items: { type: "string" }
							},
							env: {
								type: "object",
								additionalProperties: { type: "string" }
							}
						},
						required: ["command"]
					}
				}
			}
		}
	};
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
	const fallbackCwd = params.workspaceDir?.trim() || process.cwd();
	const cwd = path.resolve(normalized.cwd?.trim() || fallbackCwd);
	const command = resolveConfiguredCommand({
		configured: normalized.command,
		workspaceDir: params.workspaceDir
	});
	const allowPluginLocalInstall = command === ACPX_BUNDLED_BIN;
	const stripProviderAuthEnvVars = command === ACPX_BUNDLED_BIN;
	const configuredExpectedVersion = normalized.expectedVersion;
	const expectedVersion = configuredExpectedVersion === "any" ? void 0 : configuredExpectedVersion ?? (allowPluginLocalInstall ? "0.1.16" : void 0);
	return {
		command,
		expectedVersion,
		allowPluginLocalInstall,
		stripProviderAuthEnvVars,
		installCommand: buildAcpxLocalInstallCommand(expectedVersion ?? "0.1.16"),
		cwd,
		permissionMode: normalized.permissionMode ?? DEFAULT_PERMISSION_MODE,
		nonInteractivePermissions: normalized.nonInteractivePermissions ?? DEFAULT_NON_INTERACTIVE_POLICY,
		strictWindowsCmdWrapper: normalized.strictWindowsCmdWrapper ?? DEFAULT_STRICT_WINDOWS_CMD_WRAPPER,
		timeoutSeconds: normalized.timeoutSeconds,
		queueOwnerTtlSeconds: normalized.queueOwnerTtlSeconds ?? DEFAULT_QUEUE_OWNER_TTL_SECONDS,
		mcpServers: normalized.mcpServers ?? {}
	};
}
//#endregion
//#region extensions/acpx/src/runtime-internals/process.ts
const DEFAULT_RUNTIME = {
	platform: process.platform,
	env: process.env,
	execPath: process.execPath
};
function resolveSpawnCommand(params, options, runtime = DEFAULT_RUNTIME) {
	const strictWindowsCmdWrapper = options?.strictWindowsCmdWrapper === true;
	const cacheKey = params.command;
	const cachedProgram = options?.cache;
	const cacheHit = cachedProgram?.key === cacheKey && cachedProgram.candidate != null;
	let candidate = cachedProgram?.key === cacheKey && cachedProgram.candidate ? cachedProgram.candidate : void 0;
	if (!candidate) {
		candidate = resolveWindowsSpawnProgramCandidate({
			command: params.command,
			platform: runtime.platform,
			env: runtime.env,
			execPath: runtime.execPath,
			packageName: "acpx"
		});
		if (cachedProgram) {
			cachedProgram.key = cacheKey;
			cachedProgram.candidate = candidate;
		}
	}
	let program;
	try {
		program = applyWindowsSpawnProgramPolicy({
			candidate,
			allowShellFallback: !strictWindowsCmdWrapper
		});
	} catch (error) {
		options?.onResolved?.({
			command: params.command,
			cacheHit,
			strictWindowsCmdWrapper,
			resolution: candidate.resolution
		});
		throw error;
	}
	const resolved = materializeWindowsSpawnProgram(program, params.args);
	options?.onResolved?.({
		command: params.command,
		cacheHit,
		strictWindowsCmdWrapper,
		resolution: resolved.resolution
	});
	return {
		command: resolved.command,
		args: resolved.argv,
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	};
}
function createAbortError() {
	const error = /* @__PURE__ */ new Error("Operation aborted.");
	error.name = "AbortError";
	return error;
}
function spawnWithResolvedCommand(params, options) {
	const resolved = resolveSpawnCommand({
		command: params.command,
		args: params.args
	}, options);
	const childEnv = omitEnvKeysCaseInsensitive(process.env, params.stripProviderAuthEnvVars ? listKnownProviderAuthEnvVarNames() : []);
	childEnv.OPENCLAW_SHELL = "acp";
	return spawn(resolved.command, resolved.args, {
		cwd: params.cwd,
		env: childEnv,
		stdio: [
			"pipe",
			"pipe",
			"pipe"
		],
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	});
}
async function waitForExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) return {
		code: child.exitCode,
		signal: child.signalCode,
		error: null
	};
	return await new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.once("error", (err) => {
			finish({
				code: null,
				signal: null,
				error: err
			});
		});
		child.once("close", (code, signal) => {
			finish({
				code,
				signal,
				error: null
			});
		});
	});
}
async function spawnAndCollect(params, options, runtime) {
	if (runtime?.signal?.aborted) return {
		stdout: "",
		stderr: "",
		code: null,
		error: createAbortError()
	};
	const child = spawnWithResolvedCommand(params, options);
	child.stdin.end();
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	let abortKillTimer;
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		try {
			child.kill("SIGTERM");
		} catch {}
		abortKillTimer = setTimeout(() => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			try {
				child.kill("SIGKILL");
			} catch {}
		}, 250);
		abortKillTimer.unref?.();
	};
	runtime?.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const exit = await waitForExit(child);
		return {
			stdout,
			stderr,
			code: exit.code,
			error: aborted ? createAbortError() : exit.error
		};
	} finally {
		runtime?.signal?.removeEventListener("abort", onAbort);
		if (abortKillTimer) clearTimeout(abortKillTimer);
	}
}
function resolveSpawnFailure(err, cwd) {
	if (!err || typeof err !== "object") return null;
	if (err.code !== "ENOENT") return null;
	return directoryExists(cwd) ? "missing-command" : "missing-cwd";
}
function directoryExists(cwd) {
	if (!cwd) return false;
	try {
		return existsSync(cwd);
	} catch {
		return false;
	}
}
//#endregion
//#region extensions/acpx/src/ensure.ts
const SEMVER_PATTERN = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/;
function extractVersion(stdout, stderr) {
	return `${stdout}\n${stderr}`.match(SEMVER_PATTERN)?.[0] ?? null;
}
function isExpectedVersionConfigured(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function supportsPathResolution(command) {
	return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}
function isUnsupportedVersionProbe(stdout, stderr) {
	const combined = `${stdout}\n${stderr}`.toLowerCase();
	return combined.includes("unknown option") && combined.includes("--version");
}
function resolveVersionFromPackage(command, cwd) {
	if (!supportsPathResolution(command)) return null;
	const commandPath = path.isAbsolute(command) ? command : path.resolve(cwd, command);
	let current;
	try {
		current = path.dirname(fs.realpathSync(commandPath));
	} catch {
		return null;
	}
	while (true) {
		const packageJsonPath = path.join(current, "package.json");
		try {
			const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
			if (parsed.name === "acpx" && typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
function resolveVersionCheckResult(params) {
	if (params.expectedVersion && params.installedVersion !== params.expectedVersion) return {
		ok: false,
		reason: "version-mismatch",
		message: `acpx version mismatch: found ${params.installedVersion}, expected ${params.expectedVersion}`,
		expectedVersion: params.expectedVersion,
		installCommand: params.installCommand,
		installedVersion: params.installedVersion
	};
	return {
		ok: true,
		version: params.installedVersion,
		expectedVersion: params.expectedVersion
	};
}
async function checkAcpxVersion(params) {
	const expectedVersion = params.expectedVersion?.trim() || void 0;
	const installCommand = buildAcpxLocalInstallCommand(expectedVersion ?? "0.1.16");
	const cwd = params.cwd ?? ACPX_PLUGIN_ROOT;
	const hasExpectedVersion = isExpectedVersionConfigured(expectedVersion);
	const probeArgs = hasExpectedVersion ? ["--version"] : ["--help"];
	const spawnParams = {
		command: params.command,
		args: probeArgs,
		cwd,
		stripProviderAuthEnvVars: params.stripProviderAuthEnvVars
	};
	let result;
	try {
		result = params.spawnOptions ? await spawnAndCollect(spawnParams, params.spawnOptions) : await spawnAndCollect(spawnParams);
	} catch (error) {
		return {
			ok: false,
			reason: "execution-failed",
			message: error instanceof Error ? error.message : String(error),
			expectedVersion,
			installCommand
		};
	}
	if (result.error) {
		if (resolveSpawnFailure(result.error, cwd) === "missing-command") return {
			ok: false,
			reason: "missing-command",
			message: `acpx command not found at ${params.command}`,
			expectedVersion,
			installCommand
		};
		return {
			ok: false,
			reason: "execution-failed",
			message: result.error.message,
			expectedVersion,
			installCommand
		};
	}
	if ((result.code ?? 0) !== 0) {
		if (hasExpectedVersion && isUnsupportedVersionProbe(result.stdout, result.stderr)) {
			const installedVersion = resolveVersionFromPackage(params.command, cwd);
			if (installedVersion) return resolveVersionCheckResult({
				expectedVersion,
				installedVersion,
				installCommand
			});
		}
		return {
			ok: false,
			reason: "execution-failed",
			message: result.stderr.trim() || `acpx ${hasExpectedVersion ? "--version" : "--help"} failed with code ${result.code ?? "unknown"}`,
			expectedVersion,
			installCommand
		};
	}
	if (!hasExpectedVersion) return {
		ok: true,
		version: "unknown",
		expectedVersion
	};
	const installedVersion = extractVersion(result.stdout, result.stderr);
	if (!installedVersion) return {
		ok: false,
		reason: "missing-version",
		message: "acpx --version output did not include a parseable version",
		expectedVersion,
		installCommand
	};
	return resolveVersionCheckResult({
		expectedVersion,
		installedVersion,
		installCommand
	});
}
let pendingEnsure = null;
async function ensureAcpx(params) {
	if (pendingEnsure) return await pendingEnsure;
	pendingEnsure = (async () => {
		const pluginRoot = params.pluginRoot ?? ACPX_PLUGIN_ROOT;
		const expectedVersion = params.expectedVersion?.trim() || void 0;
		const installVersion = expectedVersion ?? "0.1.16";
		const allowInstall = params.allowInstall ?? true;
		const precheck = await checkAcpxVersion({
			command: params.command,
			cwd: pluginRoot,
			expectedVersion,
			stripProviderAuthEnvVars: params.stripProviderAuthEnvVars,
			spawnOptions: params.spawnOptions
		});
		if (precheck.ok) return;
		if (!allowInstall) throw new Error(precheck.message);
		params.logger?.warn(`acpx local binary unavailable or mismatched (${precheck.message}); running plugin-local install`);
		const install = await spawnAndCollect({
			command: "npm",
			args: [
				"install",
				"--omit=dev",
				"--no-save",
				`acpx@${installVersion}`
			],
			cwd: pluginRoot,
			stripProviderAuthEnvVars: params.stripProviderAuthEnvVars
		});
		if (install.error) {
			if (resolveSpawnFailure(install.error, pluginRoot) === "missing-command") throw new Error("npm is required to install plugin-local acpx but was not found on PATH");
			throw new Error(`failed to install plugin-local acpx: ${install.error.message}`);
		}
		if ((install.code ?? 0) !== 0) {
			const stderr = install.stderr.trim();
			const stdout = install.stdout.trim();
			const detail = stderr || stdout || `npm exited with code ${install.code ?? "unknown"}`;
			throw new Error(`failed to install plugin-local acpx: ${detail}`);
		}
		const postcheck = await checkAcpxVersion({
			command: params.command,
			cwd: pluginRoot,
			expectedVersion,
			stripProviderAuthEnvVars: params.stripProviderAuthEnvVars,
			spawnOptions: params.spawnOptions
		});
		if (!postcheck.ok) throw new Error(`plugin-local acpx verification failed after install: ${postcheck.message}`);
		params.logger?.info(`acpx plugin-local binary ready (version ${postcheck.version})`);
	})();
	try {
		await pendingEnsure;
	} finally {
		pendingEnsure = null;
	}
}
//#endregion
//#region extensions/acpx/src/runtime-internals/shared.ts
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
function asOptionalBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
function deriveAgentFromSessionKey(sessionKey, fallbackAgent) {
	const match = sessionKey.match(/^agent:([^:]+):/i);
	return (match?.[1] ? asTrimmedString(match[1]) : "") || fallbackAgent;
}
function buildPermissionArgs(mode) {
	if (mode === "approve-all") return ["--approve-all"];
	if (mode === "deny-all") return ["--deny-all"];
	return ["--approve-reads"];
}
//#endregion
//#region extensions/acpx/src/runtime-internals/events.ts
function toAcpxErrorEvent(value) {
	if (!isRecord(value)) return null;
	if (asTrimmedString(value.type) !== "error") return null;
	return {
		message: asTrimmedString(value.message) || "acpx reported an error",
		code: asOptionalString(value.code),
		retryable: asOptionalBoolean(value.retryable)
	};
}
function parseJsonLines(value) {
	const events = [];
	for (const line of value.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (isRecord(parsed)) events.push(parsed);
		} catch {}
	}
	return events;
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
function createToolCallEvent(params) {
	const title = asTrimmedString(params.payload.title) || "tool call";
	const status = asTrimmedString(params.payload.status);
	const toolCallId = asOptionalString(params.payload.toolCallId);
	return {
		type: "tool_call",
		text: status ? `${title} (${status})` : title,
		tag: params.tag,
		...toolCallId ? { toolCallId } : {},
		...status ? { status } : {},
		title
	};
}
function parsePromptEventLine(line) {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return {
			type: "status",
			text: trimmed
		};
	}
	if (!isRecord(parsed)) return null;
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
		case "done": return {
			type: "done",
			stopReason: asOptionalString(payload.stopReason)
		};
		case "error": return {
			type: "error",
			message: asTrimmedString(payload.message) || "acpx runtime error",
			code: asOptionalString(payload.code),
			retryable: asOptionalBoolean(payload.retryable)
		};
		default: return null;
	}
}
//#endregion
//#region extensions/acpx/src/runtime-internals/mcp-agent-command.ts
const ACPX_BUILTIN_AGENT_COMMANDS = {
	codex: "npx @zed-industries/codex-acp",
	claude: "npx -y @zed-industries/claude-agent-acp",
	gemini: "gemini",
	opencode: "npx -y opencode-ai acp",
	pi: "npx pi-acp"
};
const MCP_PROXY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mcp-proxy.mjs");
function normalizeAgentName(value) {
	return value.trim().toLowerCase();
}
function quoteCommandPart(value) {
	if (value === "") return "\"\"";
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
	return `"${value.replace(/["\\]/g, "\\$&")}"`;
}
function toCommandLine(parts) {
	return parts.map(quoteCommandPart).join(" ");
}
function readConfiguredAgentOverrides(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const overrides = {};
	for (const [name, entry] of Object.entries(value)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const command = entry.command;
		if (typeof command !== "string" || command.trim() === "") continue;
		overrides[normalizeAgentName(name)] = command.trim();
	}
	return overrides;
}
async function loadAgentOverrides(params) {
	const result = await spawnAndCollect({
		command: params.acpxCommand,
		args: [
			"--cwd",
			params.cwd,
			"config",
			"show"
		],
		cwd: params.cwd,
		stripProviderAuthEnvVars: params.stripProviderAuthEnvVars
	}, params.spawnOptions);
	if (result.error || (result.code ?? 0) !== 0) return {};
	try {
		return readConfiguredAgentOverrides(JSON.parse(result.stdout).agents);
	} catch {
		return {};
	}
}
async function resolveAcpxAgentCommand(params) {
	const normalizedAgent = normalizeAgentName(params.agent);
	return (await loadAgentOverrides({
		acpxCommand: params.acpxCommand,
		cwd: params.cwd,
		stripProviderAuthEnvVars: params.stripProviderAuthEnvVars,
		spawnOptions: params.spawnOptions
	}))[normalizedAgent] ?? ACPX_BUILTIN_AGENT_COMMANDS[normalizedAgent] ?? params.agent;
}
function buildMcpProxyAgentCommand(params) {
	const payload = Buffer.from(JSON.stringify({
		targetCommand: params.targetCommand,
		mcpServers: params.mcpServers
	}), "utf8").toString("base64url");
	return toCommandLine([
		process.execPath,
		MCP_PROXY_PATH,
		"--payload",
		payload
	]);
}
//#endregion
//#region extensions/acpx/src/runtime.ts
const ACPX_BACKEND_ID = "acpx";
const ACPX_RUNTIME_HANDLE_PREFIX = "acpx:v1:";
const DEFAULT_AGENT_FALLBACK = "codex";
const ACPX_EXIT_CODE_PERMISSION_DENIED = 5;
const ACPX_CAPABILITIES = { controls: [
	"session/set_mode",
	"session/set_config_option",
	"session/status"
] };
function formatPermissionModeGuidance() {
	return "Configure plugins.entries.acpx.config.permissionMode to one of: approve-reads, approve-all, deny-all.";
}
function formatAcpxExitMessage(params) {
	const stderr = params.stderr.trim();
	if (params.exitCode === ACPX_EXIT_CODE_PERMISSION_DENIED) return [
		stderr || "Permission denied by ACP runtime (acpx).",
		"ACPX blocked a write/exec permission request in a non-interactive session.",
		formatPermissionModeGuidance()
	].join(" ");
	return stderr || `acpx exited with code ${params.exitCode ?? "unknown"}`;
}
function encodeAcpxRuntimeHandleState(state) {
	return `${ACPX_RUNTIME_HANDLE_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`;
}
function decodeAcpxRuntimeHandleState(runtimeSessionName) {
	const trimmed = runtimeSessionName.trim();
	if (!trimmed.startsWith(ACPX_RUNTIME_HANDLE_PREFIX)) return null;
	const encoded = trimmed.slice(8);
	if (!encoded) return null;
	try {
		const raw = Buffer.from(encoded, "base64url").toString("utf8");
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) return null;
		const name = asTrimmedString(parsed.name);
		const agent = asTrimmedString(parsed.agent);
		const cwd = asTrimmedString(parsed.cwd);
		const mode = asTrimmedString(parsed.mode);
		const acpxRecordId = asOptionalString(parsed.acpxRecordId);
		const backendSessionId = asOptionalString(parsed.backendSessionId);
		const agentSessionId = asOptionalString(parsed.agentSessionId);
		if (!name || !agent || !cwd) return null;
		if (mode !== "persistent" && mode !== "oneshot") return null;
		return {
			name,
			agent,
			cwd,
			mode,
			...acpxRecordId ? { acpxRecordId } : {},
			...backendSessionId ? { backendSessionId } : {},
			...agentSessionId ? { agentSessionId } : {}
		};
	} catch {
		return null;
	}
}
var AcpxRuntime = class {
	constructor(config, opts) {
		this.config = config;
		this.healthy = false;
		this.spawnCommandCache = {};
		this.mcpProxyAgentCommandCache = /* @__PURE__ */ new Map();
		this.loggedSpawnResolutions = /* @__PURE__ */ new Set();
		this.logger = opts?.logger;
		const requestedQueueOwnerTtlSeconds = opts?.queueOwnerTtlSeconds;
		this.queueOwnerTtlSeconds = typeof requestedQueueOwnerTtlSeconds === "number" && Number.isFinite(requestedQueueOwnerTtlSeconds) && requestedQueueOwnerTtlSeconds >= 0 ? requestedQueueOwnerTtlSeconds : this.config.queueOwnerTtlSeconds;
		this.spawnCommandOptions = {
			strictWindowsCmdWrapper: this.config.strictWindowsCmdWrapper,
			cache: this.spawnCommandCache,
			onResolved: (event) => {
				this.logSpawnResolution(event);
			}
		};
	}
	isHealthy() {
		return this.healthy;
	}
	logSpawnResolution(event) {
		const key = `${event.command}::${event.strictWindowsCmdWrapper ? "strict" : "compat"}::${event.resolution}`;
		if (event.cacheHit || this.loggedSpawnResolutions.has(key)) return;
		this.loggedSpawnResolutions.add(key);
		this.logger?.debug?.(`acpx spawn resolver: command=${event.command} mode=${event.strictWindowsCmdWrapper ? "strict" : "compat"} resolution=${event.resolution}`);
	}
	async checkVersion() {
		return await checkAcpxVersion({
			command: this.config.command,
			cwd: this.config.cwd,
			expectedVersion: this.config.expectedVersion,
			stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
			spawnOptions: this.spawnCommandOptions
		});
	}
	async runHelpCheck() {
		return await spawnAndCollect({
			command: this.config.command,
			args: ["--help"],
			cwd: this.config.cwd,
			stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars
		}, this.spawnCommandOptions);
	}
	async checkHealth() {
		const versionCheck = await this.checkVersion();
		if (!versionCheck.ok) return {
			ok: false,
			failure: {
				kind: "version-check",
				versionCheck
			}
		};
		try {
			const result = await this.runHelpCheck();
			if (result.error != null || (result.code ?? 0) !== 0) return {
				ok: false,
				failure: {
					kind: "help-check",
					result
				}
			};
			return {
				ok: true,
				versionCheck
			};
		} catch (error) {
			return {
				ok: false,
				failure: {
					kind: "exception",
					error
				}
			};
		}
	}
	async probeAvailability() {
		this.healthy = (await this.checkHealth()).ok;
	}
	async ensureSession(input) {
		const sessionName = asTrimmedString(input.sessionKey);
		if (!sessionName) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP session key is required.");
		const agent = asTrimmedString(input.agent);
		if (!agent) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "ACP agent id is required.");
		const cwd = asTrimmedString(input.cwd) || this.config.cwd;
		const mode = input.mode;
		const resumeSessionId = asTrimmedString(input.resumeSessionId);
		const ensureSubcommand = resumeSessionId ? [
			"sessions",
			"new",
			"--name",
			sessionName,
			"--resume-session",
			resumeSessionId
		] : [
			"sessions",
			"ensure",
			"--name",
			sessionName
		];
		const ensureCommand = await this.buildVerbArgs({
			agent,
			cwd,
			command: ensureSubcommand
		});
		let events = await this.runControlCommand({
			args: ensureCommand,
			cwd,
			fallbackCode: "ACP_SESSION_INIT_FAILED"
		});
		let ensuredEvent = events.find((event) => asOptionalString(event.agentSessionId) || asOptionalString(event.acpxSessionId) || asOptionalString(event.acpxRecordId));
		if (!ensuredEvent && !resumeSessionId) {
			const newCommand = await this.buildVerbArgs({
				agent,
				cwd,
				command: [
					"sessions",
					"new",
					"--name",
					sessionName
				]
			});
			events = await this.runControlCommand({
				args: newCommand,
				cwd,
				fallbackCode: "ACP_SESSION_INIT_FAILED"
			});
			ensuredEvent = events.find((event) => asOptionalString(event.agentSessionId) || asOptionalString(event.acpxSessionId) || asOptionalString(event.acpxRecordId));
		}
		if (!ensuredEvent) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", resumeSessionId ? `ACP session init failed: 'sessions new --resume-session' returned no session identifiers for ${sessionName}.` : `ACP session init failed: neither 'sessions ensure' nor 'sessions new' returned valid session identifiers for ${sessionName}.`);
		const acpxRecordId = ensuredEvent ? asOptionalString(ensuredEvent.acpxRecordId) : void 0;
		const agentSessionId = ensuredEvent ? asOptionalString(ensuredEvent.agentSessionId) : void 0;
		const backendSessionId = ensuredEvent ? asOptionalString(ensuredEvent.acpxSessionId) : void 0;
		return {
			sessionKey: input.sessionKey,
			backend: ACPX_BACKEND_ID,
			runtimeSessionName: encodeAcpxRuntimeHandleState({
				name: sessionName,
				agent,
				cwd,
				mode,
				...acpxRecordId ? { acpxRecordId } : {},
				...backendSessionId ? { backendSessionId } : {},
				...agentSessionId ? { agentSessionId } : {}
			}),
			cwd,
			...acpxRecordId ? { acpxRecordId } : {},
			...backendSessionId ? { backendSessionId } : {},
			...agentSessionId ? { agentSessionId } : {}
		};
	}
	async *runTurn(input) {
		const state = this.resolveHandleState(input.handle);
		const args = await this.buildPromptArgs({
			agent: state.agent,
			sessionName: state.name,
			cwd: state.cwd
		});
		const cancelOnAbort = async () => {
			await this.cancel({
				handle: input.handle,
				reason: "abort-signal"
			}).catch((err) => {
				this.logger?.warn?.(`acpx runtime abort-cancel failed: ${String(err)}`);
			});
		};
		const onAbort = () => {
			cancelOnAbort();
		};
		if (input.signal?.aborted) {
			await cancelOnAbort();
			return;
		}
		if (input.signal) input.signal.addEventListener("abort", onAbort, { once: true });
		const child = spawnWithResolvedCommand({
			command: this.config.command,
			args,
			cwd: state.cwd,
			stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars
		}, this.spawnCommandOptions);
		child.stdin.on("error", () => {});
		if (input.attachments && input.attachments.length > 0) {
			const blocks = [];
			if (input.text) blocks.push({
				type: "text",
				text: input.text
			});
			for (const attachment of input.attachments) if (attachment.mediaType.startsWith("image/")) blocks.push({
				type: "image",
				mimeType: attachment.mediaType,
				data: attachment.data
			});
			child.stdin.end(blocks.length > 0 ? JSON.stringify(blocks) : input.text);
		} else child.stdin.end(input.text);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		let sawDone = false;
		let sawError = false;
		const lines = createInterface({ input: child.stdout });
		try {
			for await (const line of lines) {
				const parsed = parsePromptEventLine(line);
				if (!parsed) continue;
				if (parsed.type === "done") {
					if (sawDone) continue;
					sawDone = true;
				}
				if (parsed.type === "error") sawError = true;
				yield parsed;
			}
			const exit = await waitForExit(child);
			if (exit.error) {
				const spawnFailure = resolveSpawnFailure(exit.error, state.cwd);
				if (spawnFailure === "missing-command") {
					this.healthy = false;
					throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", `acpx command not found: ${this.config.command}`, { cause: exit.error });
				}
				if (spawnFailure === "missing-cwd") throw new AcpRuntimeError("ACP_TURN_FAILED", `ACP runtime working directory does not exist: ${state.cwd}`, { cause: exit.error });
				throw new AcpRuntimeError("ACP_TURN_FAILED", exit.error.message, { cause: exit.error });
			}
			if ((exit.code ?? 0) !== 0 && !sawError) {
				yield {
					type: "error",
					message: formatAcpxExitMessage({
						stderr,
						exitCode: exit.code
					})
				};
				return;
			}
			if (!sawDone && !sawError) yield { type: "done" };
		} finally {
			lines.close();
			if (input.signal) input.signal.removeEventListener("abort", onAbort);
		}
	}
	getCapabilities() {
		return ACPX_CAPABILITIES;
	}
	async getStatus(input) {
		const state = this.resolveHandleState(input.handle);
		const args = await this.buildVerbArgs({
			agent: state.agent,
			cwd: state.cwd,
			command: [
				"status",
				"--session",
				state.name
			]
		});
		const events = await this.runControlCommand({
			args,
			cwd: state.cwd,
			fallbackCode: "ACP_TURN_FAILED",
			ignoreNoSession: true,
			signal: input.signal
		});
		const detail = events.find((event) => !toAcpxErrorEvent(event)) ?? events[0];
		if (!detail) return { summary: "acpx status unavailable" };
		const status = asTrimmedString(detail.status) || "unknown";
		const acpxRecordId = asOptionalString(detail.acpxRecordId);
		const acpxSessionId = asOptionalString(detail.acpxSessionId);
		const agentSessionId = asOptionalString(detail.agentSessionId);
		const pid = typeof detail.pid === "number" && Number.isFinite(detail.pid) ? detail.pid : null;
		return {
			summary: [
				`status=${status}`,
				acpxRecordId ? `acpxRecordId=${acpxRecordId}` : null,
				acpxSessionId ? `acpxSessionId=${acpxSessionId}` : null,
				pid != null ? `pid=${pid}` : null
			].filter(Boolean).join(" "),
			...acpxRecordId ? { acpxRecordId } : {},
			...acpxSessionId ? { backendSessionId: acpxSessionId } : {},
			...agentSessionId ? { agentSessionId } : {},
			details: detail
		};
	}
	async setMode(input) {
		const state = this.resolveHandleState(input.handle);
		const mode = asTrimmedString(input.mode);
		if (!mode) throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP runtime mode is required.");
		const args = await this.buildVerbArgs({
			agent: state.agent,
			cwd: state.cwd,
			command: [
				"set-mode",
				mode,
				"--session",
				state.name
			]
		});
		await this.runControlCommand({
			args,
			cwd: state.cwd,
			fallbackCode: "ACP_TURN_FAILED"
		});
	}
	async setConfigOption(input) {
		const state = this.resolveHandleState(input.handle);
		const key = asTrimmedString(input.key);
		const value = asTrimmedString(input.value);
		if (!key || !value) throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP config option key/value are required.");
		const args = await this.buildVerbArgs({
			agent: state.agent,
			cwd: state.cwd,
			command: [
				"set",
				key,
				value,
				"--session",
				state.name
			]
		});
		await this.runControlCommand({
			args,
			cwd: state.cwd,
			fallbackCode: "ACP_TURN_FAILED"
		});
	}
	async doctor() {
		const result = await this.checkHealth();
		if (!result.ok && result.failure.kind === "version-check") {
			const { versionCheck } = result.failure;
			this.healthy = false;
			const details = [versionCheck.expectedVersion ? `expected=${versionCheck.expectedVersion}` : null, versionCheck.installedVersion ? `installed=${versionCheck.installedVersion}` : null].filter((detail) => Boolean(detail));
			return {
				ok: false,
				code: "ACP_BACKEND_UNAVAILABLE",
				message: versionCheck.message,
				installCommand: versionCheck.installCommand,
				details
			};
		}
		if (!result.ok && result.failure.kind === "help-check") {
			const { result: helpResult } = result.failure;
			this.healthy = false;
			if (helpResult.error) {
				const spawnFailure = resolveSpawnFailure(helpResult.error, this.config.cwd);
				if (spawnFailure === "missing-command") return {
					ok: false,
					code: "ACP_BACKEND_UNAVAILABLE",
					message: `acpx command not found: ${this.config.command}`,
					installCommand: this.config.installCommand
				};
				if (spawnFailure === "missing-cwd") return {
					ok: false,
					code: "ACP_BACKEND_UNAVAILABLE",
					message: `ACP runtime working directory does not exist: ${this.config.cwd}`
				};
				return {
					ok: false,
					code: "ACP_BACKEND_UNAVAILABLE",
					message: helpResult.error.message,
					details: [String(helpResult.error)]
				};
			}
			return {
				ok: false,
				code: "ACP_BACKEND_UNAVAILABLE",
				message: helpResult.stderr.trim() || `acpx exited with code ${helpResult.code ?? "unknown"}`
			};
		}
		if (!result.ok) {
			this.healthy = false;
			const failure = result.failure;
			return {
				ok: false,
				code: "ACP_BACKEND_UNAVAILABLE",
				message: failure.kind === "exception" ? failure.error instanceof Error ? failure.error.message : String(failure.error) : "acpx backend unavailable"
			};
		}
		this.healthy = true;
		return {
			ok: true,
			message: `acpx command available (${this.config.command}, version ${result.versionCheck.version}${this.config.expectedVersion ? `, expected ${this.config.expectedVersion}` : ""})`
		};
	}
	async cancel(input) {
		const state = this.resolveHandleState(input.handle);
		const args = await this.buildVerbArgs({
			agent: state.agent,
			cwd: state.cwd,
			command: [
				"cancel",
				"--session",
				state.name
			]
		});
		await this.runControlCommand({
			args,
			cwd: state.cwd,
			fallbackCode: "ACP_TURN_FAILED",
			ignoreNoSession: true
		});
	}
	async close(input) {
		const state = this.resolveHandleState(input.handle);
		const args = await this.buildVerbArgs({
			agent: state.agent,
			cwd: state.cwd,
			command: [
				"sessions",
				"close",
				state.name
			]
		});
		await this.runControlCommand({
			args,
			cwd: state.cwd,
			fallbackCode: "ACP_TURN_FAILED",
			ignoreNoSession: true
		});
	}
	resolveHandleState(handle) {
		const decoded = decodeAcpxRuntimeHandleState(handle.runtimeSessionName);
		if (decoded) return decoded;
		const legacyName = asTrimmedString(handle.runtimeSessionName);
		if (!legacyName) throw new AcpRuntimeError("ACP_SESSION_INIT_FAILED", "Invalid acpx runtime handle: runtimeSessionName is missing.");
		return {
			name: legacyName,
			agent: deriveAgentFromSessionKey(handle.sessionKey, DEFAULT_AGENT_FALLBACK),
			cwd: this.config.cwd,
			mode: "persistent"
		};
	}
	async buildPromptArgs(params) {
		const prefix = [
			"--format",
			"json",
			"--json-strict",
			"--cwd",
			params.cwd,
			...buildPermissionArgs(this.config.permissionMode),
			"--non-interactive-permissions",
			this.config.nonInteractivePermissions
		];
		if (this.config.timeoutSeconds) prefix.push("--timeout", String(this.config.timeoutSeconds));
		prefix.push("--ttl", String(this.queueOwnerTtlSeconds));
		return await this.buildVerbArgs({
			agent: params.agent,
			cwd: params.cwd,
			command: [
				"prompt",
				"--session",
				params.sessionName,
				"--file",
				"-"
			],
			prefix
		});
	}
	async buildVerbArgs(params) {
		const prefix = params.prefix ?? [
			"--format",
			"json",
			"--json-strict",
			"--cwd",
			params.cwd
		];
		const agentCommand = await this.resolveRawAgentCommand({
			agent: params.agent,
			cwd: params.cwd
		});
		if (!agentCommand) return [
			...prefix,
			params.agent,
			...params.command
		];
		return [
			...prefix,
			"--agent",
			agentCommand,
			...params.command
		];
	}
	async resolveRawAgentCommand(params) {
		if (Object.keys(this.config.mcpServers).length === 0) return null;
		const cacheKey = `${params.cwd}::${params.agent}`;
		const cached = this.mcpProxyAgentCommandCache.get(cacheKey);
		if (cached) return cached;
		const resolved = buildMcpProxyAgentCommand({
			targetCommand: await resolveAcpxAgentCommand({
				acpxCommand: this.config.command,
				cwd: params.cwd,
				agent: params.agent,
				stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars,
				spawnOptions: this.spawnCommandOptions
			}),
			mcpServers: toAcpMcpServers(this.config.mcpServers)
		});
		this.mcpProxyAgentCommandCache.set(cacheKey, resolved);
		return resolved;
	}
	async runControlCommand(params) {
		const result = await spawnAndCollect({
			command: this.config.command,
			args: params.args,
			cwd: params.cwd,
			stripProviderAuthEnvVars: this.config.stripProviderAuthEnvVars
		}, this.spawnCommandOptions, { signal: params.signal });
		if (result.error) {
			const spawnFailure = resolveSpawnFailure(result.error, params.cwd);
			if (spawnFailure === "missing-command") {
				this.healthy = false;
				throw new AcpRuntimeError("ACP_BACKEND_UNAVAILABLE", `acpx command not found: ${this.config.command}`, { cause: result.error });
			}
			if (spawnFailure === "missing-cwd") throw new AcpRuntimeError(params.fallbackCode, `ACP runtime working directory does not exist: ${params.cwd}`, { cause: result.error });
			throw new AcpRuntimeError(params.fallbackCode, result.error.message, { cause: result.error });
		}
		const events = parseJsonLines(result.stdout);
		const errorEvent = events.map((event) => toAcpxErrorEvent(event)).find(Boolean) ?? null;
		if (errorEvent) {
			if (params.ignoreNoSession && errorEvent.code === "NO_SESSION") return events;
			throw new AcpRuntimeError(params.fallbackCode, errorEvent.code ? `${errorEvent.code}: ${errorEvent.message}` : errorEvent.message);
		}
		if ((result.code ?? 0) !== 0) throw new AcpRuntimeError(params.fallbackCode, formatAcpxExitMessage({
			stderr: result.stderr,
			exitCode: result.code
		}));
		return events;
	}
};
//#endregion
//#region extensions/acpx/src/service.ts
function createDefaultRuntime(params) {
	return new AcpxRuntime(params.pluginConfig, {
		logger: params.logger,
		queueOwnerTtlSeconds: params.queueOwnerTtlSeconds
	});
}
function createAcpxRuntimeService(params = {}) {
	let runtime = null;
	let lifecycleRevision = 0;
	return {
		id: "acpx-runtime",
		async start(ctx) {
			const pluginConfig = resolveAcpxPluginConfig({
				rawConfig: params.pluginConfig,
				workspaceDir: ctx.workspaceDir
			});
			runtime = (params.runtimeFactory ?? createDefaultRuntime)({
				pluginConfig,
				queueOwnerTtlSeconds: pluginConfig.queueOwnerTtlSeconds,
				logger: ctx.logger
			});
			registerAcpRuntimeBackend({
				id: ACPX_BACKEND_ID,
				runtime,
				healthy: () => runtime?.isHealthy() ?? false
			});
			const expectedVersionLabel = pluginConfig.expectedVersion ?? "any";
			const installLabel = pluginConfig.allowPluginLocalInstall ? "enabled" : "disabled";
			ctx.logger.info(`acpx runtime backend registered (command: ${pluginConfig.command}, expectedVersion: ${expectedVersionLabel}, pluginLocalInstall: ${installLabel})`);
			lifecycleRevision += 1;
			const currentRevision = lifecycleRevision;
			(async () => {
				try {
					await ensureAcpx({
						command: pluginConfig.command,
						logger: ctx.logger,
						expectedVersion: pluginConfig.expectedVersion,
						allowInstall: pluginConfig.allowPluginLocalInstall,
						stripProviderAuthEnvVars: pluginConfig.stripProviderAuthEnvVars,
						spawnOptions: { strictWindowsCmdWrapper: pluginConfig.strictWindowsCmdWrapper }
					});
					if (currentRevision !== lifecycleRevision) return;
					await runtime?.probeAvailability();
					if (runtime?.isHealthy()) ctx.logger.info("acpx runtime backend ready");
					else ctx.logger.warn("acpx runtime backend probe failed after local install");
				} catch (err) {
					if (currentRevision !== lifecycleRevision) return;
					ctx.logger.warn(`acpx runtime setup failed: ${err instanceof Error ? err.message : String(err)}`);
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
//#region extensions/acpx/index.ts
const plugin = {
	id: "acpx",
	name: "ACPX Runtime",
	description: "ACP runtime backend powered by the acpx CLI.",
	configSchema: createAcpxPluginConfigSchema(),
	register(api) {
		api.registerService(createAcpxRuntimeService({ pluginConfig: api.pluginConfig }));
	}
};
//#endregion
export { plugin as default };
