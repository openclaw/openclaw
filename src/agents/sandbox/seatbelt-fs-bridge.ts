import fs from "node:fs/promises";
import path from "node:path";
import {
  PATH_ALIAS_POLICIES,
  assertNoPathAliasEscape,
  type PathAliasPolicy,
} from "../../infra/path-alias-guards.js";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.js";
import {
  buildSandboxFsMounts,
  resolveSandboxFsPathWithMounts,
  type SandboxFsMount,
  type SandboxResolvedFsPath,
} from "./fs-paths.js";
import { isPathInsideContainerRoot, normalizeContainerPath } from "./path-utils.js";
import type { SandboxContext, SandboxWorkspaceAccess } from "./types.js";

type PathSafetyOptions = {
  action: string;
  aliasPolicy?: PathAliasPolicy;
  requireWritable?: boolean;
};

export function createSeatbeltFsBridge(params: { sandbox: SandboxContext }): SandboxFsBridge {
  return new SeatbeltFsBridgeImpl(params.sandbox);
}

class SeatbeltFsBridgeImpl implements SandboxFsBridge {
  private readonly sandbox: SandboxContext;
  private readonly mounts: ReturnType<typeof buildSandboxFsMounts>;
  private readonly mountsByContainer: ReturnType<typeof buildSandboxFsMounts>;

  constructor(sandbox: SandboxContext) {
    this.sandbox = sandbox;
    // Seatbelt backend must not trust docker.binds here because bind specs are
    // only validated for docker execution paths.
    this.mounts = buildSandboxFsMounts(sandbox).filter((mount) => mount.source !== "bind");
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
    return fs.readFile(target.hostPath);
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
    if (params.mkdir !== false) {
      await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
    }
    await fs.writeFile(target.hostPath, buffer);
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveResolvedPath(params);
    this.ensureWriteAccess(target, "create directories");
    await this.assertPathSafety(target, { action: "create directories", requireWritable: true });
    await fs.mkdir(target.hostPath, { recursive: true });
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
    await fs.rm(target.hostPath, {
      recursive: params.recursive ?? false,
      force: params.force ?? false,
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
    await fs.mkdir(path.dirname(to.hostPath), { recursive: true });
    await fs.rename(from.hostPath, to.hostPath);
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveResolvedPath(params);
    await this.assertPathSafety(target, { action: "stat files" });
    try {
      const stats = await fs.stat(target.hostPath);
      return {
        type: coerceStatType(stats),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return null;
      }
      throw error;
    }
  }

  private async assertPathSafety(target: SandboxResolvedFsPath, options: PathSafetyOptions) {
    const lexicalMount = this.resolveMountByContainerPath(target.containerPath);
    if (!lexicalMount) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${options.action}: ${target.containerPath}`,
      );
    }

    await assertNoPathAliasEscape({
      absolutePath: target.hostPath,
      rootPath: lexicalMount.hostRoot,
      boundaryLabel: "sandbox mount root",
      policy: options.aliasPolicy,
    });

    if (options.requireWritable && !lexicalMount.writable) {
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

function coerceStatType(
  stats: Awaited<ReturnType<typeof fs.stat>>,
): "file" | "directory" | "other" {
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isFile()) {
    return "file";
  }
  return "other";
}
