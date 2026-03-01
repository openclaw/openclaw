import fs from "node:fs";
import { openBoundaryFile } from "../../infra/boundary-file-read.js";
import { PATH_ALIAS_POLICIES, type PathAliasPolicy } from "../../infra/path-alias-guards.js";
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
  allowMissingTarget?: boolean;
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
    await this.assertPathSafety(target, { action: "read files" });
    const result = await this.runCommand('set -eu; cat -- "$1"', {
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
    const script =
      params.mkdir === false
        ? 'set -eu; cat >"$1"'
        : 'set -eu; dir=$(dirname -- "$1"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; cat >"$1"';
    await this.runCommand(script, {
      args: [target.containerPath],
      stdin: buffer,
      signal: params.signal,
    });
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "create directories");
    await this.assertPathSafety(target, { action: "create directories", requireWritable: true });
    await this.runCommand('set -eu; mkdir -p -- "$1"', {
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
    await this.assertPathSafety(target, {
      action: "remove files",
      requireWritable: true,
      aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
    });
    const flags = [params.force === false ? "" : "-f", params.recursive ? "-r" : ""].filter(
      Boolean,
    );
    const rmCommand = flags.length > 0 ? `rm ${flags.join(" ")}` : "rm";
    await this.runCommand(`set -eu; ${rmCommand} -- "$1"`, {
      args: [target.containerPath],
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
    await this.assertPathSafety(from, {
      action: "rename files",
      requireWritable: true,
      aliasPolicy: PATH_ALIAS_POLICIES.unlinkTarget,
    });
    await this.assertPathSafety(to, {
      action: "rename files",
      requireWritable: true,
    });
    await this.runCommand(
      'set -eu; dir=$(dirname -- "$2"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; mv -- "$1" "$2"',
      {
        args: [from.containerPath, to.containerPath],
        signal: params.signal,
      },
    );
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveResolvedPath(params);
    await this.assertPathSafety(target, { action: "stat files" });
    const result = await this.runCommand('set -eu; stat -c "%F|%s|%Y" -- "$1"', {
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
    });
    if (!guarded.ok) {
      if (guarded.reason !== "path" || options.allowMissingTarget === false) {
        throw guarded.error instanceof Error
          ? guarded.error
          : new Error(
              `Sandbox boundary checks failed; cannot ${options.action}: ${target.containerPath}`,
            );
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
