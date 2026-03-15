import "../../provider-env-vars-BfZUtZAn.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import { n as resolvePreferredOpenClawTmpDir } from "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import { Bd as buildExecRemoteCommand, Hd as disposeSshSandboxSession, Ud as runSshSandboxCommand, Vd as createSshSandboxSessionFromConfigText, Wd as shellEscape, qd as createRemoteShellSandboxFsBridge, zd as registerSandboxBackend } from "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import { t as runPluginCommandWithTimeout } from "../../run-command-Psw08BkS.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
//#region extensions/openshell/src/cli.ts
function buildOpenShellBaseArgv(config) {
	const argv = [config.command];
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
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function trimString(value) {
	if (typeof value !== "string") return;
	return value.trim() || void 0;
}
function normalizeProviders(value) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) return null;
	const seen = /* @__PURE__ */ new Set();
	const providers = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !entry.trim()) return null;
		const normalized = entry.trim();
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		providers.push(normalized);
	}
	return providers;
}
function normalizeRemotePath(value, fallback) {
	const candidate = value ?? fallback;
	const normalized = path.posix.normalize(candidate.trim() || fallback);
	if (!normalized.startsWith("/")) throw new Error(`OpenShell remote path must be absolute: ${candidate}`);
	return normalized;
}
function createOpenShellPluginConfigSchema() {
	const safeParse = (value) => {
		if (value === void 0) return {
			success: true,
			data: void 0
		};
		if (!isRecord(value)) return {
			success: false,
			error: { issues: [{
				path: [],
				message: "expected config object"
			}] }
		};
		const allowedKeys = new Set([
			"mode",
			"command",
			"gateway",
			"gatewayEndpoint",
			"from",
			"policy",
			"providers",
			"gpu",
			"autoProviders",
			"remoteWorkspaceDir",
			"remoteAgentWorkspaceDir",
			"timeoutSeconds"
		]);
		for (const key of Object.keys(value)) if (!allowedKeys.has(key)) return {
			success: false,
			error: { issues: [{
				path: [key],
				message: `unknown config key: ${key}`
			}] }
		};
		const providers = normalizeProviders(value.providers);
		if (providers === null) return {
			success: false,
			error: { issues: [{
				path: ["providers"],
				message: "providers must be an array of strings"
			}] }
		};
		const timeoutSeconds = value.timeoutSeconds;
		if (timeoutSeconds !== void 0 && (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 1)) return {
			success: false,
			error: { issues: [{
				path: ["timeoutSeconds"],
				message: "timeoutSeconds must be a number >= 1"
			}] }
		};
		for (const key of ["gpu", "autoProviders"]) {
			const candidate = value[key];
			if (candidate !== void 0 && typeof candidate !== "boolean") return {
				success: false,
				error: { issues: [{
					path: [key],
					message: `${key} must be a boolean`
				}] }
			};
		}
		return {
			success: true,
			data: {
				mode: trimString(value.mode),
				command: trimString(value.command),
				gateway: trimString(value.gateway),
				gatewayEndpoint: trimString(value.gatewayEndpoint),
				from: trimString(value.from),
				policy: trimString(value.policy),
				providers,
				gpu: value.gpu,
				autoProviders: value.autoProviders,
				remoteWorkspaceDir: trimString(value.remoteWorkspaceDir),
				remoteAgentWorkspaceDir: trimString(value.remoteAgentWorkspaceDir),
				timeoutSeconds
			}
		};
	};
	return {
		safeParse,
		jsonSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				command: { type: "string" },
				mode: {
					type: "string",
					enum: ["mirror", "remote"]
				},
				gateway: { type: "string" },
				gatewayEndpoint: { type: "string" },
				from: { type: "string" },
				policy: { type: "string" },
				providers: {
					type: "array",
					items: { type: "string" }
				},
				gpu: { type: "boolean" },
				autoProviders: { type: "boolean" },
				remoteWorkspaceDir: { type: "string" },
				remoteAgentWorkspaceDir: { type: "string" },
				timeoutSeconds: {
					type: "number",
					minimum: 1
				}
			}
		}
	};
}
function resolveOpenShellPluginConfig(value) {
	const parsed = createOpenShellPluginConfigSchema().safeParse?.(value);
	if (!parsed || !parsed.success) {
		const message = (parsed && !parsed.success ? parsed.error?.issues : void 0)?.map((issue) => issue.message).join(", ") || "invalid config";
		throw new Error(`Invalid openshell plugin config: ${message}`);
	}
	const cfg = parsed.data ?? {} ?? {};
	const mode = cfg.mode ?? DEFAULT_MODE;
	if (mode !== "mirror" && mode !== "remote") throw new Error(`Invalid openshell plugin config: mode must be one of mirror, remote`);
	return {
		mode,
		command: cfg.command ?? DEFAULT_COMMAND,
		gateway: cfg.gateway,
		gatewayEndpoint: cfg.gatewayEndpoint,
		from: cfg.from ?? DEFAULT_SOURCE,
		policy: cfg.policy,
		providers: cfg.providers ?? [],
		gpu: cfg.gpu ?? false,
		autoProviders: cfg.autoProviders ?? true,
		remoteWorkspaceDir: normalizeRemotePath(cfg.remoteWorkspaceDir, DEFAULT_REMOTE_WORKSPACE_DIR),
		remoteAgentWorkspaceDir: normalizeRemotePath(cfg.remoteAgentWorkspaceDir, DEFAULT_REMOTE_AGENT_WORKSPACE_DIR),
		timeoutMs: typeof cfg.timeoutSeconds === "number" ? Math.floor(cfg.timeoutSeconds * 1e3) : DEFAULT_TIMEOUT_MS
	};
}
//#endregion
//#region extensions/openshell/src/mirror.ts
async function replaceDirectoryContents(params) {
	await fs.mkdir(params.targetDir, { recursive: true });
	const existing = await fs.readdir(params.targetDir);
	await Promise.all(existing.map((entry) => fs.rm(path.join(params.targetDir, entry), {
		recursive: true,
		force: true
	})));
	const sourceEntries = await fs.readdir(params.sourceDir);
	for (const entry of sourceEntries) await fs.cp(path.join(params.sourceDir, entry), path.join(params.targetDir, entry), {
		recursive: true,
		force: true,
		dereference: false
	});
}
async function movePathWithCopyFallback(params) {
	try {
		await fs.rename(params.from, params.to);
		return;
	} catch (error) {
		if (error?.code !== "EXDEV") throw error;
	}
	await fs.cp(params.from, params.to, {
		recursive: true,
		force: true,
		dereference: false
	});
	await fs.rm(params.from, {
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
		const hostPath = this.requireHostPath(target);
		await assertLocalPathSafety({
			target,
			root: target.mountHostRoot,
			allowMissingLeaf: false,
			allowFinalSymlinkForUnlink: false
		});
		return await fs.readFile(hostPath);
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
		const parentDir = path.dirname(hostPath);
		if (params.mkdir !== false) await fs.mkdir(parentDir, { recursive: true });
		const tempPath = path.join(parentDir, `.openclaw-openshell-write-${path.basename(hostPath)}-${process.pid}-${Date.now()}`);
		await fs.writeFile(tempPath, buffer);
		await fs.rename(tempPath, hostPath);
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
		await fs.mkdir(hostPath, { recursive: true });
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
		await fs.rm(hostPath, {
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
		const from = this.resolveTarget({
			filePath: params.from,
			cwd: params.cwd
		});
		const to = this.resolveTarget({
			filePath: params.to,
			cwd: params.cwd
		});
		const fromHostPath = this.requireHostPath(from);
		const toHostPath = this.requireHostPath(to);
		this.ensureWritable(from, "rename files");
		this.ensureWritable(to, "rename files");
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
		await fs.mkdir(path.dirname(toHostPath), { recursive: true });
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
		const stats = await fs.lstat(hostPath).catch(() => null);
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
	if (!isPathInside(await fs.realpath(params.root).catch(() => path.resolve(params.root)), await resolveCanonicalCandidate(params.target.hostPath))) throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`);
	const relative = path.relative(params.root, params.target.hostPath);
	const segments = relative.split(path.sep).filter(Boolean).slice(0, Math.max(0, relative.split(path.sep).filter(Boolean).length));
	let cursor = params.root;
	for (let index = 0; index < segments.length; index += 1) {
		cursor = path.join(cursor, segments[index]);
		const stats = await fs.lstat(cursor).catch(() => null);
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
		if (await fs.lstat(cursor).then(() => true).catch(() => false)) {
			const canonical = await fs.realpath(cursor).catch(() => cursor);
			return path.resolve(canonical, ...missing);
		}
		const parent = path.dirname(cursor);
		if (parent === cursor) return path.resolve(cursor, ...missing);
		missing.unshift(path.basename(cursor));
		cursor = parent;
	}
}
//#endregion
//#region extensions/openshell/src/backend.ts
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
				env: process.env,
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
		const self = this;
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
				const pending = await self.prepareExec({
					command,
					workdir,
					env,
					usePty
				});
				return {
					argv: pending.argv,
					env: process.env,
					stdinMode: "pipe-open",
					finalizeToken: pending.token
				};
			},
			finalizeExec: async ({ token }) => {
				await self.finalizeExec(token);
			},
			runShellCommand: async (command) => await self.runRemoteShellScript(command),
			createFsBridge: ({ sandbox }) => this.params.execContext.config.mode === "remote" ? createRemoteShellSandboxFsBridge({
				sandbox,
				runtime: self.asHandle()
			}) : createOpenShellFsBridge({
				sandbox,
				backend: self.asHandle()
			}),
			runRemoteShellScript: async (command) => await self.runRemoteShellScript(command),
			syncLocalPathToRemote: async (localPath, remotePath) => await self.syncLocalPathToRemote(localPath, remotePath)
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
		const stats = await fs.lstat(localPath).catch(() => null);
		if (!stats) {
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
		const tmpDir = await fs.mkdtemp(path.join(resolveOpenShellTmpRoot(), "openclaw-openshell-sync-"));
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
				targetDir: this.params.createParams.workspaceDir
			});
		} finally {
			await fs.rm(tmpDir, {
				recursive: true,
				force: true
			});
		}
	}
	async uploadPathToRemote(localPath, remotePath) {
		const result = await runOpenShellCli({
			context: this.params.execContext,
			args: [
				"sandbox",
				"upload",
				"--no-git-ignore",
				this.params.execContext.sandboxName,
				localPath,
				remotePath
			],
			cwd: this.params.createParams.workspaceDir
		});
		if (result.code !== 0) throw new Error(result.stderr.trim() || "openshell sandbox upload failed");
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
	const safe = trimmed.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	const hash = Array.from(trimmed).reduce((acc, char) => (acc * 33 ^ char.charCodeAt(0)) >>> 0, 5381);
	return `openclaw-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
function resolveOpenShellTmpRoot() {
	return path.resolve(resolvePreferredOpenClawTmpDir() ?? os.tmpdir());
}
//#endregion
//#region extensions/openshell/index.ts
const plugin = {
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
};
//#endregion
export { plugin as default };
