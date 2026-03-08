import fs from "node:fs";
import path from "node:path";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";
import { PATH_ALIAS_POLICIES, type PathAliasPolicy } from "../../infra/path-alias-guards.js";
import type { SafeOpenSyncAllowedType } from "../../infra/safe-open-sync.js";
import { execDockerRaw, type ExecDockerRawResult } from "./docker.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
  type SandboxResolvedFsPath,
  type SandboxFsMount,
} from "./fs-paths.js";
import { isPathInsideContainerRoot, normalizeContainerPath } from "./path-utils.js";
import type { SandboxContext, SandboxWorkspaceAccess } from "./types.js";

type RunCommandOptions = {
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
};

type PathSafetyOptions = {
  action: string;
  aliasPolicy?: PathAliasPolicy;
  requireWritable?: boolean;
  allowedType?: SafeOpenSyncAllowedType;
};

type PathSafetyCheck = {
  target: SandboxResolvedFsPath;
  options: PathSafetyOptions;
};

type AnchoredSandboxEntry = {
  canonicalParentPath: string;
  basename: string;
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
  private readonly mountsByContainer: ReturnType<typeof buildSandboxFsMounts>;

  constructor(sandbox: SandboxContext) {
    this.sandbox = sandbox;
    this.mounts = buildSandboxFsMounts(sandbox);
    this.mountsByContainer = [...this.mounts].toSorted(
      (a, b) => b.containerRoot.length - a.containerRoot.length,
    );
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
    const result = await this.runCheckedCommand({
      checks: [{ target, options: { action: "read files" } }],
      script: 'set -eu; cat -- "$1"',
      args: [target.containerPath],
      signal: params.signal,
    });
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
    await this.assertPathSafety(target, { action: "write files", requireWritable: true });
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
        checks: [{ target, options: { action: "write files", requireWritable: true } }],
        recheckBeforeCommand: true,
        script: 'set -eu; mv -f -- "$1" "$2"',
        args: [tempPath, target.containerPath],
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
    await this.runCheckedCommand({
      checks: [
        {
          target,
          options: {
            action: "create directories",
            requireWritable: true,
            allowedType: "directory",
          },
        },
      ],
      script: 'set -eu; mkdir -p -- "$1"',
      args: [target.containerPath],
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
    const anchoredTarget = await this.resolveAnchoredSandboxEntry(target);
    const flags = [params.force === false ? "" : "-f", params.recursive ? "-r" : ""].filter(
      Boolean,
    );
    const rmCommand = flags.length > 0 ? `rm ${flags.join(" ")}` : "rm";
    await this.runCheckedCommand({
      checks: [
        {
          target,
          options: {
            action: "remove files",
            requireWritable: true,
            aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
          },
        },
      ],
      recheckBeforeCommand: true,
      script: `set -eu\ncd -- "$1"\n${rmCommand} -- "$2"`,
      args: [anchoredTarget.canonicalParentPath, anchoredTarget.basename],
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
    const anchoredFrom = await this.resolveAnchoredSandboxEntry(from);
    const anchoredTo = await this.resolveAnchoredSandboxEntry(to);
    await this.runCheckedCommand({
      checks: [
        {
          target: from,
          options: {
            action: "rename files",
            requireWritable: true,
            aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
          },
        },
        {
          target: to,
          options: {
            action: "rename files",
            requireWritable: true,
          },
        },
      ],
      recheckBeforeCommand: true,
      script: ["set -eu", 'mkdir -p -- "$2"', 'cd -- "$1"', 'mv -- "$3" "$2/$4"'].join("\n"),
      args: [
        anchoredFrom.canonicalParentPath,
        anchoredTo.canonicalParentPath,
        anchoredFrom.basename,
        anchoredTo.basename,
      ],
      signal: params.signal,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveResolvedPath(params);
    const result = await this.runCheckedCommand({
      checks: [{ target, options: { action: "stat files" } }],
      script: 'set -eu; stat -c "%F|%s|%Y" -- "$1"',
      args: [target.containerPath],
      signal: params.signal,
      allowFailure: true,
    });
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

  private async runCheckedCommand(params: {
    checks: PathSafetyCheck[];
    script: string;
    args?: string[];
    stdin?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
    recheckBeforeCommand?: boolean;
  }): Promise<ExecDockerRawResult> {
    await this.assertPathChecks(params.checks);
    if (params.recheckBeforeCommand) {
      await this.assertPathChecks(params.checks);
    }
    return await this.runCommand(params.script, {
      args: params.args,
      stdin: params.stdin,
      allowFailure: params.allowFailure,
      signal: params.signal,
    });
  }

  private async assertPathChecks(checks: PathSafetyCheck[]): Promise<void> {
    for (const check of checks) {
      await this.assertPathSafety(check.target, check.options);
    }
  }

  private async assertPathSafety(target: SandboxResolvedFsPath, options: PathSafetyOptions) {
    const lexicalMount = this.resolveMountByContainerPath(target.containerPath);
    if (!lexicalMount) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${options.action}: ${target.containerPath}`,
      );
    }

    const guarded = await openBoundaryFile({
      absolutePath: target.hostPath,
      rootPath: lexicalMount.hostRoot,
      boundaryLabel: "sandbox mount root",
      aliasPolicy: options.aliasPolicy,
      allowedType: options.allowedType,
    });
    if (!guarded.ok) {
      if (guarded.reason !== "path") {
        // Some platforms cannot open directories via openSync(O_RDONLY), even when
        // the path is a valid in-boundary directory. Allow mkdirp to proceed in that
        // narrow case by verifying the host path is an existing directory.
        const canFallbackToDirectoryStat =
          options.allowedType === "directory" && this.pathIsExistingDirectory(target.hostPath);
        if (!canFallbackToDirectoryStat) {
          throw guarded.error instanceof Error
            ? guarded.error
            : new Error(
                `Sandbox boundary checks failed; cannot ${options.action}: ${target.containerPath}`,
              );
        }
      }
    } else {
      fs.closeSync(guarded.fd);
    }

    const canonicalContainerPath = await this.resolveCanonicalContainerPath({
      containerPath: target.containerPath,
      allowFinalSymlinkForUnlink: options.aliasPolicy?.allowFinalSymlinkForUnlink === true,
    });
    const canonicalMount = this.resolveMountByContainerPath(canonicalContainerPath);
    if (!canonicalMount) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${options.action}: ${target.containerPath}`,
      );
    }
    if (options.requireWritable && !canonicalMount.writable) {
      throw new Error(
        `Sandbox path is read-only; cannot ${options.action}: ${target.containerPath}`,
      );
    }
  }

  private pathIsExistingDirectory(hostPath: string): boolean {
    try {
      return fs.statSync(hostPath).isDirectory();
    } catch {
      return false;
    }
  }

  private resolveMountByContainerPath(containerPath: string): SandboxFsMount | null {
    const normalized = normalizeContainerPath(containerPath);
    for (const mount of this.mountsByContainer) {
      if (isPathInsideContainerRoot(normalizeContainerPath(mount.containerRoot), normalized)) {
        return mount;
      }
    }
    return null;
  }

  private async resolveCanonicalContainerPath(params: {
    containerPath: string;
    allowFinalSymlinkForUnlink: boolean;
  }): Promise<string> {
    const script = [
      "set -eu",
      'target="$1"',
      'allow_final="$2"',
      'suffix=""',
      'probe="$target"',
      'if [ "$allow_final" = "1" ] && [ -L "$target" ]; then probe=$(dirname -- "$target"); fi',
      'cursor="$probe"',
      'while [ ! -e "$cursor" ] && [ ! -L "$cursor" ]; do',
      '  parent=$(dirname -- "$cursor")',
      '  if [ "$parent" = "$cursor" ]; then break; fi',
      '  base=$(basename -- "$cursor")',
      '  suffix="/$base$suffix"',
      '  cursor="$parent"',
      "done",
      'canonical=$(readlink -f -- "$cursor")',
      'printf "%s%s\\n" "$canonical" "$suffix"',
    ].join("\n");
    const result = await this.runCommand(script, {
      args: [params.containerPath, params.allowFinalSymlinkForUnlink ? "1" : "0"],
    });
    const canonical = result.stdout.toString("utf8").trim();
    if (!canonical.startsWith("/")) {
      throw new Error(`Failed to resolve canonical sandbox path: ${params.containerPath}`);
    }
    return normalizeContainerPath(canonical);
  }

  private async resolveAnchoredSandboxEntry(
    target: SandboxResolvedFsPath,
  ): Promise<AnchoredSandboxEntry> {
    const basename = path.posix.basename(target.containerPath);
    if (!basename || basename === "." || basename === "/") {
      throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
    }
    const parentPath = normalizeContainerPath(path.posix.dirname(target.containerPath));
    const canonicalParentPath = await this.resolveCanonicalContainerPath({
      containerPath: parentPath,
      allowFinalSymlinkForUnlink: false,
    });
    return {
      canonicalParentPath,
      basename,
    };
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
