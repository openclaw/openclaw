import path from "node:path";
import {
  isPathInside,
  removePathWithinRoot,
  root as fsRoot,
} from "openclaw/plugin-sdk/file-access-runtime";
import {
  createWritableRenameTargetResolver,
  type DirectoryEntry,
  type SandboxBackendHandle,
  type SandboxFsBridge,
  type SandboxFsStat,
  type SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import { normalizeMxcPathForComparison } from "./path-comparison.js";
import { resolveMxcReadOnlySkillMounts } from "./workspace-skill-mounts.js";

type MxcFsBridgeContext = Parameters<
  NonNullable<SandboxBackendHandle["createFsBridge"]>
>[0]["sandbox"];

type MxcFsMount = {
  hostRoot: string;
  containerRoot: string;
  writable: boolean;
};

type ResolvedMxcPath = SandboxResolvedPath & {
  hostPath: string;
  mount: MxcFsMount;
};

export function createMxcFsBridge(params: {
  sandbox: MxcFsBridgeContext;
  assertCurrent?: () => void;
}): SandboxFsBridge {
  params.assertCurrent?.();
  return new MxcFsBridge(params.sandbox, params.assertCurrent);
}

class MxcFsBridge implements SandboxFsBridge {
  // These must be assigned in the constructor body, not as field initializers.
  // Plugin sources load through jiti, which evaluates field initializers before
  // it assigns constructor parameter properties, so `this.sandbox` would still
  // be undefined here and provisioning would crash reading containerWorkdir.
  private readonly defaultContainerRoot: string;

  private readonly protectedSkillMounts: readonly MxcFsMount[];

  private readonly workspaceMounts: readonly MxcFsMount[];

  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(
    private readonly sandbox: MxcFsBridgeContext,
    private readonly assertCurrent?: () => void,
  ) {
    this.defaultContainerRoot = path.resolve(sandbox.containerWorkdir);
    this.protectedSkillMounts = resolveMxcProtectedSkillMounts(sandbox);
    this.workspaceMounts = resolveWorkspaceMounts(sandbox);
  }

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
    return {
      hostPath: target.hostPath,
      relativePath: target.relativePath,
      containerPath: target.containerPath,
    };
  }

  get pathMappings(): NonNullable<SandboxFsBridge["pathMappings"]> {
    return [...this.protectedSkillMounts, ...this.workspaceMounts];
  }

  async readFile(params: { filePath: string; cwd?: string; maxBytes?: number }): Promise<Buffer> {
    const target = this.resolveTarget(params);
    return (await (
      await this.openRoot(target)
    ).readBytes(target.relativePath, {
      hardlinks: "reject",
      ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
    })) as Buffer;
  }

  async readDirectory(
    params: Parameters<NonNullable<SandboxFsBridge["readDirectory"]>>[0],
  ): Promise<DirectoryEntry[]> {
    const target = this.resolveTarget(params);
    const root = await this.openRoot(target);
    const entries = await root.list(target.relativePath, { withFileTypes: true });
    return entries.map(({ name, isDirectory }) => ({ name, isDirectory }));
  }

  async writeFile(params: Parameters<SandboxFsBridge["writeFile"]>[0]): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "write files");
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    await (
      await this.openRoot(target)
    ).write(target.relativePath, buffer, {
      mkdir: params.mkdir !== false,
    });
  }

  async createFileExclusive(
    params: Parameters<NonNullable<SandboxFsBridge["createFileExclusive"]>>[0],
  ): Promise<"created" | "exists"> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "create files");
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    try {
      await (
        await this.openRoot(target)
      ).create(target.relativePath, buffer, {
        mkdir: params.mkdir !== false,
      });
      return "created";
    } catch (error) {
      if (error instanceof FsSafeError && error.code === "already-exists") {
        return "exists";
      }
      throw error;
    }
  }

  async mkdirp(params: { filePath: string; cwd?: string }): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "create directories");
    if (target.relativePath.length === 0) {
      return;
    }
    await (await this.openRoot(target)).mkdir(target.relativePath);
  }

  async remove(params: Parameters<SandboxFsBridge["remove"]>[0]): Promise<void> {
    const target = this.resolveTarget(params);
    this.ensureWritable(target, "remove files");
    await removePathWithinRoot({
      rootDir: target.mount.hostRoot,
      relativePath: target.relativePath,
      recursive: params.recursive,
      force: params.force ?? false,
      assertBeforeMutation: this.assertCurrent,
    });
  }

  async rename(params: { from: string; to: string; cwd?: string }): Promise<void> {
    const { from: source, to: target } = this.resolveRenameTargets(params);
    if (
      normalizeMxcPathForComparison(source.mount.hostRoot) !==
      normalizeMxcPathForComparison(target.mount.hostRoot)
    ) {
      throw new Error(
        `Sandbox rename must stay within the same mounted root: ${source.containerPath} -> ${target.containerPath}`,
      );
    }

    const root = await this.openRoot(source);
    const targetParent = path.dirname(target.relativePath);
    if (targetParent !== "." && targetParent !== "") {
      await root.mkdir(targetParent);
    }
    await root.move(source.relativePath, target.relativePath, { overwrite: true });
  }

  async stat(params: { filePath: string; cwd?: string }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const root = await this.openRoot(target);
    if (!(await root.exists(target.relativePath))) {
      return null;
    }

    this.assertCurrent?.();
    const stats = await root.stat(target.relativePath);
    return {
      type: stats.isDirectory ? "directory" : stats.isFile ? "file" : "other",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  private async openRoot(target: ResolvedMxcPath) {
    const root = await fsRoot(target.mount.hostRoot, {
      assertBeforeMutation: this.assertCurrent,
    });
    this.assertCurrent?.();
    return root;
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedMxcPath {
    this.assertCurrent?.();
    const input = params.filePath.trim();
    const cwd = params.cwd?.trim() ? path.resolve(params.cwd) : this.defaultContainerRoot;
    const containerPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);

    for (const mount of [...this.protectedSkillMounts, ...this.workspaceMounts]) {
      if (!isPathInside(mount.containerRoot, containerPath)) {
        continue;
      }

      const mountRelativePath = path.relative(mount.containerRoot, containerPath);
      return {
        hostPath: path.join(mount.hostRoot, mountRelativePath),
        relativePath: mountRelativePath,
        containerPath,
        mount,
      };
    }
    const allowedRoots = [
      ...new Set(this.workspaceMounts.map((mount) => mount.containerRoot)),
    ].join(", ");
    throw new Error(
      `Path escapes sandbox root (${allowedRoots}; container root ${this.sandbox.containerWorkdir}): ${params.filePath}. Use a path under ${this.sandbox.containerWorkdir}\\ instead.`,
    );
  }

  private ensureWritable(target: ResolvedMxcPath, action: string): void {
    if (!target.mount.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }
}

function resolveWorkspaceMounts(sandbox: MxcFsBridgeContext): readonly MxcFsMount[] {
  const containerRoot = path.resolve(sandbox.containerWorkdir);
  const workspaceDir = path.resolve(sandbox.workspaceDir);
  const agentWorkspaceDir = path.resolve(sandbox.agentWorkspaceDir);
  const writable = sandbox.workspaceAccess === "rw";
  const mounts: MxcFsMount[] = [
    { hostRoot: writable ? agentWorkspaceDir : workspaceDir, containerRoot, writable },
  ];

  if (
    sandbox.workspaceAccess === "ro" &&
    normalizeMxcPathForComparison(agentWorkspaceDir) !== normalizeMxcPathForComparison(workspaceDir)
  ) {
    mounts.push({
      hostRoot: agentWorkspaceDir,
      containerRoot: agentWorkspaceDir,
      writable: false,
    });
  }

  return dedupeAndSortMounts(mounts);
}

function resolveMxcProtectedSkillMounts(sandbox: MxcFsBridgeContext): readonly MxcFsMount[] {
  return dedupeAndSortMounts(
    resolveMxcReadOnlySkillMounts({
      agentWorkspaceDir: sandbox.agentWorkspaceDir,
      skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
      workdir: sandbox.containerWorkdir,
      workspaceAccess: sandbox.workspaceAccess,
    }).map((mount) => ({
      hostRoot: path.resolve(mount.hostPath),
      containerRoot: path.resolve(mount.containerPath),
      writable: false,
    })),
  );
}

function dedupeAndSortMounts(mounts: readonly MxcFsMount[]): readonly MxcFsMount[] {
  const deduped = new Map<string, MxcFsMount>();
  for (const mount of mounts) {
    const key = `${normalizeMxcPathForComparison(
      mount.hostRoot,
    )}::${normalizeMxcPathForComparison(mount.containerRoot)}`;
    if (!deduped.has(key)) {
      deduped.set(key, mount);
    }
  }
  return [...deduped.values()].toSorted(
    (left, right) =>
      right.containerRoot.length - left.containerRoot.length ||
      right.hostRoot.length - left.hostRoot.length,
  );
}
