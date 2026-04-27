import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { createRemoteShellSandboxFsBridge, } from "./remote-fs-bridge.js";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";
import { buildExecRemoteCommand, buildRemoteCommand, buildSshSandboxArgv, createSshSandboxSessionFromSettings, disposeSshSandboxSession, runSshSandboxCommand, uploadDirectoryToSshTarget, } from "./ssh.js";
export const sshSandboxBackendManager = {
    async describeRuntime({ entry, config, agentId }) {
        const cfg = resolveSandboxConfigForAgent(config, agentId);
        if (cfg.backend !== "ssh" || !cfg.ssh.target) {
            return {
                running: false,
                actualConfigLabel: cfg.ssh.target,
                configLabelMatch: false,
            };
        }
        const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
        const session = await createSshSandboxSessionFromSettings({
            ...cfg.ssh,
            target: cfg.ssh.target,
        });
        try {
            const result = await runSshSandboxCommand({
                session,
                remoteCommand: buildRemoteCommand([
                    "/bin/sh",
                    "-c",
                    'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
                    "openclaw-sandbox-check",
                    runtimePaths.runtimeRootDir,
                ]),
            });
            return {
                running: result.stdout.toString("utf8").trim() === "1",
                actualConfigLabel: cfg.ssh.target,
                configLabelMatch: entry.image === cfg.ssh.target,
            };
        }
        finally {
            await disposeSshSandboxSession(session);
        }
    },
    async removeRuntime({ entry, config, agentId }) {
        const cfg = resolveSandboxConfigForAgent(config, agentId);
        if (cfg.backend !== "ssh" || !cfg.ssh.target) {
            return;
        }
        const runtimePaths = resolveSshRuntimePaths(cfg.ssh.workspaceRoot, entry.sessionKey);
        const session = await createSshSandboxSessionFromSettings({
            ...cfg.ssh,
            target: cfg.ssh.target,
        });
        try {
            await runSshSandboxCommand({
                session,
                remoteCommand: buildRemoteCommand([
                    "/bin/sh",
                    "-c",
                    'rm -rf -- "$1"',
                    "openclaw-sandbox-remove",
                    runtimePaths.runtimeRootDir,
                ]),
                allowFailure: true,
            });
        }
        finally {
            await disposeSshSandboxSession(session);
        }
    },
};
export async function createSshSandboxBackend(params) {
    if ((params.cfg.docker.binds?.length ?? 0) > 0) {
        throw new Error("SSH sandbox backend does not support sandbox.docker.binds.");
    }
    const target = params.cfg.ssh.target;
    if (!target) {
        throw new Error('Sandbox backend "ssh" requires agents.defaults.sandbox.ssh.target.');
    }
    const runtimePaths = resolveSshRuntimePaths(params.cfg.ssh.workspaceRoot, params.scopeKey);
    const impl = new SshSandboxBackendImpl({
        createParams: params,
        target,
        runtimePaths,
    });
    return impl.asHandle();
}
class SshSandboxBackendImpl {
    params;
    ensurePromise = null;
    constructor(params) {
        this.params = params;
    }
    asHandle() {
        return {
            id: "ssh",
            runtimeId: this.params.runtimePaths.runtimeId,
            runtimeLabel: this.params.runtimePaths.runtimeId,
            workdir: this.params.runtimePaths.remoteWorkspaceDir,
            env: this.params.createParams.cfg.docker.env,
            configLabel: this.params.target,
            configLabelKind: "Target",
            remoteWorkspaceDir: this.params.runtimePaths.remoteWorkspaceDir,
            remoteAgentWorkspaceDir: this.params.runtimePaths.remoteAgentWorkspaceDir,
            buildExecSpec: async ({ command, workdir, env, usePty }) => {
                await this.ensureRuntime();
                const sshSession = await this.createSession();
                const remoteCommand = buildExecRemoteCommand({
                    command,
                    workdir: workdir ?? this.params.runtimePaths.remoteWorkspaceDir,
                    env,
                });
                return {
                    argv: buildSshSandboxArgv({
                        session: sshSession,
                        remoteCommand,
                        tty: usePty,
                    }),
                    env: sanitizeEnvVars(process.env).allowed,
                    stdinMode: "pipe-open",
                    finalizeToken: { sshSession },
                };
            },
            finalizeExec: async ({ token }) => {
                const sshSession = token?.sshSession;
                if (sshSession) {
                    await disposeSshSandboxSession(sshSession);
                }
            },
            runShellCommand: async (command) => await this.runRemoteShellScript(command),
            createFsBridge: ({ sandbox }) => createRemoteShellSandboxFsBridge({
                sandbox,
                runtime: this.asHandle(),
            }),
            runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
        };
    }
    async createSession() {
        return await createSshSandboxSessionFromSettings({
            ...this.params.createParams.cfg.ssh,
            target: this.params.target,
        });
    }
    async ensureRuntime() {
        if (this.ensurePromise) {
            return await this.ensurePromise;
        }
        this.ensurePromise = this.ensureRuntimeInner();
        try {
            await this.ensurePromise;
        }
        catch (error) {
            this.ensurePromise = null;
            throw error;
        }
    }
    async ensureRuntimeInner() {
        const session = await this.createSession();
        try {
            const exists = await runSshSandboxCommand({
                session,
                remoteCommand: buildRemoteCommand([
                    "/bin/sh",
                    "-c",
                    'if [ -d "$1" ]; then printf "1\\n"; else printf "0\\n"; fi',
                    "openclaw-sandbox-check",
                    this.params.runtimePaths.runtimeRootDir,
                ]),
            });
            if (exists.stdout.toString("utf8").trim() === "1") {
                return;
            }
            await this.replaceRemoteDirectoryFromLocal(session, this.params.createParams.workspaceDir, this.params.runtimePaths.remoteWorkspaceDir);
            if (this.params.createParams.cfg.workspaceAccess !== "none" &&
                path.resolve(this.params.createParams.agentWorkspaceDir) !==
                    path.resolve(this.params.createParams.workspaceDir)) {
                await this.replaceRemoteDirectoryFromLocal(session, this.params.createParams.agentWorkspaceDir, this.params.runtimePaths.remoteAgentWorkspaceDir);
            }
        }
        finally {
            await disposeSshSandboxSession(session);
        }
    }
    async replaceRemoteDirectoryFromLocal(session, localDir, remoteDir) {
        await runSshSandboxCommand({
            session,
            remoteCommand: buildRemoteCommand([
                "/bin/sh",
                "-c",
                'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
                "openclaw-sandbox-clear",
                remoteDir,
            ]),
        });
        await uploadDirectoryToSshTarget({
            session,
            localDir,
            remoteDir,
        });
    }
    async runRemoteShellScript(params) {
        await this.ensureRuntime();
        const session = await this.createSession();
        try {
            return await runSshSandboxCommand({
                session,
                remoteCommand: buildRemoteCommand([
                    "/bin/sh",
                    "-c",
                    params.script,
                    "openclaw-sandbox-fs",
                    ...(params.args ?? []),
                ]),
                stdin: params.stdin,
                allowFailure: params.allowFailure,
                signal: params.signal,
            });
        }
        finally {
            await disposeSshSandboxSession(session);
        }
    }
}
function resolveSshRuntimePaths(workspaceRoot, scopeKey) {
    const runtimeId = buildSshSandboxRuntimeId(scopeKey);
    const runtimeRootDir = path.posix.join(workspaceRoot, runtimeId);
    return {
        runtimeId,
        runtimeRootDir,
        remoteWorkspaceDir: path.posix.join(runtimeRootDir, "workspace"),
        remoteAgentWorkspaceDir: path.posix.join(runtimeRootDir, "agent"),
    };
}
function buildSshSandboxRuntimeId(scopeKey) {
    const trimmed = scopeKey.trim() || "session";
    const safe = normalizeLowercaseStringOrEmpty(trimmed)
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32);
    const hash = Array.from(trimmed).reduce((acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0, 5381);
    return `openclaw-ssh-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}
