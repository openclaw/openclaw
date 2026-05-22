import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { n as markOpenClawExecEnv } from "./openclaw-exec-env-DOC4eAq6.js";
import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { p as resolveUserPath } from "./utils-CCskKJVV.js";
import { o as writeJsonAtomic } from "./json-files-BvzDldMA.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { t as safeParseJsonWithSchema } from "./zod-parse-CnyYByY3.js";
import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
import { c as normalizeAgentId, u as resolveAgentIdFromSessionKey } from "./session-key-BSgfYlBK.js";
import "./agent-scope-CbabgXwH.js";
import { r as acquireSessionWriteLock } from "./session-write-lock-C0bdSfhc.js";
import { _ as SANDBOX_AGENT_WORKSPACE_MOUNT, b as SANDBOX_REGISTRY_PATH, v as SANDBOX_BROWSER_REGISTRY_PATH } from "./constants-ub-M67cj.js";
import { i as resolveWindowsSpawnProgram, n as materializeWindowsSpawnProgram } from "./windows-spawn-B_kjnWjC.js";
import { t as sanitizeEnvVars } from "./sanitize-env-vars-uHGKwqkZ.js";
import { r as validateSandboxSecurity } from "./validate-sandbox-security-ZzyBv4eg.js";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { z } from "zod";
//#region src/agents/sandbox/hash.ts
function hashTextSha256(value) {
	return crypto.createHash("sha256").update(value).digest("hex");
}
//#endregion
//#region src/agents/sandbox/config-hash.ts
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
const RegistryEntrySchema = z.object({ containerName: z.string() }).passthrough();
const RegistryFileSchema = z.object({ entries: z.array(RegistryEntrySchema) });
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
async function readRegistryFromFile(registryPath, mode) {
	try {
		const parsed = safeParseJsonWithSchema(RegistryFileSchema, await fs.readFile(registryPath, "utf-8"));
		if (parsed) return parsed;
		if (mode === "fallback") return { entries: [] };
		throw new Error(`Invalid sandbox registry format: ${registryPath}`);
	} catch (error) {
		if (error?.code === "ENOENT") return { entries: [] };
		if (mode === "fallback") return { entries: [] };
		if (error instanceof Error) throw error;
		throw new Error(`Failed to read sandbox registry file: ${registryPath}`, { cause: error });
	}
}
async function writeRegistryFile(registryPath, registry) {
	await writeJsonAtomic(registryPath, registry, { trailingNewline: true });
}
async function readRegistry() {
	return { entries: (await readRegistryFromFile(SANDBOX_REGISTRY_PATH, "fallback")).entries.map((entry) => normalizeSandboxRegistryEntry(entry)) };
}
function upsertEntry(entries, entry) {
	const existing = entries.find((item) => item.containerName === entry.containerName);
	const next = entries.filter((item) => item.containerName !== entry.containerName);
	next.push({
		...entry,
		backendId: entry.backendId ?? existing?.backendId,
		runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
		createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
		image: existing?.image ?? entry.image,
		configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
		configHash: entry.configHash ?? existing?.configHash
	});
	return next;
}
function removeEntry(entries, containerName) {
	return entries.filter((entry) => entry.containerName !== containerName);
}
async function withRegistryMutation(registryPath, mutate) {
	await withRegistryLock(registryPath, async () => {
		const next = mutate((await readRegistryFromFile(registryPath, "strict")).entries);
		if (next === null) return;
		await writeRegistryFile(registryPath, { entries: next });
	});
}
async function updateRegistry(entry) {
	await withRegistryMutation(SANDBOX_REGISTRY_PATH, (entries) => upsertEntry(entries, entry));
}
async function removeRegistryEntry(containerName) {
	await withRegistryMutation(SANDBOX_REGISTRY_PATH, (entries) => {
		const next = removeEntry(entries, containerName);
		if (next.length === entries.length) return null;
		return next;
	});
}
async function readBrowserRegistry() {
	return await readRegistryFromFile(SANDBOX_BROWSER_REGISTRY_PATH, "fallback");
}
async function updateBrowserRegistry(entry) {
	await withRegistryMutation(SANDBOX_BROWSER_REGISTRY_PATH, (entries) => upsertEntry(entries, entry));
}
async function removeBrowserRegistryEntry(containerName) {
	await withRegistryMutation(SANDBOX_BROWSER_REGISTRY_PATH, (entries) => {
		const next = removeEntry(entries, containerName);
		if (next.length === entries.length) return null;
		return next;
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
	const envSanitization = sanitizeEnvVars(params.cfg.env ?? {}, params.envSanitizationOptions);
	if (envSanitization.blocked.length > 0) log.warn(`Blocked sensitive environment variables: ${envSanitization.blocked.join(", ")}`);
	if (envSanitization.warnings.length > 0) log.warn(`Suspicious environment variables: ${envSanitization.warnings.join(", ")}`);
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
		registryEntry = (await readRegistry()).entries.find((entry) => entry.containerName === containerName);
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
export { removeRegistryEntry as C, computeSandboxBrowserConfigHash as E, removeBrowserRegistryEntry as S, updateRegistry as T, resolveSandboxScopeKey as _, execDocker as a, readBrowserRegistry as b, isDockerDaemonUnavailable as c, readDockerNetworkDriver as d, readDockerNetworkGateway as f, resolveSandboxAgentId as g, appendWorkspaceMountArgs as h, ensureSandboxContainer as i, readDockerContainerEnvVar as l, resolveDockerSpawnInvocation as m, dockerContainerState as n, execDockerRaw as o, readDockerPort as p, ensureDockerImage as r, formatDockerDaemonUnavailableError as s, buildSandboxCreateArgs as t, readDockerContainerLabel as u, resolveSandboxWorkspaceDir as v, updateBrowserRegistry as w, readRegistry as x, slugifySessionKey as y };
