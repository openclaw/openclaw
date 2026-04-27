import fs from "node:fs";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { runDockerSandboxShellCommand } from "./docker-backend.js";
import { buildPinnedMkdirpPlan, buildPinnedRemovePlan, buildPinnedRenamePlan, buildPinnedWritePlan, } from "./fs-bridge-mutation-helper.js";
import { SandboxFsPathGuard } from "./fs-bridge-path-safety.js";
import { buildStatPlan } from "./fs-bridge-shell-command-plans.js";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts, } from "./fs-paths.js";
export function createSandboxFsBridge(params) {
    return new SandboxFsBridgeImpl(params.sandbox);
}
class SandboxFsBridgeImpl {
    sandbox;
    mounts;
    pathGuard;
    constructor(sandbox) {
        this.sandbox = sandbox;
        this.mounts = buildSandboxFsMounts(sandbox);
        const mountsByContainer = [...this.mounts].toSorted((a, b) => b.containerRoot.length - a.containerRoot.length);
        this.pathGuard = new SandboxFsPathGuard({
            mountsByContainer,
            runCommand: (script, options) => this.runCommand(script, options),
        });
    }
    resolvePath(params) {
        const target = this.resolveResolvedPath(params);
        return {
            hostPath: target.hostPath,
            relativePath: target.relativePath,
            containerPath: target.containerPath,
        };
    }
    async readFile(params) {
        const target = this.resolveResolvedPath(params);
        return this.readPinnedFile(target);
    }
    async writeFile(params) {
        const target = this.resolveResolvedPath(params);
        this.ensureWriteAccess(target, "write files");
        const writeCheck = {
            target,
            options: { action: "write files", requireWritable: true },
        };
        await this.pathGuard.assertPathSafety(target, writeCheck.options);
        const buffer = Buffer.isBuffer(params.data)
            ? params.data
            : Buffer.from(params.data, params.encoding ?? "utf8");
        const pinnedWriteTarget = await this.pathGuard.resolveAnchoredPinnedEntry(target, "write files");
        await this.runCheckedCommand({
            ...buildPinnedWritePlan({
                check: writeCheck,
                pinned: pinnedWriteTarget,
                mkdir: params.mkdir !== false,
            }),
            stdin: buffer,
            signal: params.signal,
        });
    }
    async mkdirp(params) {
        const target = this.resolveResolvedPath(params);
        this.ensureWriteAccess(target, "create directories");
        const mkdirCheck = {
            target,
            options: {
                action: "create directories",
                requireWritable: true,
                allowedType: "directory",
            },
        };
        await this.runCheckedCommand({
            ...buildPinnedMkdirpPlan({
                check: mkdirCheck,
                pinned: this.pathGuard.resolvePinnedDirectoryEntry(target, "create directories"),
            }),
            signal: params.signal,
        });
    }
    async remove(params) {
        const target = this.resolveResolvedPath(params);
        this.ensureWriteAccess(target, "remove files");
        const removeCheck = {
            target,
            options: {
                action: "remove files",
                requireWritable: true,
            },
        };
        await this.runCheckedCommand({
            ...buildPinnedRemovePlan({
                check: removeCheck,
                pinned: this.pathGuard.resolvePinnedEntry(target, "remove files"),
                recursive: params.recursive,
                force: params.force,
            }),
            signal: params.signal,
        });
    }
    async rename(params) {
        const from = this.resolveResolvedPath({ filePath: params.from, cwd: params.cwd });
        const to = this.resolveResolvedPath({ filePath: params.to, cwd: params.cwd });
        this.ensureWriteAccess(from, "rename files");
        this.ensureWriteAccess(to, "rename files");
        const fromCheck = {
            target: from,
            options: {
                action: "rename files",
                requireWritable: true,
            },
        };
        const toCheck = {
            target: to,
            options: {
                action: "rename files",
                requireWritable: true,
            },
        };
        await this.runCheckedCommand({
            ...buildPinnedRenamePlan({
                fromCheck,
                toCheck,
                from: this.pathGuard.resolvePinnedEntry(from, "rename files"),
                to: this.pathGuard.resolvePinnedEntry(to, "rename files"),
            }),
            signal: params.signal,
        });
    }
    async stat(params) {
        const target = this.resolveResolvedPath(params);
        const anchoredTarget = await this.pathGuard.resolveAnchoredSandboxEntry(target, "stat files");
        const result = await this.runPlannedCommand(buildStatPlan(target, anchoredTarget), params.signal);
        if (result.code !== 0) {
            const stderr = result.stderr.toString("utf8");
            if (stderr.includes("No such file or directory")) {
                return null;
            }
            const message = stderr.trim() || `stat failed with code ${result.code}`;
            throw new Error(`stat failed for ${target.containerPath}: ${message}`);
        }
        const text = result.stdout.toString("utf8").trim();
        const [typeRaw, sizeRaw, mtimeRaw] = text.split("|");
        const size = Number.parseInt(sizeRaw ?? "0", 10);
        const mtime = Number.parseInt(mtimeRaw ?? "0", 10) * 1000;
        return {
            type: coerceStatType(typeRaw),
            size: Number.isFinite(size) ? size : 0,
            mtimeMs: Number.isFinite(mtime) ? mtime : 0,
        };
    }
    async runCommand(script, options = {}) {
        const backend = this.sandbox.backend;
        if (backend) {
            return await backend.runShellCommand({
                script,
                args: options.args,
                stdin: options.stdin,
                allowFailure: options.allowFailure,
                signal: options.signal,
            });
        }
        return await runDockerSandboxShellCommand({
            containerName: this.sandbox.containerName,
            script,
            args: options.args,
            stdin: options.stdin,
            allowFailure: options.allowFailure,
            signal: options.signal,
        });
    }
    async readPinnedFile(target) {
        const opened = await this.pathGuard.openReadableFile(target);
        try {
            return fs.readFileSync(opened.fd);
        }
        finally {
            fs.closeSync(opened.fd);
        }
    }
    async runCheckedCommand(plan) {
        await this.pathGuard.assertPathChecks(plan.checks);
        if (plan.recheckBeforeCommand) {
            await this.pathGuard.assertPathChecks(plan.checks);
        }
        return await this.runCommand(plan.script, {
            args: plan.args,
            stdin: plan.stdin,
            allowFailure: plan.allowFailure,
            signal: plan.signal,
        });
    }
    async runPlannedCommand(plan, signal) {
        return await this.runCheckedCommand({ ...plan, signal });
    }
    ensureWriteAccess(target, action) {
        if (!allowsWrites(this.sandbox.workspaceAccess) || !target.writable) {
            throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
        }
    }
    resolveResolvedPath(params) {
        return resolveSandboxFsPathWithMounts({
            filePath: params.filePath,
            cwd: params.cwd ?? this.sandbox.workspaceDir,
            defaultWorkspaceRoot: this.sandbox.workspaceDir,
            defaultContainerRoot: this.sandbox.containerWorkdir,
            mounts: this.mounts,
        });
    }
}
function allowsWrites(access) {
    return access === "rw";
}
function coerceStatType(typeRaw) {
    if (!typeRaw) {
        return "other";
    }
    const normalized = normalizeOptionalLowercaseString(typeRaw) ?? "";
    if (normalized.includes("directory")) {
        return "directory";
    }
    if (normalized.includes("file")) {
        return "file";
    }
    return "other";
}
