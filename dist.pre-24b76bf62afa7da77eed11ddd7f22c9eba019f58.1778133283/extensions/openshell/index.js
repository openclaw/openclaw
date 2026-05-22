import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-Bje8XVt9.js";
import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-DItE5Xhf.js";
import { g as writeFileWithinRoot } from "../../fs-safe-EW2E3K3c.js";
import { t as sanitizeEnvVars } from "../../sanitize-env-vars--NZgxg-M.js";
import { _ as createRemoteShellSandboxFsBridge, b as createWritableRenameTargetResolver, c as buildExecRemoteCommand, d as createSshSandboxSessionFromConfigText, h as shellEscape, m as runSshSandboxCommand, o as registerSandboxBackend, p as disposeSshSandboxSession } from "../../browser-bridges-DUKJAJSY.js";
import "../../text-runtime-DCigKjjg.js";
import { n as buildPluginConfigSchema } from "../../config-schema-DyrF9ISN.js";
import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import "../../core-DYAvmXJF.js";
import { t as runPluginCommandWithTimeout } from "../../run-command-CgZkrpSq.js";
import "../../sandbox-b3s8hH1O.js";
import "../../file-access-runtime-CtP6ga_b.js";
import { c as mapPluginConfigIssues, s as formatPluginConfigIssue } from "../../extension-shared-COLeQjXE.js";
import { t as zod_exports } from "../../zod-Ct0CvXmO.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
//#region extensions/openshell/src/cli.ts
const require = createRequire(import.meta.url);
let cachedBundledOpenShellCommand;
function resolveBundledOpenShellCommand() {
	if (cachedBundledOpenShellCommand !== void 0) return cachedBundledOpenShellCommand;
	try {
		const packageJsonPath = require.resolve("openshell/package.json");
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
		const relativeBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.openshell;
		cachedBundledOpenShellCommand = relativeBin ? path.resolve(path.dirname(packageJsonPath), relativeBin) : null;
	} catch {
		cachedBundledOpenShellCommand = null;
	}
	return cachedBundledOpenShellCommand;
}
function resolveOpenShellCommand(command) {
	if (command !== "openshell") return command;
	return resolveBundledOpenShellCommand() ?? command;
}
function buildOpenShellBaseArgv(config) {
	const argv = [resolveOpenShellCommand(config.command)];
	if (config.gateway) argv.push("--gateway", config.gateway);
	if (config.gatewayEndpoint) argv.push("--gateway-endpoint", config.gatewayEndpoint);
	return argv;
}
function buildRemoteCommand(argv) {
	return argv.map((entry) => shellEscape(entry)).join(" ");
}
async function runOpenShellCli(params) {
	return await runPluginCommandWithTimeout({
		argv: [...buildOpenShellBaseArgv(params.context.config), ...params.args],
		cwd: params.cwd,
		timeoutMs: params.timeoutMs ?? params.context.timeoutMs ?? params.context.config.timeoutMs,
		env: process.env
	});
}
async function createOpenShellSshSession(params) {
	const result = await runOpenShellCli({
		context: params.context,
		args: [
			"sandbox",
			"ssh-config",
			params.context.sandboxName
		]
	});
	if (result.code !== 0) throw new Error(result.stderr.trim() || "openshell sandbox ssh-config failed");
	return await createSshSandboxSessionFromConfigText({ configText: result.stdout });
}
//#endregion
//#region extensions/openshell/src/config.ts
const DEFAULT_COMMAND = "openshell";
const DEFAULT_MODE = "mirror";
const DEFAULT_SOURCE = "openclaw";
const DEFAULT_REMOTE_WORKSPACE_DIR = "/sandbox";
const DEFAULT_REMOTE_AGENT_WORKSPACE_DIR = "/agent";
const DEFAULT_TIMEOUT_MS = 12e4;
const OPEN_SHELL_MANAGED_REMOTE_ROOTS = [DEFAULT_REMOTE_WORKSPACE_DIR, DEFAULT_REMOTE_AGENT_WORKSPACE_DIR];
function normalizeProviders(value) {
	const seen = /* @__PURE__ */ new Set();
	const providers = [];
	for (const entry of value ?? []) {
		const normalized = entry.trim();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		providers.push(normalized);
	}
	return providers;
}
const nonEmptyTrimmedString = (message) => zod_exports.z.string({ error: message }).trim().min(1, { error: message });
const OpenShellPluginConfigSchema = zod_exports.z.strictObject({
	mode: zod_exports.z.enum(["mirror", "remote"], { error: "mode must be one of mirror, remote" }).optional(),
	command: nonEmptyTrimmedString("command must be a non-empty string").optional(),
	gateway: nonEmptyTrimmedString("gateway must be a non-empty string").optional(),
	gatewayEndpoint: nonEmptyTrimmedString("gatewayEndpoint must be a non-empty string").optional(),
	from: nonEmptyTrimmedString("from must be a non-empty string").optional(),
	policy: nonEmptyTrimmedString("policy must be a non-empty string").optional(),
	providers: zod_exports.z.array(zod_exports.z.string({ error: "providers must be an array of strings" }).trim().min(1, { error: "providers must be an array of strings" }), { error: "providers must be an array of strings" }).optional(),
	gpu: zod_exports.z.boolean({ error: "gpu must be a boolean" }).optional(),
	autoProviders: zod_exports.z.boolean({ error: "autoProviders must be a boolean" }).optional(),
	remoteWorkspaceDir: nonEmptyTrimmedString("remoteWorkspaceDir must be a non-empty string").optional(),
	remoteAgentWorkspaceDir: nonEmptyTrimmedString("remoteAgentWorkspaceDir must be a non-empty string").optional(),
	timeoutSeconds: zod_exports.z.number({ error: "timeoutSeconds must be a number >= 1" }).min(1, { error: "timeoutSeconds must be a number >= 1" }).optional()
});
function isManagedOpenShellRemotePath(value) {
	return OPEN_SHELL_MANAGED_REMOTE_ROOTS.some((root) => value === root || value.startsWith(`${root}/`));
}
function normalizeOpenShellRemotePath(value, fallback, fieldName = "remote path") {
	const candidate = value ?? fallback;
	const normalized = path.posix.normalize(candidate.trim() || fallback);
	if (!normalized.startsWith("/")) throw new Error(`OpenShell ${fieldName} must be absolute: ${candidate}`);
	if (!isManagedOpenShellRemotePath(normalized)) throw new Error(`OpenShell ${fieldName} must stay under ${OPEN_SHELL_MANAGED_REMOTE_ROOTS.join(" or ")}: ${candidate}`);
	return normalized;
}
function createOpenShellPluginConfigSchema() {
	return buildPluginConfigSchema(OpenShellPluginConfigSchema, { safeParse(value) {
		if (value === void 0) return {
			success: true,
			data: void 0
		};
		const parsed = OpenShellPluginConfigSchema.safeParse(value);
		if (parsed.success) return {
			success: true,
			data: parsed.data
		};
		return {
			success: false,
			error: { issues: mapPluginConfigIssues(parsed.error.issues) }
		};
	} });
}
function resolveOpenShellPluginConfig(value) {
	if (value === void 0) return {
		mode: DEFAULT_MODE,
		command: DEFAULT_COMMAND,
		gateway: void 0,
		gatewayEndpoint: void 0,
		from: DEFAULT_SOURCE,
		policy: void 0,
		providers: [],
		gpu: false,
		autoProviders: true,
		remoteWorkspaceDir: DEFAULT_REMOTE_WORKSPACE_DIR,
		remoteAgentWorkspaceDir: DEFAULT_REMOTE_AGENT_WORKSPACE_DIR,
		timeoutMs: DEFAULT_TIMEOUT_MS
	};
	const parsed = OpenShellPluginConfigSchema.safeParse(value);
	if (!parsed.success) {
		const message = formatPluginConfigIssue(parsed.error.issues[0]);
		throw new Error(`Invalid openshell plugin config: ${message}`);
	}
	const cfg = parsed.data;
	return {
		mode: cfg.mode ?? DEFAULT_MODE,
		command: cfg.command ?? DEFAULT_COMMAND,
		gateway: cfg.gateway,
		gatewayEndpoint: cfg.gatewayEndpoint,
		from: cfg.from ?? DEFAULT_SOURCE,
		policy: cfg.policy,
		providers: normalizeProviders(cfg.providers),
		gpu: cfg.gpu ?? false,
		autoProviders: cfg.autoProviders ?? true,
		remoteWorkspaceDir: normalizeOpenShellRemotePath(cfg.remoteWorkspaceDir, DEFAULT_REMOTE_WORKSPACE_DIR, "remoteWorkspaceDir"),
		remoteAgentWorkspaceDir: normalizeOpenShellRemotePath(cfg.remoteAgentWorkspaceDir, DEFAULT_REMOTE_AGENT_WORKSPACE_DIR, "remoteAgentWorkspaceDir"),
		timeoutMs: typeof cfg.timeoutSeconds === "number" ? Math.floor(cfg.timeoutSeconds * 1e3) : DEFAULT_TIMEOUT_MS
	};
}
//#endregion
//#region extensions/openshell/src/mirror.ts
const DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS = [
	"hooks",
	"git-hooks",
	".git"
];
const COPY_TREE_FS_CONCURRENCY = 16;
function createExcludeMatcher(excludeDirs) {
	const excluded = new Set((excludeDirs ?? []).map((d) => normalizeLowercaseStringOrEmpty(d)));
	return (name) => excluded.has(normalizeLowercaseStringOrEmpty(name));
}
function createConcurrencyLimiter(limit) {
	let active = 0;
	const queue = [];
	const release = () => {
		active -= 1;
		queue.shift()?.();
	};
	return async (task) => {
		if (active >= limit) await new Promise((resolve) => {
			queue.push(resolve);
		});
		active += 1;
		try {
			return await task();
		} finally {
			release();
		}
	};
}
const runLimitedFs = createConcurrencyLimiter(COPY_TREE_FS_CONCURRENCY);
async function lstatIfExists(targetPath) {
	return await runLimitedFs(async () => await fs$1.lstat(targetPath)).catch(() => null);
}
async function copyTreeWithoutSymlinks(params) {
	const stats = await runLimitedFs(async () => await fs$1.lstat(params.sourcePath));
	if (stats.isSymbolicLink()) return;
	const targetStats = await lstatIfExists(params.targetPath);
	if (params.preserveTargetSymlinks && targetStats?.isSymbolicLink()) return;
	if (stats.isDirectory()) {
		await runLimitedFs(async () => await fs$1.mkdir(params.targetPath, { recursive: true }));
		const entries = await runLimitedFs(async () => await fs$1.readdir(params.sourcePath));
		await Promise.all(entries.map(async (entry) => {
			await copyTreeWithoutSymlinks({
				sourcePath: path.join(params.sourcePath, entry),
				targetPath: path.join(params.targetPath, entry),
				preserveTargetSymlinks: params.preserveTargetSymlinks
			});
		}));
		return;
	}
	if (stats.isFile()) {
		await runLimitedFs(async () => await fs$1.mkdir(path.dirname(params.targetPath), { recursive: true }));
		await runLimitedFs(async () => await fs$1.copyFile(params.sourcePath, params.targetPath));
	}
}
async function replaceDirectoryContents(params) {
	const isExcluded = createExcludeMatcher(params.excludeDirs);
	await fs$1.mkdir(params.targetDir, { recursive: true });
	const existing = await fs$1.readdir(params.targetDir);
	await Promise.all(existing.filter((entry) => !isExcluded(entry)).map(async (entry) => {
		const targetPath = path.join(params.targetDir, entry);
		if ((await lstatIfExists(targetPath))?.isSymbolicLink()) return;
		await runLimitedFs(async () => await fs$1.rm(targetPath, {
			recursive: true,
			force: true
		}));
	}));
	const sourceEntries = await fs$1.readdir(params.sourceDir);
	for (const entry of sourceEntries) {
		if (isExcluded(entry)) continue;
		await copyTreeWithoutSymlinks({
			sourcePath: path.join(params.sourceDir, entry),
			targetPath: path.join(params.targetDir, entry),
			preserveTargetSymlinks: true
		});
	}
}
async function stageDirectoryContents(params) {
	const isExcluded = createExcludeMatcher(params.excludeDirs);
	await fs$1.mkdir(params.targetDir, { recursive: true });
	const sourceEntries = await fs$1.readdir(params.sourceDir);
	for (const entry of sourceEntries) {
		if (isExcluded(entry)) continue;
		await copyTreeWithoutSymlinks({
			sourcePath: path.join(params.sourceDir, entry),
			targetPath: path.join(params.targetDir, entry)
		});
	}
}
async function movePathWithCopyFallback(params) {
	try {
		await fs$1.rename(params.from, params.to);
		return;
	} catch (error) {
		if (error?.code !== "EXDEV") throw error;
	}
	await fs$1.cp(params.from, params.to, {
		recursive: true,
		force: true,
		dereference: false
	});
	await fs$1.rm(params.from, {
		recursive: true,
		force: true
	});
}
//#endregion
//#region extensions/openshell/src/fs-bridge.ts
function createOpenShellFsBridge(params) {
	return new OpenShellFsBridge(params.sandbox, params.backend);
}
var OpenShellFsBridge = class {
	constructor(sandbox, backend) {
		this.sandbox = sandbox;
		this.backend = backend;
		this.resolveRenameTargets = createWritableRenameTargetResolver((target) => this.resolveTarget(target), (target, action) => this.ensureWritable(target, action));
	}
	resolvePath(params) {
		const target = this.resolveTarget(params);
		return {
			hostPath: target.hostPath,
			relativePath: target.relativePath,
			containerPath: target.containerPath
		};
	}
	async readFile(params) {
		const target = this.resolveTarget(params);
		const handle = await openPinnedReadableFile({
			absolutePath: this.requireHostPath(target),
			rootPath: target.mountHostRoot,
			containerPath: target.containerPath
		});
		try {
			return await handle.readFile();
		} finally {
			await handle.close();
		}
	}
	async writeFile(params) {
		const target = this.resolveTarget(params);
		const hostPath = this.requireHostPath(target);
		this.ensureWritable(target, "write files");
		await assertLocalPathSafety({
			target,
			root: target.mountHostRoot,
			allowMissingLeaf: true,
			allowFinalSymlinkForUnlink: false
		});
		const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data, params.encoding ?? "utf8");
		await writeFileWithinRoot({
			rootDir: target.mountHostRoot,
			relativePath: path.relative(target.mountHostRoot, hostPath),
			data: buffer,
			mkdir: params.mkdir
		});
		await this.backend.syncLocalPathToRemote(hostPath, target.containerPath);
	}
	async mkdirp(params) {
		const target = this.resolveTarget(params);
		const hostPath = this.requireHostPath(target);
		this.ensureWritable(target, "create directories");
		await assertLocalPathSafety({
			target,
			root: target.mountHostRoot,
			allowMissingLeaf: true,
			allowFinalSymlinkForUnlink: false
		});
		await fs$1.mkdir(hostPath, { recursive: true });
		await this.backend.runRemoteShellScript({
			script: "mkdir -p -- \"$1\"",
			args: [target.containerPath],
			signal: params.signal
		});
	}
	async remove(params) {
		const target = this.resolveTarget(params);
		const hostPath = this.requireHostPath(target);
		this.ensureWritable(target, "remove files");
		await assertLocalPathSafety({
			target,
			root: target.mountHostRoot,
			allowMissingLeaf: params.force !== false,
			allowFinalSymlinkForUnlink: true
		});
		await fs$1.rm(hostPath, {
			recursive: params.recursive ?? false,
			force: params.force !== false
		});
		await this.backend.runRemoteShellScript({
			script: params.recursive ? "rm -rf -- \"$1\"" : "if [ -d \"$1\" ] && [ ! -L \"$1\" ]; then rmdir -- \"$1\"; elif [ -e \"$1\" ] || [ -L \"$1\" ]; then rm -f -- \"$1\"; fi",
			args: [target.containerPath],
			signal: params.signal,
			allowFailure: params.force !== false
		});
	}
	async rename(params) {
		const { from, to } = this.resolveRenameTargets(params);
		const fromHostPath = this.requireHostPath(from);
		const toHostPath = this.requireHostPath(to);
		await assertLocalPathSafety({
			target: from,
			root: from.mountHostRoot,
			allowMissingLeaf: false,
			allowFinalSymlinkForUnlink: true
		});
		await assertLocalPathSafety({
			target: to,
			root: to.mountHostRoot,
			allowMissingLeaf: true,
			allowFinalSymlinkForUnlink: false
		});
		await fs$1.mkdir(path.dirname(toHostPath), { recursive: true });
		await movePathWithCopyFallback({
			from: fromHostPath,
			to: toHostPath
		});
		await this.backend.runRemoteShellScript({
			script: "mkdir -p -- \"$(dirname -- \"$2\")\" && mv -- \"$1\" \"$2\"",
			args: [from.containerPath, to.containerPath],
			signal: params.signal
		});
	}
	async stat(params) {
		const target = this.resolveTarget(params);
		const hostPath = this.requireHostPath(target);
		const stats = await fs$1.lstat(hostPath).catch(() => null);
		if (!stats) return null;
		await assertLocalPathSafety({
			target,
			root: target.mountHostRoot,
			allowMissingLeaf: false,
			allowFinalSymlinkForUnlink: false
		});
		return {
			type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
			size: stats.size,
			mtimeMs: stats.mtimeMs
		};
	}
	ensureWritable(target, action) {
		if (this.sandbox.workspaceAccess !== "rw" || !target.writable) throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
	}
	requireHostPath(target) {
		if (!target.hostPath) throw new Error(`OpenShell mirror bridge requires a local host path: ${target.containerPath}`);
		return target.hostPath;
	}
	resolveTarget(params) {
		const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
		const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
		const hasAgentMount = this.sandbox.workspaceAccess !== "none" && workspaceRoot !== agentRoot;
		const agentContainerRoot = (this.backend.remoteAgentWorkspaceDir || "/agent").replace(/\\/g, "/");
		const workspaceContainerRoot = this.sandbox.containerWorkdir.replace(/\\/g, "/");
		const input = params.filePath.trim();
		if (input.startsWith(`${workspaceContainerRoot}/`) || input === workspaceContainerRoot) {
			const relative = path.posix.relative(workspaceContainerRoot, input) || "";
			return {
				hostPath: relative ? path.resolve(workspaceRoot, ...relative.split("/")) : workspaceRoot,
				relativePath: relative,
				containerPath: relative ? path.posix.join(workspaceContainerRoot, relative) : workspaceContainerRoot,
				mountHostRoot: workspaceRoot,
				writable: this.sandbox.workspaceAccess === "rw",
				source: "workspace"
			};
		}
		if (hasAgentMount && (input.startsWith(`${agentContainerRoot}/`) || input === agentContainerRoot)) {
			const relative = path.posix.relative(agentContainerRoot, input) || "";
			return {
				hostPath: relative ? path.resolve(agentRoot, ...relative.split("/")) : agentRoot,
				relativePath: relative ? agentContainerRoot + "/" + relative : agentContainerRoot,
				containerPath: relative ? path.posix.join(agentContainerRoot, relative) : agentContainerRoot,
				mountHostRoot: agentRoot,
				writable: this.sandbox.workspaceAccess === "rw",
				source: "agent"
			};
		}
		const cwd = params.cwd ? path.resolve(params.cwd) : workspaceRoot;
		const hostPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);
		if (isPathInside(workspaceRoot, hostPath)) {
			const relative = path.relative(workspaceRoot, hostPath).split(path.sep).join(path.posix.sep);
			return {
				hostPath,
				relativePath: relative,
				containerPath: relative ? path.posix.join(workspaceContainerRoot, relative) : workspaceContainerRoot,
				mountHostRoot: workspaceRoot,
				writable: this.sandbox.workspaceAccess === "rw",
				source: "workspace"
			};
		}
		if (hasAgentMount && isPathInside(agentRoot, hostPath)) {
			const relative = path.relative(agentRoot, hostPath).split(path.sep).join(path.posix.sep);
			return {
				hostPath,
				relativePath: relative ? `${agentContainerRoot}/${relative}` : agentContainerRoot,
				containerPath: relative ? path.posix.join(agentContainerRoot, relative) : agentContainerRoot,
				mountHostRoot: agentRoot,
				writable: this.sandbox.workspaceAccess === "rw",
				source: "agent"
			};
		}
		throw new Error(`Path escapes sandbox root (${workspaceRoot}): ${params.filePath}`);
	}
};
function isPathInside(root, target) {
	const relative = path.relative(root, target);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function assertLocalPathSafety(params) {
	if (!params.target.hostPath) throw new Error(`Missing local host path for ${params.target.containerPath}`);
	if (!isPathInside(await fs$1.realpath(params.root).catch(() => path.resolve(params.root)), await resolveCanonicalCandidate(params.target.hostPath))) throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`);
	const relative = path.relative(params.root, params.target.hostPath);
	const segments = relative.split(path.sep).filter(Boolean).slice(0, Math.max(0, relative.split(path.sep).filter(Boolean).length));
	let cursor = params.root;
	for (let index = 0; index < segments.length; index += 1) {
		cursor = path.join(cursor, segments[index]);
		const stats = await fs$1.lstat(cursor).catch(() => null);
		if (!stats) {
			if (index === segments.length - 1 && params.allowMissingLeaf) return;
			continue;
		}
		const isFinal = index === segments.length - 1;
		if (stats.isSymbolicLink() && (!isFinal || !params.allowFinalSymlinkForUnlink)) throw new Error(`Sandbox boundary checks failed: ${params.target.containerPath}`);
	}
}
async function resolveCanonicalCandidate(targetPath) {
	const missing = [];
	let cursor = path.resolve(targetPath);
	while (true) {
		if (await fs$1.lstat(cursor).then(() => true).catch(() => false)) {
			const canonical = await fs$1.realpath(cursor).catch(() => cursor);
			return path.resolve(canonical, ...missing);
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) return path.resolve(cursor, ...missing);
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}
async function openPinnedReadableFile(params) {
	const literalRoot = path.resolve(params.rootPath);
	const canonicalRoot = await fs$1.realpath(literalRoot).catch(() => literalRoot);
	const literalPath = path.resolve(params.absolutePath);
	if (!isPathInside(literalRoot, literalPath)) throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.containerPath}`);
	const { flags: openReadFlags, supportsNoFollow } = resolveOpenReadFlags();
	const handle = await fs$1.open(literalPath, openReadFlags);
	try {
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
		if (openedStat.nlink > 1) throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
		const resolvedPath = await resolveOpenedReadablePath(handle.fd);
		if (resolvedPath !== null) {
			if (!isPathInside(canonicalRoot, resolvedPath)) throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
			return handle;
		}
		await assertAncestorChainHasNoSymlinks(literalRoot, literalPath, params.containerPath, { includeLeaf: !supportsNoFollow });
		if (!sameFileIdentity(await fs$1.stat(literalPath), openedStat)) throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
		const postCheckStat = await handle.stat();
		if (!postCheckStat.isFile() || postCheckStat.nlink > 1) throw new Error(`Sandbox boundary checks failed; cannot read files: ${params.containerPath}`);
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}
async function assertAncestorChainHasNoSymlinks(canonicalRoot, targetAbsolutePath, containerPath, options = {}) {
	const relative = path.relative(canonicalRoot, targetAbsolutePath);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
	const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
	const lastIndex = options.includeLeaf ? segments.length : segments.length - 1;
	let cursor = canonicalRoot;
	for (let i = 0; i < lastIndex; i += 1) {
		cursor = path.join(cursor, segments[i]);
		const stat = await fs$1.lstat(cursor).catch(() => null);
		if (!stat) throw new Error(`Sandbox boundary checks failed; cannot read files: ${containerPath}`);
		const isLeaf = i === segments.length - 1;
		if (stat.isSymbolicLink()) throw new Error(`Sandbox boundary checks failed; cannot read files: ${containerPath}`);
		if (!isLeaf && !stat.isDirectory()) throw new Error(`Sandbox boundary checks failed; cannot read files: ${containerPath}`);
	}
}
function resolveOpenReadFlags() {
	const closeOnExec = fs.constants.O_CLOEXEC ?? 0;
	const supportsNoFollow = typeof fs.constants.O_NOFOLLOW === "number";
	const noFollow = supportsNoFollow ? fs.constants.O_NOFOLLOW : 0;
	return {
		flags: fs.constants.O_RDONLY | noFollow | closeOnExec,
		supportsNoFollow
	};
}
async function resolveOpenedReadablePath(fd) {
	for (const fdPath of [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`]) try {
		return normalizeOpenedReadablePath(await fs$1.readlink(fdPath));
	} catch {
		continue;
	}
	return null;
}
function normalizeOpenedReadablePath(openedPath) {
	const withoutDeletedSuffix = openedPath.endsWith(" (deleted)") ? openedPath.slice(0, -10) : openedPath;
	return path.resolve(withoutDeletedSuffix);
}
function sameFileIdentity(left, right, platform = process.platform) {
	if (left.ino !== right.ino) return false;
	if (left.dev === right.dev) return true;
	return platform === "win32" && (left.dev === 0 || right.dev === 0);
}
//#endregion
//#region extensions/openshell/src/backend.ts
function buildOpenShellSshExecEnv() {
	return sanitizeEnvVars(process.env).allowed;
}
function createOpenShellSandboxBackendFactory(params) {
	return async (createParams) => await createOpenShellSandboxBackend({
		...params,
		createParams
	});
}
function createOpenShellSandboxBackendManager(params) {
	return {
		async describeRuntime({ entry, config }) {
			const execContext = {
				config: resolveOpenShellPluginConfigFromConfig(config, params.pluginConfig),
				sandboxName: entry.containerName
			};
			const result = await runOpenShellCli({
				context: execContext,
				args: [
					"sandbox",
					"get",
					entry.containerName
				]
			});
			const configuredSource = execContext.config.from;
			return {
				running: result.code === 0,
				actualConfigLabel: entry.image,
				configLabelMatch: entry.image === configuredSource
			};
		},
		async removeRuntime({ entry }) {
			await runOpenShellCli({
				context: {
					config: params.pluginConfig,
					sandboxName: entry.containerName
				},
				args: [
					"sandbox",
					"delete",
					entry.containerName
				]
			});
		}
	};
}
async function createOpenShellSandboxBackend(params) {
	if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) throw new Error("OpenShell sandbox backend does not support sandbox.docker.binds.");
	const sandboxName = buildOpenShellSandboxName(params.createParams.scopeKey);
	const execContext = {
		config: params.pluginConfig,
		sandboxName
	};
	const impl = new OpenShellSandboxBackendImpl({
		createParams: params.createParams,
		execContext,
		remoteWorkspaceDir: params.pluginConfig.remoteWorkspaceDir,
		remoteAgentWorkspaceDir: params.pluginConfig.remoteAgentWorkspaceDir
	});
	return {
		id: "openshell",
		runtimeId: sandboxName,
		runtimeLabel: sandboxName,
		workdir: params.pluginConfig.remoteWorkspaceDir,
		env: params.createParams.cfg.docker.env,
		mode: params.pluginConfig.mode,
		configLabel: params.pluginConfig.from,
		configLabelKind: "Source",
		buildExecSpec: async ({ command, workdir, env, usePty }) => {
			const pending = await impl.prepareExec({
				command,
				workdir,
				env,
				usePty
			});
			return {
				argv: pending.argv,
				env: buildOpenShellSshExecEnv(),
				stdinMode: "pipe-open",
				finalizeToken: pending.token
			};
		},
		finalizeExec: async ({ token }) => {
			await impl.finalizeExec(token);
		},
		runShellCommand: async (command) => await impl.runRemoteShellScript(command),
		createFsBridge: ({ sandbox }) => params.pluginConfig.mode === "remote" ? createRemoteShellSandboxFsBridge({
			sandbox,
			runtime: impl.asHandle()
		}) : createOpenShellFsBridge({
			sandbox,
			backend: impl.asHandle()
		}),
		remoteWorkspaceDir: params.pluginConfig.remoteWorkspaceDir,
		remoteAgentWorkspaceDir: params.pluginConfig.remoteAgentWorkspaceDir,
		runRemoteShellScript: async (command) => await impl.runRemoteShellScript(command),
		syncLocalPathToRemote: async (localPath, remotePath) => await impl.syncLocalPathToRemote(localPath, remotePath)
	};
}
var OpenShellSandboxBackendImpl = class {
	constructor(params) {
		this.params = params;
		this.ensurePromise = null;
		this.remoteSeedPending = false;
	}
	asHandle() {
		return {
			id: "openshell",
			runtimeId: this.params.execContext.sandboxName,
			runtimeLabel: this.params.execContext.sandboxName,
			workdir: this.params.remoteWorkspaceDir,
			env: this.params.createParams.cfg.docker.env,
			mode: this.params.execContext.config.mode,
			configLabel: this.params.execContext.config.from,
			configLabelKind: "Source",
			remoteWorkspaceDir: this.params.remoteWorkspaceDir,
			remoteAgentWorkspaceDir: this.params.remoteAgentWorkspaceDir,
			buildExecSpec: async ({ command, workdir, env, usePty }) => {
				const pending = await this.prepareExec({
					command,
					workdir,
					env,
					usePty
				});
				return {
					argv: pending.argv,
					env: buildOpenShellSshExecEnv(),
					stdinMode: "pipe-open",
					finalizeToken: pending.token
				};
			},
			finalizeExec: async ({ token }) => {
				await this.finalizeExec(token);
			},
			runShellCommand: async (command) => await this.runRemoteShellScript(command),
			createFsBridge: ({ sandbox }) => this.params.execContext.config.mode === "remote" ? createRemoteShellSandboxFsBridge({
				sandbox,
				runtime: this.asHandle()
			}) : createOpenShellFsBridge({
				sandbox,
				backend: this.asHandle()
			}),
			runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
			syncLocalPathToRemote: async (localPath, remotePath) => await this.syncLocalPathToRemote(localPath, remotePath)
		};
	}
	async prepareExec(params) {
		await this.ensureSandboxExists();
		if (this.params.execContext.config.mode === "mirror") await this.syncWorkspaceToRemote();
		else await this.maybeSeedRemoteWorkspace();
		const sshSession = await createOpenShellSshSession({ context: this.params.execContext });
		const remoteCommand = buildExecRemoteCommand({
			command: params.command,
			workdir: params.workdir ?? this.params.remoteWorkspaceDir,
			env: params.env
		});
		return {
			argv: [
				"ssh",
				"-F",
				sshSession.configPath,
				...params.usePty ? [
					"-tt",
					"-o",
					"RequestTTY=force",
					"-o",
					"SetEnv=TERM=xterm-256color"
				] : [
					"-T",
					"-o",
					"RequestTTY=no"
				],
				sshSession.host,
				remoteCommand
			],
			token: { sshSession }
		};
	}
	async finalizeExec(token) {
		try {
			if (this.params.execContext.config.mode === "mirror") await this.syncWorkspaceFromRemote();
		} finally {
			if (token?.sshSession) await disposeSshSandboxSession(token.sshSession);
		}
	}
	async runRemoteShellScript(params) {
		await this.ensureSandboxExists();
		await this.maybeSeedRemoteWorkspace();
		return await this.runRemoteShellScriptInternal(params);
	}
	async runRemoteShellScriptInternal(params) {
		const session = await createOpenShellSshSession({ context: this.params.execContext });
		try {
			return await runSshSandboxCommand({
				session,
				remoteCommand: buildRemoteCommand([
					"/bin/sh",
					"-c",
					params.script,
					"openclaw-openshell-fs",
					...params.args ?? []
				]),
				stdin: params.stdin,
				allowFailure: params.allowFailure,
				signal: params.signal
			});
		} finally {
			await disposeSshSandboxSession(session);
		}
	}
	async syncLocalPathToRemote(localPath, remotePath) {
		await this.ensureSandboxExists();
		await this.maybeSeedRemoteWorkspace();
		const stats = await fs$1.lstat(localPath).catch(() => null);
		if (!stats) {
			await this.runRemoteShellScript({
				script: "rm -rf -- \"$1\"",
				args: [remotePath],
				allowFailure: true
			});
			return;
		}
		if (stats.isSymbolicLink()) {
			await this.runRemoteShellScript({
				script: "rm -rf -- \"$1\"",
				args: [remotePath],
				allowFailure: true
			});
			return;
		}
		if (stats.isDirectory()) {
			await this.runRemoteShellScript({
				script: "mkdir -p -- \"$1\"",
				args: [remotePath]
			});
			return;
		}
		await this.runRemoteShellScript({
			script: "mkdir -p -- \"$(dirname -- \"$1\")\"",
			args: [remotePath]
		});
		const result = await runOpenShellCli({
			context: this.params.execContext,
			args: [
				"sandbox",
				"upload",
				"--no-git-ignore",
				this.params.execContext.sandboxName,
				localPath,
				path.posix.dirname(remotePath)
			],
			cwd: this.params.createParams.workspaceDir
		});
		if (result.code !== 0) throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
	}
	async ensureSandboxExists() {
		if (this.ensurePromise) return await this.ensurePromise;
		this.ensurePromise = this.ensureSandboxExistsInner();
		try {
			await this.ensurePromise;
		} catch (error) {
			this.ensurePromise = null;
			throw error;
		}
	}
	async ensureSandboxExistsInner() {
		if ((await runOpenShellCli({
			context: this.params.execContext,
			args: [
				"sandbox",
				"get",
				this.params.execContext.sandboxName
			],
			cwd: this.params.createParams.workspaceDir
		})).code === 0) return;
		const createArgs = [
			"sandbox",
			"create",
			"--name",
			this.params.execContext.sandboxName,
			"--from",
			this.params.execContext.config.from,
			...this.params.execContext.config.policy ? ["--policy", this.params.execContext.config.policy] : [],
			...this.params.execContext.config.gpu ? ["--gpu"] : [],
			...this.params.execContext.config.autoProviders ? ["--auto-providers"] : ["--no-auto-providers"],
			...this.params.execContext.config.providers.flatMap((provider) => ["--provider", provider]),
			"--",
			"true"
		];
		const createResult = await runOpenShellCli({
			context: this.params.execContext,
			args: createArgs,
			cwd: this.params.createParams.workspaceDir,
			timeoutMs: Math.max(this.params.execContext.config.timeoutMs, 3e5)
		});
		if (createResult.code !== 0) throw new Error(createResult.stderr.trim() || "openshell sandbox create failed");
		this.remoteSeedPending = true;
	}
	async syncWorkspaceToRemote() {
		await this.runRemoteShellScriptInternal({
			script: "mkdir -p -- \"$1\" && find \"$1\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
			args: [this.params.remoteWorkspaceDir]
		});
		await this.uploadPathToRemote(this.params.createParams.workspaceDir, this.params.remoteWorkspaceDir);
		if (this.params.createParams.cfg.workspaceAccess !== "none" && path.resolve(this.params.createParams.agentWorkspaceDir) !== path.resolve(this.params.createParams.workspaceDir)) {
			await this.runRemoteShellScriptInternal({
				script: "mkdir -p -- \"$1\" && find \"$1\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
				args: [this.params.remoteAgentWorkspaceDir]
			});
			await this.uploadPathToRemote(this.params.createParams.agentWorkspaceDir, this.params.remoteAgentWorkspaceDir);
		}
	}
	async syncWorkspaceFromRemote() {
		const tmpDir = await fs$1.mkdtemp(path.join(resolveOpenShellTmpRoot(), "openclaw-openshell-sync-"));
		try {
			const result = await runOpenShellCli({
				context: this.params.execContext,
				args: [
					"sandbox",
					"download",
					this.params.execContext.sandboxName,
					this.params.remoteWorkspaceDir,
					tmpDir
				],
				cwd: this.params.createParams.workspaceDir
			});
			if (result.code !== 0) throw new Error(result.stderr.trim() || "openshell sandbox download failed");
			await replaceDirectoryContents({
				sourceDir: tmpDir,
				targetDir: this.params.createParams.workspaceDir,
				excludeDirs: DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS
			});
		} finally {
			await fs$1.rm(tmpDir, {
				recursive: true,
				force: true
			});
		}
	}
	async uploadPathToRemote(localPath, remotePath) {
		const tmpDir = await fs$1.mkdtemp(path.join(resolveOpenShellTmpRoot(), "openclaw-openshell-upload-"));
		try {
			await stageDirectoryContents({
				sourceDir: localPath,
				targetDir: tmpDir
			});
			const result = await runOpenShellCli({
				context: this.params.execContext,
				args: [
					"sandbox",
					"upload",
					"--no-git-ignore",
					this.params.execContext.sandboxName,
					tmpDir,
					remotePath
				],
				cwd: this.params.createParams.workspaceDir
			});
			if (result.code !== 0) throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
		} finally {
			await fs$1.rm(tmpDir, {
				recursive: true,
				force: true
			});
		}
	}
	async maybeSeedRemoteWorkspace() {
		if (!this.remoteSeedPending) return;
		this.remoteSeedPending = false;
		try {
			await this.syncWorkspaceToRemote();
		} catch (error) {
			this.remoteSeedPending = true;
			throw error;
		}
	}
};
function resolveOpenShellPluginConfigFromConfig(config, fallback) {
	const pluginConfig = config.plugins?.entries?.openshell?.config;
	if (!pluginConfig) return fallback;
	return resolveOpenShellPluginConfig(pluginConfig);
}
function buildOpenShellSandboxName(scopeKey) {
	const trimmed = scopeKey.trim() || "session";
	const safe = normalizeLowercaseStringOrEmpty(trimmed).replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	const hash = Array.from(trimmed).reduce((acc, char) => (acc * 33 ^ char.charCodeAt(0)) >>> 0, 5381);
	return `openclaw-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
function resolveOpenShellTmpRoot() {
	return path.resolve(resolvePreferredOpenClawTmpDir());
}
//#endregion
//#region extensions/openshell/index.ts
var openshell_default = definePluginEntry({
	id: "openshell",
	name: "OpenShell Sandbox",
	description: "OpenShell-backed sandbox runtime for agent exec and file tools.",
	configSchema: createOpenShellPluginConfigSchema(),
	register(api) {
		if (api.registrationMode !== "full") return;
		const pluginConfig = resolveOpenShellPluginConfig(api.pluginConfig);
		registerSandboxBackend("openshell", {
			factory: createOpenShellSandboxBackendFactory({ pluginConfig }),
			manager: createOpenShellSandboxBackendManager({ pluginConfig })
		});
	}
});
//#endregion
export { openshell_default as default };
