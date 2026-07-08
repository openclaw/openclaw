import fs from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import {
  createWritableRenameTargetResolver,
  type SandboxBackendHandle,
  type SandboxFsBridge,
  type SandboxFsStat,
  type SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import {
  resolveMxcReadOnlySkillMounts,
  type MxcReadOnlySkillMount,
} from "./workspace-skill-mounts.js";

type MxcFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

type ResolvedMxcPath = SandboxResolvedPath & {
  hostPath: string;
  mountRoot: string;
  writable: boolean;
};

type MxcProtectedSkillMount = {
  hostRoot: string;
  containerRoot: string;
};

export function createMxcFsBridge(params: { sandbox: MxcFsBridgeContext }): SandboxFsBridge {
  return new MxcFsBridge(params.sandbox);
}

class MxcFsBridge implements SandboxFsBridge {
  private readonly protectedSkillMounts: readonly MxcProtectedSkillMount[];

  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(private readonly sandbox: MxcFsBridgeContext) {
    this.protectedSkillMounts = resolveMxcProtectedSkillMounts(sandbox);
  }

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      hostPath: target.hostPath,
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  async readFile(params: { filePath: string; cwd?: string }): Promise<Buffer> {
    const target = this.resolveTarget(params);
    await assertLocalPathSafety({
      target,
      root: target.mountRoot,
      allowMissingLeaf: false,
      allowFinalSymlinkForUnlink: false,
    });
    const root = await fsRoot(target.mountRoot);
    const opened = await root.open(path.relative(target.mountRoot, target.hostPath), {
      hardlinks: "reject",
    });
    try {
      return (await opened.handle.readFile()) as Buffer;
    } finally {
      await opened.handle.close();
    }
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "write files");
    await assertLocalPathSafety({
      target,
      root: target.mountRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const root = await fsRoot(target.mountRoot);
    await root.write(path.relative(target.mountRoot, target.hostPath), buffer, {
      mkdir: params.mkdir !== false,
    });
  }

  async mkdirp(params: { filePath: string; cwd?: string }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "create directories");
    await assertLocalPathSafety({
      target,
      root: target.mountRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    await fs.mkdir(target.hostPath, { recursive: true });
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "remove files");
    await assertLocalPathSafety({
      target,
      root: target.mountRoot,
      allowMissingLeaf: params.force === true,
      allowFinalSymlinkForUnlink: true,
    });
    await fs.rm(target.hostPath, {
      recursive: params.recursive ?? false,
      force: params.force ?? false,
    });
  }

  async rename(params: { from: string; to: string; cwd?: string }): Promise<void> {
    const { from: source, to: target } = this.resolveRenameTargets(params);
    await assertLocalPathSafety({
      target: source,
      root: source.mountRoot,
      allowMissingLeaf: false,
      allowFinalSymlinkForUnlink: true,
    });
    await assertLocalPathSafety({
      target,
      root: target.mountRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    await fs.mkdir(path.dirname(target.hostPath), { recursive: true });
    await fs.rename(source.hostPath, target.hostPath);
  }

  async stat(params: { filePath: string; cwd?: string }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    await assertLocalPathSafety({
      target,
      root: target.mountRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    const stats = await fs.stat(target.hostPath).catch(() => null);
    if (!stats) {
      return null;
    }
    return {
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedMxcPath {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const input = params.filePath.trim();
    const cwd = params.cwd?.trim() ? path.resolve(params.cwd) : workspaceRoot;
    const hostPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);
    const protectedTarget = this.resolveProtectedSkillTarget(hostPath);
    if (protectedTarget) {
      return protectedTarget;
    }
    if (!isPathInside(workspaceRoot, hostPath)) {
      throw new Error(
        `Path escapes sandbox root (${workspaceRoot}; container root ${this.sandbox.containerWorkdir}): ${params.filePath}. Use a path under ${this.sandbox.containerWorkdir}\\ instead.`,
      );
    }
    const relativePath = path.relative(workspaceRoot, hostPath);
    return {
      hostPath,
      relativePath,
      containerPath: hostPath,
      mountRoot: workspaceRoot,
      writable: this.sandbox.workspaceAccess === "rw",
    };
  }

  private resolveProtectedSkillTarget(candidatePath: string): ResolvedMxcPath | null {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const mounts = [...this.protectedSkillMounts].toSorted(
      (a, b) => b.containerRoot.length - a.containerRoot.length,
    );
    for (const mount of mounts) {
      if (!isPathInside(mount.containerRoot, candidatePath)) {
        continue;
      }
      const relativePath = path.relative(mount.containerRoot, candidatePath);
      const hostPath = path.join(mount.hostRoot, relativePath);
      return {
        hostPath,
        relativePath: path.relative(workspaceRoot, candidatePath),
        containerPath: candidatePath,
        mountRoot: mount.hostRoot,
        writable: false,
      };
    }
    return null;
  }

  private ensureWritable(target: ResolvedMxcPath, action: string): void {
    if (!target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }
}

function resolveMxcProtectedSkillMounts(
  sandbox: MxcFsBridgeContext,
): readonly MxcProtectedSkillMount[] {
  return resolveMxcReadOnlySkillMounts({
    agentWorkspaceDir: sandbox.agentWorkspaceDir,
    skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
    workdir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
  }).map(normalizeMxcProtectedSkillMount);
}

function normalizeMxcProtectedSkillMount(mount: MxcReadOnlySkillMount): MxcProtectedSkillMount {
  return {
    hostRoot: path.resolve(mount.hostPath),
    containerRoot: path.resolve(mount.containerPath),
  };
}

async function assertLocalPathSafety(params: {
  target: ResolvedMxcPath;
  root: string;
  allowMissingLeaf: boolean;
  allowFinalSymlinkForUnlink: boolean;
}): Promise<void> {
  const canonicalRoot = await fs.realpath(params.root).catch(() => path.resolve(params.root));
  const candidate = await resolveCanonicalCandidate(params.target.hostPath);
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`,
    );
  }

  const segments = path
    .relative(params.root, params.target.hostPath)
    .split(path.sep)
    .filter(Boolean);
  let cursor = params.root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const stats = await fs.lstat(cursor).catch(() => null);
    if (!stats) {
      if (index === segments.length - 1 && params.allowMissingLeaf) {
        return;
      }
      continue;
    }
    const isFinal = index === segments.length - 1;
    if (stats.isSymbolicLink() && (!isFinal || !params.allowFinalSymlinkForUnlink)) {
      throw new Error(`Sandbox boundary checks failed: ${params.target.containerPath}`);
    }
  }
}

async function resolveCanonicalCandidate(targetPath: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    const exists = await fs
      .lstat(cursor)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const canonical = await fs.realpath(cursor).catch(() => cursor);
      return path.resolve(canonical, ...missing);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return path.resolve(cursor, ...missing);
    }
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
}
