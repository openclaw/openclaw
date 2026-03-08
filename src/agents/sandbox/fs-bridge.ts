import { execDockerRaw, type ExecDockerRawResult } from "./docker.js";
import {
  buildMkdirpPlan,
  buildReadFilePlan,
  buildRemovePlan,
  buildRenamePlan,
  buildStatPlan,
  buildWriteCommitPlan,
  type SandboxFsCommandPlan,
} from "./fs-bridge-command-plans.js";
import { SandboxFsPathGuard } from "./fs-bridge-path-safety.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
  type SandboxResolvedFsPath,
} from "./fs-paths.js";
import { normalizeContainerPath } from "./path-utils.js";
import type { SandboxContext, SandboxWorkspaceAccess } from "./types.js";

type RunCommandOptions = {
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

export type SandboxResolvedPath = {
  hostPath: string;
  relativePath: string;
  containerPath: string;
};

export type SandboxFsStat = {
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
};

export type SandboxFsBridge = {
  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath;
  readFile(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<Buffer>;
  writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void>;
  remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  rename(params: { from: string; to: string; cwd?: string; signal?: AbortSignal }): Promise<void>;
  stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null>;
};

export function createSandboxFsBridge(params: { sandbox: SandboxContext }): SandboxFsBridge {
  return new SandboxFsBridgeImpl(params.sandbox);
}

class SandboxFsBridgeImpl implements SandboxFsBridge {
  private readonly sandbox: SandboxContext;
  private readonly mounts: ReturnType<typeof buildSandboxFsMounts>;
  private readonly pathGuard: SandboxFsPathGuard;

  constructor(sandbox: SandboxContext) {
    this.sandbox = sandbox;
    this.mounts = buildSandboxFsMounts(sandbox);
    const mountsByContainer = [...this.mounts].toSorted(
      (a, b) => b.containerRoot.length - a.containerRoot.length,
    );
    this.pathGuard = new SandboxFsPathGuard({
      mountsByContainer,
      runCommand: (script, options) => this.runCommand(script, options),
    });
  }

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveResolvedPath(params);
    return {
      hostPath: target.hostPath,
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const target = this.resolveResolvedPath(params);
    const result = await this.runPlannedCommand(buildReadFilePlan(target), params.signal);
    return result.stdout;
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "write files");
    await this.pathGuard.assertPathSafety(target, { action: "write files", requireWritable: true });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const tempPath = await this.writeFileToTempPath({
      targetContainerPath: target.containerPath,
      mkdir: params.mkdir !== false,
      data: buffer,
      signal: params.signal,
    });

    try {
      await this.runCheckedCommand({
        ...buildWriteCommitPlan(target, tempPath),
        signal: params.signal,
      });
    } catch (error) {
      await this.cleanupTempPath(tempPath, params.signal);
      throw error;
    }
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "create directories");
    const anchoredTarget = await this.pathGuard.resolveAnchoredSandboxEntry(target);
    await this.runPlannedCommand(buildMkdirpPlan(target, anchoredTarget), params.signal);
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "remove files");
    const anchoredTarget = await this.pathGuard.resolveAnchoredSandboxEntry(target);
    await this.runPlannedCommand(
      buildRemovePlan({
        target,
        anchoredTarget,
        recursive: params.recursive,
        force: params.force,
      }),
      params.signal,
    );
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const from = this.resolveResolvedPath({ filePath: params.from, cwd: params.cwd });
    const to = this.resolveResolvedPath({ filePath: params.to, cwd: params.cwd });
    this.ensureWriteAccess(from, "rename files");
    this.ensureWriteAccess(to, "rename files");
    const anchoredFrom = await this.pathGuard.resolveAnchoredSandboxEntry(from);
    const anchoredTo = await this.pathGuard.resolveAnchoredSandboxEntry(to);
    await this.runPlannedCommand(
      buildRenamePlan({
        from,
        to,
        anchoredFrom,
        anchoredTo,
      }),
      params.signal,
    );
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveResolvedPath(params);
    const result = await this.runPlannedCommand(buildStatPlan(target), params.signal);
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

  private async runCommand(
    script: string,
    options: RunCommandOptions = {},
  ): Promise<ExecDockerRawResult> {
    const dockerArgs = [
      "exec",
      "-i",
      this.sandbox.containerName,
      "sh",
      "-c",
      script,
      "moltbot-sandbox-fs",
    ];
    if (options.args?.length) {
      dockerArgs.push(...options.args);
    }
    return execDockerRaw(dockerArgs, {
      input: options.stdin,
      allowFailure: options.allowFailure,
      signal: options.signal,
    });
  }

  private async runCheckedCommand(
    plan: SandboxFsCommandPlan & { stdin?: Buffer | string; signal?: AbortSignal },
  ): Promise<ExecDockerRawResult> {
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

  private async runPlannedCommand(
    plan: SandboxFsCommandPlan,
    signal?: AbortSignal,
  ): Promise<ExecDockerRawResult> {
    return await this.runCheckedCommand({ ...plan, signal });
  }

  private async writeFileToTempPath(params: {
    targetContainerPath: string;
    mkdir: boolean;
    data: Buffer;
    signal?: AbortSignal;
  }): Promise<string> {
    const script = params.mkdir
      ? [
          "set -eu",
          'target="$1"',
          'dir=$(dirname -- "$target")',
          'if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi',
          'base=$(basename -- "$target")',
          'tmp=$(mktemp "$dir/.openclaw-write-$base.XXXXXX")',
          'cat >"$tmp"',
          'printf "%s\\n" "$tmp"',
        ].join("\n")
      : [
          "set -eu",
          'target="$1"',
          'dir=$(dirname -- "$target")',
          'base=$(basename -- "$target")',
          'tmp=$(mktemp "$dir/.openclaw-write-$base.XXXXXX")',
          'cat >"$tmp"',
          'printf "%s\\n" "$tmp"',
        ].join("\n");
    const result = await this.runCommand(script, {
      args: [params.targetContainerPath],
      stdin: params.data,
      signal: params.signal,
    });
    const tempPath = result.stdout.toString("utf8").trim().split(/\r?\n/).at(-1)?.trim();
    if (!tempPath || !tempPath.startsWith("/")) {
      throw new Error(
        `Failed to create temporary sandbox write path for ${params.targetContainerPath}`,
      );
    }
    return normalizeContainerPath(tempPath);
  }

  private async cleanupTempPath(tempPath: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.runCommand('set -eu; rm -f -- "$1"', {
        args: [tempPath],
        signal,
        allowFailure: true,
      });
    } catch {
      // Best-effort cleanup only.
    }
  }

  private ensureWriteAccess(target: SandboxResolvedFsPath, action: string) {
    if (!allowsWrites(this.sandbox.workspaceAccess) || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  private resolveResolvedPath(params: { filePath: string; cwd?: string }): SandboxResolvedFsPath {
    return resolveSandboxFsPathWithMounts({
      filePath: params.filePath,
      cwd: params.cwd ?? this.sandbox.workspaceDir,
      defaultWorkspaceRoot: this.sandbox.workspaceDir,
      defaultContainerRoot: this.sandbox.containerWorkdir,
      mounts: this.mounts,
    });
  }
}

function allowsWrites(access: SandboxWorkspaceAccess): boolean {
  return access === "rw";
}

function coerceStatType(typeRaw?: string): "file" | "directory" | "other" {
  if (!typeRaw) {
    return "other";
  }
  const normalized = typeRaw.trim().toLowerCase();
  if (normalized.includes("directory")) {
    return "directory";
  }
  if (normalized.includes("file")) {
    return "file";
  }
  return "other";
}
