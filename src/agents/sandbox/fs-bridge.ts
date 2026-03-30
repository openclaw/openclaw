import fs from "node:fs";
import { formatCliCommand } from "../../cli/command-format.js";
import type { SandboxBackendCommandResult } from "./backend.js";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";
import { runDockerSandboxShellCommand } from "./docker-backend.js";
import {
  buildPinnedMkdirpPlan,
  buildPinnedRemovePlan,
  buildPinnedRenamePlan,
  buildPinnedWritePlan,
  SANDBOX_PINNED_MUTATION_OPERATION_MARKER,
} from "./fs-bridge-mutation-helper.js";
import { SandboxFsPathGuard } from "./fs-bridge-path-safety.js";
import { buildStatPlan, type SandboxFsCommandPlan } from "./fs-bridge-shell-command-plans.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
  type SandboxResolvedFsPath,
} from "./fs-paths.js";
import type { SandboxContext, SandboxWorkspaceAccess } from "./types.js";

type RunCommandOptions = {
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

type SandboxCommandFailure = Error & {
  code?: number;
  stdout?: Buffer;
  stderr?: Buffer;
};

export type SandboxResolvedPath = {
  hostPath?: string;
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

function isDockerSandbox(sandbox: SandboxContext): boolean {
  return !sandbox.backend || sandbox.backend.id === "docker";
}

function formatIncompatibleSandboxImageMessage(params: {
  containerName: string;
  image: string;
}): string {
  const message = [
    `Sandbox image is incompatible with OpenClaw file tools: no Python runtime was found inside container ${params.containerName}.`,
    `Rebuild the configured sandbox image (${params.image}) so it includes python3 or python, then run ${formatCliCommand("openclaw sandbox recreate --all")}.`,
  ];
  if (params.image === DEFAULT_SANDBOX_IMAGE) {
    message.push(
      `For the default image, rebuild it with ${formatCliCommand("scripts/sandbox-setup.sh")} from a source checkout.`,
    );
  }
  return message.join(" ");
}

function isMissingSandboxPythonError(error: unknown): error is SandboxCommandFailure {
  if (!(error instanceof Error)) {
    return false;
  }
  const stderr =
    typeof (error as SandboxCommandFailure).stderr?.toString === "function"
      ? ((error as SandboxCommandFailure).stderr?.toString("utf8") ?? "")
      : "";
  const message = `${error.message}\n${stderr}`.toLowerCase();
  return (
    /\b(?:python3|python)\b.*\b(?:command )?not found\b/.test(message) ||
    message.includes("sandbox pinned mutation helper requires python3 or python")
  );
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
    return this.readPinnedFile(target);
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
    const writeCheck = {
      target,
      options: { action: "write files", requireWritable: true } as const,
    };
    await this.pathGuard.assertPathSafety(target, writeCheck.options);
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const pinnedWriteTarget = await this.pathGuard.resolveAnchoredPinnedEntry(
      target,
      "write files",
    );
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

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "create directories");
    const mkdirCheck = {
      target,
      options: {
        action: "create directories",
        requireWritable: true,
        allowedType: "directory",
      } as const,
    };
    await this.runCheckedCommand({
      ...buildPinnedMkdirpPlan({
        check: mkdirCheck,
        pinned: this.pathGuard.resolvePinnedDirectoryEntry(target, "create directories"),
      }),
      signal: params.signal,
    });
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
    const removeCheck = {
      target,
      options: {
        action: "remove files",
        requireWritable: true,
      } as const,
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
    const fromCheck = {
      target: from,
      options: {
        action: "rename files",
        requireWritable: true,
      } as const,
    };
    const toCheck = {
      target: to,
      options: {
        action: "rename files",
        requireWritable: true,
      } as const,
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

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveResolvedPath(params);
    const anchoredTarget = await this.pathGuard.resolveAnchoredSandboxEntry(target, "stat files");
    const result = await this.runPlannedCommand(
      buildStatPlan(target, anchoredTarget),
      params.signal,
    );
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
  ): Promise<SandboxBackendCommandResult> {
    try {
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
    } catch (error) {
      if (
        !options.allowFailure &&
        isDockerSandbox(this.sandbox) &&
        script.includes(SANDBOX_PINNED_MUTATION_OPERATION_MARKER) &&
        isMissingSandboxPythonError(error)
      ) {
        throw Object.assign(
          new Error(
            formatIncompatibleSandboxImageMessage({
              containerName: this.sandbox.containerName,
              image: this.sandbox.docker.image,
            }),
          ),
          {
            code: "INVALID_CONFIG",
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  private async readPinnedFile(target: SandboxResolvedFsPath): Promise<Buffer> {
    const opened = await this.pathGuard.openReadableFile(target);
    try {
      return fs.readFileSync(opened.fd);
    } finally {
      fs.closeSync(opened.fd);
    }
  }

  private async runCheckedCommand(
    plan: SandboxFsCommandPlan & { stdin?: Buffer | string; signal?: AbortSignal },
  ): Promise<SandboxBackendCommandResult> {
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
  ): Promise<SandboxBackendCommandResult> {
    return await this.runCheckedCommand({ ...plan, signal });
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
