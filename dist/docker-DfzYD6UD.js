import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as markOpenClawExecEnv } from "./openclaw-exec-env-CjxcymgO.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { d as resolveAgentIdFromSessionKey, l as normalizeAgentId } from "./session-key-Bte0mmcq.js";
import { m as writeJson } from "./json-files-C2hqjU--.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { Et as array, Rn as string, Tn as object } from "./schemas-Del5uzR8.js";
import { t as safeParseJsonWithSchema } from "./zod-parse-B4dzFRWI.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as acquireSessionWriteLock } from "./session-write-lock-_a5O1H8L.js";
import { C as SANDBOX_REGISTRY_PATH, S as SANDBOX_CONTAINERS_DIR, _ as SANDBOX_AGENT_WORKSPACE_MOUNT, b as SANDBOX_BROWSER_REGISTRY_PATH, v as SANDBOX_BROWSERS_DIR } from "./constants-By80hBjs.js";
import { a as resolveWindowsSpawnProgram, r as materializeWindowsSpawnProgram } from "./windows-spawn-B76fGM3V.js";
import { n as sanitizeExplicitSandboxEnvVars, t as sanitizeEnvVars } from "./sanitize-env-vars-4wyDg6L9.js";
import { r as validateSandboxSecurity } from "./validate-sandbox-security-DkSeOpz8.js";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
//#region src/agents/sandbox/hash.ts
function hashTextSha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
//#endregion
//#region src/agents/sandbox/config-hash.ts
const SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH = "explicit-config-env-v1";
function normalizeForHash(value) {
	if (value === void 0) return;
	if (Array.isArray(value)) return value.map(normalizeForHash).filter((item) => item !== void 0);
	if (value && typeof value === "object") {
		const entries = Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b));
		const normalized = {};
		for (const [key, entryValue] of entries) {
			const next = normalizeForHash(entryValue);
			if (next !== void 0) normalized[key] = next;
		}
		return normalized;
	}
	return value;
}
function computeSandboxConfigHash(input) {
	return computeHash(input);
}
function computeSandboxBrowserConfigHash(input) {
	return computeHash(input);
}
function computeHash(input) {
	const payload = normalizeForHash(input);
	return hashTextSha256(JSON.stringify(payload));
}
//#endregion
//#region src/agents/sandbox/registry.ts
const RegistryEntrySchema = object({ containerName: string() }).passthrough();
const RegistryFileSchema = object({ entries: array(RegistryEntrySchema) });
function normalizeSandboxRegistryEntry(entry) {
	return {
		...entry,
		backendId: entry.backendId?.trim() || "docker",
		runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
		configLabelKind: entry.configLabelKind?.trim() || "Image"
	};
}
async function withRegistryLock(registryPath, fn) {
	const lock = await acquireSessionWriteLock({
		sessionFile: registryPath,
		allowReentrant: false,
		timeoutMs: 6e4
	});
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
async function readLegacyRegistryFile(registryPath) {
	try {
		return safeParseJsonWithSchema(RegistryFileSchema, await fs.readFile(registryPath, "utf-8"));
	} catch (error) {
		if (error?.code === "ENOENT") return { entries: [] };
		if (error instanceof Error) throw error;
		throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
	}
}
async function readRegistry() {
	return { entries: (await readShardedEntries(SANDBOX_CONTAINERS_DIR)).map((entry) => normalizeSandboxRegistryEntry(entry)) };
}
function shardedEntryFilePath(dir, containerName) {
	return path.join(dir, `${hashTextSha256(containerName)}.json`);
}
async function withEntryLock(dir, containerName, fn) {
	const lock = await acquireSessionWriteLock({
		sessionFile: shardedEntryFilePath(dir, containerName),
		allowReentrant: false,
		timeoutMs: 6e4
	});
	try {
		return await fn();
	} finally {
		await lock.release();
	}
}
async function readShardedEntry(dir, containerName) {
	let raw;
	try {
		raw = await fs.readFile(shardedEntryFilePath(dir, containerName), "utf-8");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
	const parsed = safeParseJsonWithSchema(RegistryEntrySchema, raw);
	return parsed?.containerName === containerName ? parsed : null;
}
async function writeShardedEntry(dir, entry) {
	await fs.mkdir(dir, { recursive: true });
	await writeJson(shardedEntryFilePath(dir, entry.containerName), entry, { trailingNewline: true });
}
async function removeShardedEntry(dir, containerName) {
	await fs.rm(shardedEntryFilePath(dir, containerName), { force: true });
}
async function readShardedEntries(dir) {
	let files;
	try {
		files = await fs.readdir(dir);
	} catch (error) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const entries = await Promise.all(files.filter((name) => name.endsWith(".json")).toSorted().map(async (name) => {
		try {
			return safeParseJsonWithSchema(RegistryEntrySchema, await fs.readFile(path.join(dir, name), "utf-8"));
		} catch {
			return null;
		}
	}));
	const validEntries = [];
	for (const entry of entries) if (entry) validEntries.push(entry);
	return validEntries.toSorted((left, right) => left.containerName.localeCompare(right.containerName));
}
async function quarantineLegacyRegistry(registryPath) {
	const quarantinePath = `${registryPath}.invalid-${Date.now()}`;
	await fs.rename(registryPath, quarantinePath).catch(async (error) => {
		if (error?.code !== "ENOENT") await fs.rm(registryPath, { force: true });
	});
	return quarantinePath;
}
async function migrateMonolithicIfNeeded(target) {
	const { registryPath, shardedDir } = target;
	try {
		await fs.access(registryPath);
	} catch (error) {
		if (error?.code === "ENOENT") return {
			...target,
			status: "missing",
			entries: 0
		};
		throw error;
	}
	return await withRegistryLock(registryPath, async () => {
		const registry = await readLegacyRegistryFile(registryPath);
		if (!registry) {
			const quarantinePath = await quarantineLegacyRegistry(registryPath);
			return {
				...target,
				status: "quarantined-invalid",
				entries: 0,
				quarantinePath
			};
		}
		if (registry.entries.length === 0) {
			await fs.rm(registryPath, { force: true });
			return {
				...target,
				status: "removed-empty",
				entries: 0
			};
		}
		await fs.mkdir(shardedDir, { recursive: true });
		for (const entry of registry.entries) await withEntryLock(shardedDir, entry.containerName, async () => {
			if (!await readShardedEntry(shardedDir, entry.containerName)) await writeShardedEntry(shardedDir, entry);
		});
		await fs.rm(registryPath, { force: true });
		return {
			...target,
			status: "migrated",
			entries: registry.entries.length
		};
	});
}
function legacyRegistryTargets() {
	return [{
		kind: "containers",
		registryPath: SANDBOX_REGISTRY_PATH,
		shardedDir: SANDBOX_CONTAINERS_DIR
	}, {
		kind: "browsers",
		registryPath: SANDBOX_BROWSER_REGISTRY_PATH,
		shardedDir: SANDBOX_BROWSERS_DIR
	}];
}
async function inspectLegacySandboxRegistryFiles() {
	const inspections = [];
	for (const target of legacyRegistryTargets()) {
		try {
			await fs.access(target.registryPath);
		} catch (error) {
			if (error?.code === "ENOENT") {
				inspections.push({
					...target,
					exists: false,
					valid: true,
					entries: 0
				});
				continue;
			}
			throw error;
		}
		const registry = await readLegacyRegistryFile(target.registryPath);
		inspections.push({
			...target,
			exists: true,
			valid: Boolean(registry),
			entries: registry?.entries.length ?? 0
		});
	}
	return inspections;
}
async function migrateLegacySandboxRegistryFiles() {
	const results = [];
	for (const target of legacyRegistryTargets()) results.push(await migrateMonolithicIfNeeded(target));
	return results;
}
async function readRegistryEntry(containerName) {
	const entry = await readShardedEntry(SANDBOX_CONTAINERS_DIR, containerName);
	return entry ? normalizeSandboxRegistryEntry(entry) : null;
}
async function updateRegistry(entry) {
	await withEntryLock(SANDBOX_CONTAINERS_DIR, entry.containerName, async () => {
		const existing = await readShardedEntry(SANDBOX_CONTAINERS_DIR, entry.containerName);
		await writeShardedEntry(SANDBOX_CONTAINERS_DIR, {
			...entry,
			backendId: entry.backendId ?? existing?.backendId,
			runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
			createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
			image: existing?.image ?? entry.image,
			configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
			configHash: entry.configHash ?? existing?.configHash
		});
	});
}
async function removeRegistryEntry(containerName) {
	await withEntryLock(SANDBOX_CONTAINERS_DIR, containerName, async () => {
		await removeShardedEntry(SANDBOX_CONTAINERS_DIR, containerName);
	});
}
async function readBrowserRegistry() {
	return { entries: await readShardedEntries(SANDBOX_BROWSERS_DIR) };
}
async function updateBrowserRegistry(entry) {
	await withEntryLock(SANDBOX_BROWSERS_DIR, entry.containerName, async () => {
		const existing = await readShardedEntry(SANDBOX_BROWSERS_DIR, entry.containerName);
		await writeShardedEntry(SANDBOX_BROWSERS_DIR, {
			...entry,
			createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
			image: existing?.image ?? entry.image,
			configHash: entry.configHash ?? existing?.configHash
		});
	});
}
async function removeBrowserRegistryEntry(containerName) {
	await withEntryLock(SANDBOX_BROWSERS_DIR, containerName, async () => {
		await removeShardedEntry(SANDBOX_BROWSERS_DIR, containerName);
	});
}
//#endregion
//#region src/agents/sandbox/shared.ts
function slugifySessionKey(value) {
	const trimmed = value.trim() || "session";
	const hash = hashTextSha256(trimmed).slice(0, 8);
	return `${normalizeLowercaseStringOrEmpty(trimmed).replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "session"}-${hash}`;
}
function resolveSandboxWorkspaceDir(root, sessionKey) {
	const resolvedRoot = resolveUserPath(root);
	const slug = slugifySessionKey(sessionKey);
	return path.join(resolvedRoot, slug);
}
function resolveSandboxScopeKey(scope, sessionKey) {
	const trimmed = sessionKey.trim() || "main";
	if (scope === "shared") return "shared";
	if (scope === "session") return trimmed;
	return `agent:${resolveAgentIdFromSessionKey(trimmed)}`;
}
function resolveSandboxAgentId(scopeKey) {
	const trimmed = scopeKey.trim();
	if (!trimmed || trimmed === "shared") return;
	const parts = trimmed.split(":").filter(Boolean);
	if (parts[0] === "agent" && parts[1]) return normalizeAgentId(parts[1]);
	return resolveAgentIdFromSessionKey(trimmed);
}
//#endregion
//#region src/agents/sandbox/workspace-mounts.ts
function formatManagedWorkspaceBind(params) {
	return `${params.hostPath}:${params.containerPath}:${params.readOnly ? "ro,z" : "z"}`;
}
function appendWorkspaceMountArgs(params) {
	const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;
	args.push("-v", formatManagedWorkspaceBind({
		hostPath: workspaceDir,
		containerPath: workdir,
		readOnly: workspaceAccess !== "rw"
	}));
	if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) args.push("-v", formatManagedWorkspaceBind({
		hostPath: agentWorkspaceDir,
		containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
		readOnly: workspaceAccess === "ro"
	}));
}
//#endregion
//#region src/agents/sandbox/docker.ts
function createAbortError() {
	const err = /* @__PURE__ */ new Error("Aborted");
	err.name = "AbortError";
	return err;
}
const DEFAULT_DOCKER_SPAWN_RUNTIME = {
	platform: process.platform,
	env: process.env,
	execPath: process.execPath
};
function resolveDockerSpawnInvocation(args, runtime = DEFAULT_DOCKER_SPAWN_RUNTIME) {
	const resolved = materializeWindowsSpawnProgram(resolveWindowsSpawnProgram({
		command: "docker",
		platform: runtime.platform,
		env: runtime.env,
		execPath: runtime.execPath,
		packageName: "docker",
		allowShellFallback: false
	}), args);
	return {
		command: resolved.command,
		args: resolved.argv,
		shell: resolved.shell,
		windowsHide: resolved.windowsHide
	};
}
function execDockerRaw(args, opts) {
	return new Promise((resolve, reject) => {
		const spawnInvocation = resolveDockerSpawnInvocation(args);
		const child = spawn(spawnInvocation.command, spawnInvocation.args, {
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			shell: spawnInvocation.shell,
			windowsHide: spawnInvocation.windowsHide
		});
		const stdoutChunks = [];
		const stderrChunks = [];
		let aborted = false;
		const signal = opts?.signal;
		const handleAbort = () => {
			if (aborted) return;
			aborted = true;
			child.kill("SIGTERM");
		};
		if (signal) if (signal.aborted) handleAbort();
		else signal.addEventListener("abort", handleAbort, { once: true });
		child.stdout?.on("data", (chunk) => {
			stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.stderr?.on("data", (chunk) => {
			stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		child.on("error", (error) => {
			if (signal) signal.removeEventListener("abort", handleAbort);
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				reject(Object.assign(/* @__PURE__ */ new Error("Sandbox mode requires Docker, but the \"docker\" command was not found in PATH. Install Docker (and ensure \"docker\" is available), or set `agents.defaults.sandbox.mode=off` to disable sandboxing."), {
					code: "INVALID_CONFIG",
					cause: error
				}));
				return;
			}
			reject(error);
		});
		child.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", handleAbort);
			const stdout = Buffer.concat(stdoutChunks);
			const stderr = Buffer.concat(stderrChunks);
			if (aborted || signal?.aborted) {
				reject(createAbortError());
				return;
			}
			const exitCode = code ?? 0;
			if (exitCode !== 0 && !opts?.allowFailure) {
				const message = stderr.length > 0 ? stderr.toString("utf8").trim() : "";
				reject(Object.assign(new Error(message || `docker ${args.join(" ")} failed`), {
					code: exitCode,
					stdout,
					stderr
				}));
				return;
			}
			resolve({
				stdout,
				stderr,
				code: exitCode
			});
		});
		const stdin = child.stdin;
		if (stdin) if (opts?.input !== void 0) stdin.end(opts.input);
		else stdin.end();
	});
}
const log = createSubsystemLogger("docker");
const HOT_CONTAINER_WINDOW_MS = 300 * 1e3;
function envRecordsEqual(left, right) {
	const leftEntries = Object.entries(left).toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	const rightEntries = Object.entries(right).toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
	if (leftEntries.length !== rightEntries.length) return false;
	return leftEntries.every(([key, value], index) => {
		const rightEntry = rightEntries[index];
		return rightEntry?.[0] === key && rightEntry[1] === value;
	});
}
function resolveDockerEnvPolicyEpoch(env) {
	const explicitEnv = env ?? {};
	const previousAllowed = sanitizeEnvVars(explicitEnv).allowed;
	const currentAllowed = sanitizeExplicitSandboxEnvVars(explicitEnv).allowed;
	return envRecordsEqual(previousAllowed, currentAllowed) ? void 0 : SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH;
}
async function execDocker(args, opts) {
	const result = await execDockerRaw(args, opts);
	return {
		stdout: result.stdout.toString("utf8"),
		stderr: result.stderr.toString("utf8"),
		code: result.code
	};
}
async function readDockerContainerLabel(containerName, label) {
	const result = await execDocker([
		"inspect",
		"-f",
		`{{ index .Config.Labels "${label}" }}`,
		containerName
	], { allowFailure: true });
	if (result.code !== 0) return null;
	const raw = result.stdout.trim();
	if (!raw || raw === "<no value>") return null;
	return raw;
}
async function readDockerContainerEnvVar(containerName, envVar) {
	const result = await execDocker([
		"inspect",
		"-f",
		"{{range .Config.Env}}{{println .}}{{end}}",
		containerName
	], { allowFailure: true });
	if (result.code !== 0) return null;
	for (const line of result.stdout.split(/\r?\n/)) if (line.startsWith(`${envVar}=`)) return line.slice(envVar.length + 1);
	return null;
}
async function readDockerNetworkDriver(network) {
	const result = await execDocker([
		"network",
		"inspect",
		"-f",
		"{{.Driver}}",
		network
	], { allowFailure: true });
	if (result.code !== 0) return null;
	return result.stdout.trim() || null;
}
async function readDockerNetworkGateway(network) {
	const result = await execDocker([
		"network",
		"inspect",
		"-f",
		"{{range .IPAM.Config}}{{println .Gateway}}{{end}}",
		network
	], { allowFailure: true });
	if (result.code !== 0) return null;
	const gateways = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "<no value>");
	return (gateways.find((g) => !g.includes(":")) ?? gateways[0] ?? "") || null;
}
async function readDockerPort(containerName, port) {
	const result = await execDocker([
		"port",
		containerName,
		`${port}/tcp`
	], { allowFailure: true });
	if (result.code !== 0) return null;
	const match = (result.stdout.trim().split(/\r?\n/)[0] ?? "").match(/:(\d+)\s*$/);
	if (!match) return null;
	const mapped = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(mapped) ? mapped : null;
}
const DOCKER_DAEMON_UNAVAILABLE_MARKERS = [
	"cannot connect to the docker daemon",
	"dial unix",
	"docker daemon is not running",
	"connection refused"
];
function isDockerDaemonUnavailable(stderr) {
	return DOCKER_DAEMON_UNAVAILABLE_MARKERS.some((marker) => stderr.toLowerCase().includes(marker));
}
function formatDockerDaemonUnavailableError(stderr) {
	const detail = stderr.trim();
	return [
		"Sandbox mode requires Docker, but the Docker daemon is not available.",
		"Start Docker, or set `agents.defaults.sandbox.mode=off` to disable sandboxing.",
		detail ? `Docker said: ${detail}` : void 0
	].filter((line) => Boolean(line)).join(" ");
}
async function inspectDockerImage(image) {
	const result = await execDocker([
		"image",
		"inspect",
		image
	], { allowFailure: true });
	if (result.code === 0) return "exists";
	const stderr = result.stderr.trim();
	if (stderr.toLowerCase().includes("no such image")) return "missing";
	if (isDockerDaemonUnavailable(stderr)) throw new Error(formatDockerDaemonUnavailableError(stderr));
	throw new Error(`Failed to inspect sandbox image: ${stderr}`);
}
async function ensureDockerImage(image) {
	if (await inspectDockerImage(image) === "exists") return;
	if (image === "openclaw-sandbox:bookworm-slim") throw new Error(`Sandbox image not found: ${image}. Build it with scripts/sandbox-setup.sh before enabling Docker sandboxing. The default image includes python3 for sandbox write/edit helpers; OpenClaw will not substitute plain debian:bookworm-slim.`);
	throw new Error(`Sandbox image not found: ${image}. Build or pull it first.`);
}
async function dockerContainerState(name) {
	const result = await execDocker([
		"inspect",
		"-f",
		"{{.State.Running}}",
		name
	], { allowFailure: true });
	if (result.code !== 0) return {
		exists: false,
		running: false
	};
	return {
		exists: true,
		running: result.stdout.trim() === "true"
	};
}
function normalizeDockerLimit(value) {
	if (value === void 0 || value === null) return;
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : void 0;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function formatUlimitValue(name, value) {
	if (!name.trim()) return null;
	if (typeof value === "number" || typeof value === "string") {
		const raw = String(value).trim();
		return raw ? `${name}=${raw}` : null;
	}
	const soft = typeof value.soft === "number" ? Math.max(0, value.soft) : void 0;
	const hard = typeof value.hard === "number" ? Math.max(0, value.hard) : void 0;
	if (soft === void 0 && hard === void 0) return null;
	if (soft === void 0) return `${name}=${hard}`;
	if (hard === void 0) return `${name}=${soft}`;
	return `${name}=${soft}:${hard}`;
}
function buildSandboxCreateArgs(params) {
	validateSandboxSecurity({
		...params.cfg,
		allowedSourceRoots: params.bindSourceRoots,
		allowSourcesOutsideAllowedRoots: params.allowSourcesOutsideAllowedRoots ?? params.cfg.dangerouslyAllowExternalBindSources === true,
		allowReservedContainerTargets: params.allowReservedContainerTargets ?? params.cfg.dangerouslyAllowReservedContainerTargets === true,
		dangerouslyAllowContainerNamespaceJoin: params.allowContainerNamespaceJoin ?? params.cfg.dangerouslyAllowContainerNamespaceJoin === true
	});
	const createdAtMs = params.createdAtMs ?? Date.now();
	const args = [
		"create",
		"--name",
		params.name
	];
	args.push("--label", "openclaw.sandbox=1");
	args.push("--label", `openclaw.sessionKey=${params.scopeKey}`);
	args.push("--label", `openclaw.createdAtMs=${createdAtMs}`);
	args.push("--label", `openclaw.mountFormatVersion=2`);
	if (params.configHash) args.push("--label", `openclaw.configHash=${params.configHash}`);
	for (const [key, value] of Object.entries(params.labels ?? {})) if (key && value) args.push("--label", `${key}=${value}`);
	if (params.cfg.readOnlyRoot) args.push("--read-only");
	for (const entry of params.cfg.tmpfs) args.push("--tmpfs", entry);
	if (params.cfg.network) args.push("--network", params.cfg.network);
	if (params.cfg.user) args.push("--user", params.cfg.user);
	const envSanitization = sanitizeExplicitSandboxEnvVars(params.cfg.env ?? {});
	if (envSanitization.blocked.length > 0) log.warn(`Blocked invalid configured sandbox environment variables: ${envSanitization.blocked.join(", ")}`);
	if (envSanitization.warnings.length > 0) log.warn(`Suspicious configured sandbox environment variables: ${envSanitization.warnings.join(", ")}`);
	for (const [key, value] of Object.entries(markOpenClawExecEnv(envSanitization.allowed))) args.push("--env", `${key}=${value}`);
	for (const cap of params.cfg.capDrop) args.push("--cap-drop", cap);
	args.push("--security-opt", "no-new-privileges");
	if (params.cfg.seccompProfile) args.push("--security-opt", `seccomp=${params.cfg.seccompProfile}`);
	if (params.cfg.apparmorProfile) args.push("--security-opt", `apparmor=${params.cfg.apparmorProfile}`);
	for (const entry of params.cfg.dns ?? []) if (entry.trim()) args.push("--dns", entry);
	for (const entry of params.cfg.extraHosts ?? []) if (entry.trim()) args.push("--add-host", entry);
	if (typeof params.cfg.pidsLimit === "number" && params.cfg.pidsLimit > 0) args.push("--pids-limit", String(params.cfg.pidsLimit));
	const memory = normalizeDockerLimit(params.cfg.memory);
	if (memory) args.push("--memory", memory);
	const memorySwap = normalizeDockerLimit(params.cfg.memorySwap);
	if (memorySwap) args.push("--memory-swap", memorySwap);
	if (typeof params.cfg.cpus === "number" && params.cfg.cpus > 0) args.push("--cpus", String(params.cfg.cpus));
	const gpus = params.cfg.gpus?.trim();
	if (gpus) args.push("--gpus", gpus);
	for (const [name, value] of Object.entries(params.cfg.ulimits ?? {})) {
		const formatted = formatUlimitValue(name, value);
		if (formatted) args.push("--ulimit", formatted);
	}
	if (params.includeBinds !== false && params.cfg.binds?.length) for (const bind of params.cfg.binds) args.push("-v", bind);
	return args;
}
function appendCustomBinds(args, cfg) {
	if (!cfg.binds?.length) return;
	for (const bind of cfg.binds) args.push("-v", bind);
}
async function createSandboxContainer(params) {
	const { name, cfg, workspaceDir, scopeKey } = params;
	await ensureDockerImage(cfg.image);
	const args = buildSandboxCreateArgs({
		name,
		cfg,
		scopeKey,
		configHash: params.configHash,
		includeBinds: false,
		bindSourceRoots: [workspaceDir, params.agentWorkspaceDir]
	});
	args.push("--workdir", cfg.workdir);
	appendWorkspaceMountArgs({
		args,
		workspaceDir,
		agentWorkspaceDir: params.agentWorkspaceDir,
		workdir: cfg.workdir,
		workspaceAccess: params.workspaceAccess
	});
	appendCustomBinds(args, cfg);
	args.push(cfg.image, "sleep", "infinity");
	await execDocker(args);
	await execDocker(["start", name]);
	if (cfg.setupCommand?.trim()) await execDocker([
		"exec",
		"-i",
		name,
		"/bin/sh",
		"-lc",
		cfg.setupCommand
	]);
}
async function readContainerConfigHash(containerName) {
	return await readDockerContainerLabel(containerName, "openclaw.configHash");
}
function formatSandboxRecreateHint(params) {
	if (params.scope === "session") return formatCliCommand(`openclaw sandbox recreate --session ${params.sessionKey}`);
	if (params.scope === "agent") return formatCliCommand(`openclaw sandbox recreate --agent ${resolveSandboxAgentId(params.sessionKey) ?? "main"}`);
	return formatCliCommand("openclaw sandbox recreate --all");
}
async function ensureSandboxContainer(params) {
	const scopeKey = resolveSandboxScopeKey(params.cfg.scope, params.sessionKey);
	const slug = params.cfg.scope === "shared" ? "shared" : slugifySessionKey(scopeKey);
	const containerName = `${params.cfg.docker.containerPrefix}${slug}`.slice(0, 63);
	const expectedHash = computeSandboxConfigHash({
		docker: params.cfg.docker,
		dockerEnvPolicyEpoch: resolveDockerEnvPolicyEpoch(params.cfg.docker.env),
		workspaceAccess: params.cfg.workspaceAccess,
		workspaceDir: params.workspaceDir,
		agentWorkspaceDir: params.agentWorkspaceDir,
		mountFormatVersion: 2
	});
	const now = Date.now();
	const state = await dockerContainerState(containerName);
	let hasContainer = state.exists;
	let running = state.running;
	let currentHash = null;
	let hashMismatch = false;
	let registryEntry;
	if (hasContainer) {
		registryEntry = await readRegistryEntry(containerName) ?? void 0;
		currentHash = await readContainerConfigHash(containerName);
		if (!currentHash) currentHash = registryEntry?.configHash ?? null;
		hashMismatch = !currentHash || currentHash !== expectedHash;
		if (hashMismatch) {
			const lastUsedAtMs = registryEntry?.lastUsedAtMs;
			if (running && (typeof lastUsedAtMs !== "number" || now - lastUsedAtMs < HOT_CONTAINER_WINDOW_MS)) {
				const hint = formatSandboxRecreateHint({
					scope: params.cfg.scope,
					sessionKey: scopeKey
				});
				defaultRuntime.log(`Sandbox config changed for ${containerName} (recently used). Recreate to apply: ${hint}`);
			} else {
				await execDocker([
					"rm",
					"-f",
					containerName
				], { allowFailure: true });
				hasContainer = false;
				running = false;
			}
		}
	}
	if (!hasContainer) await createSandboxContainer({
		name: containerName,
		cfg: params.cfg.docker,
		workspaceDir: params.workspaceDir,
		workspaceAccess: params.cfg.workspaceAccess,
		agentWorkspaceDir: params.agentWorkspaceDir,
		scopeKey,
		configHash: expectedHash
	});
	else if (!running) await execDocker(["start", containerName]);
	await updateRegistry({
		containerName,
		backendId: "docker",
		runtimeLabel: containerName,
		sessionKey: scopeKey,
		createdAtMs: now,
		lastUsedAtMs: now,
		image: params.cfg.docker.image,
		configLabelKind: "Image",
		configHash: hashMismatch && running ? currentHash ?? void 0 : expectedHash
	});
	return containerName;
}
//#endregion
export { readBrowserRegistry as C, updateBrowserRegistry as D, removeRegistryEntry as E, updateRegistry as O, migrateLegacySandboxRegistryFiles as S, removeBrowserRegistryEntry as T, resolveSandboxAgentId as _, execDocker as a, slugifySessionKey as b, isDockerDaemonUnavailable as c, readDockerNetworkDriver as d, readDockerNetworkGateway as f, appendWorkspaceMountArgs as g, resolveDockerSpawnInvocation as h, ensureSandboxContainer as i, computeSandboxBrowserConfigHash as k, readDockerContainerEnvVar as l, resolveDockerEnvPolicyEpoch as m, dockerContainerState as n, execDockerRaw as o, readDockerPort as p, ensureDockerImage as r, formatDockerDaemonUnavailableError as s, buildSandboxCreateArgs as t, readDockerContainerLabel as u, resolveSandboxScopeKey as v, readRegistry as w, inspectLegacySandboxRegistryFiles as x, resolveSandboxWorkspaceDir as y };
