// Openshell plugin module implements fs bridge behavior.
import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { root as fsRoot } from "openclaw/plugin-sdk/file-access-runtime";
import type {
  SandboxFsBridge,
  SandboxFsStat,
  SandboxResolvedPath,
} from "openclaw/plugin-sdk/sandbox";
import { createWritableRenameTargetResolver } from "openclaw/plugin-sdk/sandbox";
import { isPathInside } from "openclaw/plugin-sdk/security-runtime";
import type { OpenShellFsBridgeContext, OpenShellSandboxBackend } from "./backend.types.js";

type ResolvedMountPath = SandboxResolvedPath & {
  mountHostRoot: string;
  writable: boolean;
  source: "workspace" | "agent" | "protectedSkill";
};
type FsRoot = Awaited<ReturnType<typeof fsRoot>>;

const MATERIALIZED_SKILLS_CONTAINER_PARTS = [".openclaw", "sandbox-skills", "skills"] as const;

export function createOpenShellFsBridge(params: {
  sandbox: OpenShellFsBridgeContext;
  backend: OpenShellSandboxBackend;
}): SandboxFsBridge {
  return new OpenShellFsBridge(params.sandbox, params.backend);
}

class OpenShellFsBridge implements SandboxFsBridge {
  private readonly resolveRenameTargets = createWritableRenameTargetResolver(
    (target) => this.resolveTarget(target),
    (target, action) => this.ensureWritable(target, action),
  );

  constructor(
    private readonly sandbox: OpenShellFsBridgeContext,
    private readonly backend: OpenShellSandboxBackend,
  ) {}

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const target = this.resolveTarget(params);
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
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    let opened: Awaited<ReturnType<Awaited<ReturnType<typeof fsRoot>>["open"]>>;
    try {
      await assertLocalPathSafety({
        target,
        root: target.mountHostRoot,
        allowMissingLeaf: false,
        allowFinalSymlinkForUnlink: false,
      });
      const root = await fsRoot(target.mountHostRoot);
      opened = await root.open(path.relative(target.mountHostRoot, hostPath), {
        hardlinks: "reject",
      });
      try {
        return (await opened.handle.readFile()) as Buffer;
      } finally {
        await opened.handle.close();
      }
    } catch (err) {
      throw new Error(
        `Sandbox boundary checks failed; cannot read files: ${target.containerPath}`,
        { cause: err },
      );
    }
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "write files");
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    const buffer = Buffer.isBuffer(params.data)
      ? params.data
      : Buffer.from(params.data, params.encoding ?? "utf8");
    const root = await fsRoot(target.mountHostRoot);
    await root.write(path.relative(target.mountHostRoot, hostPath), buffer, {
      mkdir: params.mkdir,
    });
    await this.backend.syncLocalPathToRemote(hostPath, target.containerPath);
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "create directories");
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    await this.backend.mkdirpRemotePath(target.containerPath, params.signal);
    const root = await fsRoot(target.mountHostRoot);
    await mkdirRootRelative(root, path.relative(target.mountHostRoot, hostPath));
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    this.ensureWritable(target, "remove files");
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: params.force !== false,
      allowFinalSymlinkForUnlink: true,
    });
    await this.backend.removeRemotePath(target.containerPath, {
      recursive: params.recursive ?? false,
      signal: params.signal,
      ignoreMissing: params.force !== false,
    });
    const root = await fsRoot(target.mountHostRoot);
    await removeRootRelative(root, path.relative(target.mountHostRoot, hostPath), {
      recursive: params.recursive ?? false,
      force: params.force !== false,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { from, to } = this.resolveRenameTargets(params);
    const fromHostPath = this.requireHostPath(from);
    const toHostPath = this.requireHostPath(to);
    await assertLocalPathSafety({
      target: from,
      root: from.mountHostRoot,
      allowMissingLeaf: false,
      allowFinalSymlinkForUnlink: true,
    });
    await assertLocalPathSafety({
      target: to,
      root: to.mountHostRoot,
      allowMissingLeaf: true,
      allowFinalSymlinkForUnlink: false,
    });
    const fromRoot = await fsRoot(from.mountHostRoot);
    const toRoot = await fsRoot(to.mountHostRoot);
    const fromRelativePath = path.relative(from.mountHostRoot, fromHostPath);
    const toRelativePath = path.relative(to.mountHostRoot, toHostPath);
    if (
      !normalizeRootRelativePath(fromRelativePath) ||
      !normalizeRootRelativePath(toRelativePath)
    ) {
      throw new Error(
        `OpenShell mirror bridge cannot rename mount roots: ${from.containerPath} -> ${to.containerPath}`,
      );
    }
    if (path.resolve(from.mountHostRoot) === path.resolve(to.mountHostRoot)) {
      const fromStats = await fromRoot.stat(fromRelativePath);
      if (!fromStats.isDirectory && fromStats.nlink > 1) {
        await moveBetweenRoots({
          fromRoot,
          fromRelativePath,
          toRoot: fromRoot,
          toRelativePath,
          runRemoteRename: async () =>
            await this.backend.renameRemotePath(
              from.containerPath,
              to.containerPath,
              params.signal,
            ),
        });
        return;
      }
      await this.backend.renameRemotePath(from.containerPath, to.containerPath, params.signal);
      await mkdirRootRelative(fromRoot, path.dirname(toRelativePath));
      await fromRoot.move(fromRelativePath, toRelativePath, { overwrite: true });
      return;
    }
    await moveBetweenRoots({
      fromRoot,
      fromRelativePath,
      toRoot,
      toRelativePath,
      runRemoteRename: async () =>
        await this.backend.renameRemotePath(from.containerPath, to.containerPath, params.signal),
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveTarget(params);
    const hostPath = this.requireHostPath(target);
    const stats = await fsPromises.lstat(hostPath).catch(() => null);
    if (!stats) {
      return null;
    }
    await assertLocalPathSafety({
      target,
      root: target.mountHostRoot,
      allowMissingLeaf: false,
      allowFinalSymlinkForUnlink: false,
    });
    return {
      type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  private ensureWritable(target: ResolvedMountPath, action: string) {
    if (this.sandbox.workspaceAccess !== "rw" || !target.writable) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${target.containerPath}`);
    }
  }

  private requireHostPath(target: ResolvedMountPath): string {
    if (!target.hostPath) {
      throw new Error(
        `OpenShell mirror bridge requires a local host path: ${target.containerPath}`,
      );
    }
    return target.hostPath;
  }

  private resolveTarget(params: { filePath: string; cwd?: string }): ResolvedMountPath {
    const workspaceRoot = path.resolve(this.sandbox.workspaceDir);
    const agentRoot = path.resolve(this.sandbox.agentWorkspaceDir);
    const hasAgentMount = this.sandbox.workspaceAccess !== "none" && workspaceRoot !== agentRoot;
    const agentContainerRoot = (this.backend.remoteAgentWorkspaceDir || "/agent").replace(
      /\\/g,
      "/",
    );
    const workspaceContainerRoot = this.sandbox.containerWorkdir.replace(/\\/g, "/");
    const skillsRoot = this.sandbox.skillsWorkspaceDir
      ? path.resolve(this.sandbox.skillsWorkspaceDir, "skills")
      : undefined;
    const skillsContainerRoot = path.posix.join(
      workspaceContainerRoot,
      ...MATERIALIZED_SKILLS_CONTAINER_PARTS,
    );
    const workspaceSkillsShadowRoot = path.resolve(
      workspaceRoot,
      ...MATERIALIZED_SKILLS_CONTAINER_PARTS,
    );
    const input = params.filePath.trim();

    if (skillsRoot && this.sandbox.workspaceAccess === "rw") {
      const protectedSkillTarget = resolveProtectedSkillTarget({
        input,
        skillsRoot,
        skillsContainerRoot,
      });
      if (protectedSkillTarget) {
        return protectedSkillTarget;
      }
    }

    if (input.startsWith(`${workspaceContainerRoot}/`) || input === workspaceContainerRoot) {
      const relative = path.posix.relative(workspaceContainerRoot, input) || "";
      const hostPath = relative
        ? path.resolve(workspaceRoot, ...relative.split("/"))
        : workspaceRoot;
      return {
        hostPath,
        relativePath: relative,
        containerPath: relative
          ? path.posix.join(workspaceContainerRoot, relative)
          : workspaceContainerRoot,
        mountHostRoot: workspaceRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "workspace",
      };
    }

    if (
      hasAgentMount &&
      (input.startsWith(`${agentContainerRoot}/`) || input === agentContainerRoot)
    ) {
      const relative = path.posix.relative(agentContainerRoot, input) || "";
      const hostPath = relative ? path.resolve(agentRoot, ...relative.split("/")) : agentRoot;
      return {
        hostPath,
        relativePath: relative ? agentContainerRoot + "/" + relative : agentContainerRoot,
        containerPath: relative
          ? path.posix.join(agentContainerRoot, relative)
          : agentContainerRoot,
        mountHostRoot: agentRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "agent",
      };
    }

    const cwd = params.cwd ? path.resolve(params.cwd) : workspaceRoot;
    const hostPath = path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input);

    if (skillsRoot && this.sandbox.workspaceAccess === "rw") {
      const protectedSkillShadowTarget = resolveProtectedSkillShadowTarget({
        hostPath,
        workspaceSkillsShadowRoot,
        skillsRoot,
        skillsContainerRoot,
      });
      if (protectedSkillShadowTarget) {
        return protectedSkillShadowTarget;
      }
    }

    if (isPathInside(workspaceRoot, hostPath)) {
      const relative = path.relative(workspaceRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        hostPath,
        relativePath: relative,
        containerPath: relative
          ? path.posix.join(workspaceContainerRoot, relative)
          : workspaceContainerRoot,
        mountHostRoot: workspaceRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "workspace",
      };
    }

    if (skillsRoot && this.sandbox.workspaceAccess === "rw" && isPathInside(skillsRoot, hostPath)) {
      const relative = path.relative(skillsRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        hostPath,
        relativePath: relative
          ? path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS, relative)
          : path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS),
        containerPath: relative
          ? path.posix.join(skillsContainerRoot, relative)
          : skillsContainerRoot,
        mountHostRoot: skillsRoot,
        writable: false,
        source: "protectedSkill",
      };
    }

    if (hasAgentMount && isPathInside(agentRoot, hostPath)) {
      const relative = path.relative(agentRoot, hostPath).split(path.sep).join(path.posix.sep);
      return {
        hostPath,
        relativePath: relative ? `${agentContainerRoot}/${relative}` : agentContainerRoot,
        containerPath: relative
          ? path.posix.join(agentContainerRoot, relative)
          : agentContainerRoot,
        mountHostRoot: agentRoot,
        writable: this.sandbox.workspaceAccess === "rw",
        source: "agent",
      };
    }

    throw new Error(`Path escapes sandbox root (${workspaceRoot}): ${params.filePath}`);
  }
}

async function mkdirRootRelative(root: FsRoot, relativePath: string): Promise<void> {
  const normalized = normalizeRootRelativePath(relativePath);
  if (!normalized) {
    await root.ensureRoot();
    return;
  }
  await root.mkdir(normalized);
}

async function removeRootRelative(
  root: FsRoot,
  relativePath: string,
  options: { recursive: boolean; force: boolean },
): Promise<void> {
  const normalized = normalizeRootRelativePath(relativePath);
  const stats = await root.stat(normalized).catch((err: unknown) => {
    if (options.force && getErrorCode(err) === "not-found") {
      return null;
    }
    throw err;
  });
  if (!stats) {
    return;
  }
  if (stats.isDirectory && options.recursive) {
    const entries = await root.list(normalized, { withFileTypes: true });
    for (const entry of entries) {
      await removeRootRelative(root, path.join(normalized, entry.name), options);
    }
  }
  await root.remove(normalized);
}

async function moveBetweenRoots(params: {
  fromRoot: FsRoot;
  fromRelativePath: string;
  toRoot: FsRoot;
  toRelativePath: string;
  runRemoteRename: () => Promise<void>;
}): Promise<void> {
  const stagedToRelativePath = path.join(
    path.dirname(params.toRelativePath),
    `.openclaw-mirror-move-${process.pid}-${randomUUID()}`,
  );
  let stagedPathToRemove: string | undefined;
  try {
    stagedPathToRemove = stagedToRelativePath;
    await copyBetweenRoots(
      params.fromRoot,
      params.fromRelativePath,
      params.toRoot,
      stagedToRelativePath,
    );
    await params.runRemoteRename();
    await removeRootRelative(params.toRoot, params.toRelativePath, {
      recursive: true,
      force: true,
    });
    await mkdirRootRelative(params.toRoot, path.dirname(params.toRelativePath));
    await params.toRoot.move(stagedToRelativePath, params.toRelativePath, { overwrite: true });
    stagedPathToRemove = undefined;
    await removeRootRelative(params.fromRoot, params.fromRelativePath, {
      recursive: true,
      force: false,
    });
  } finally {
    if (stagedPathToRemove) {
      await removeRootRelative(params.toRoot, stagedPathToRemove, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
}

async function copyBetweenRoots(
  fromRoot: FsRoot,
  fromRelativePath: string,
  toRoot: FsRoot,
  toRelativePath: string,
): Promise<void> {
  const normalizedFrom = normalizeRootRelativePath(fromRelativePath);
  const normalizedTo = normalizeRootRelativePath(toRelativePath);
  const stats = await fromRoot.stat(normalizedFrom);
  if (stats.isDirectory) {
    await mkdirRootRelative(toRoot, normalizedTo);
    const entries = await fromRoot.list(normalizedFrom, { withFileTypes: true });
    for (const entry of entries) {
      await copyBetweenRoots(
        fromRoot,
        path.join(normalizedFrom, entry.name),
        toRoot,
        path.join(normalizedTo, entry.name),
      );
    }
    return;
  }

  await copyFileBetweenRoots(fromRoot, normalizedFrom, toRoot, normalizedTo, stats.mode);
}

async function copyFileBetweenRoots(
  fromRoot: FsRoot,
  fromRelativePath: string,
  toRoot: FsRoot,
  toRelativePath: string,
  mode: number,
): Promise<void> {
  await mkdirRootRelative(toRoot, path.dirname(toRelativePath));
  const opened = await fromRoot.open(fromRelativePath, { hardlinks: "allow" });
  let writable: Awaited<ReturnType<FsRoot["openWritable"]>> | undefined;
  let committed = false;
  try {
    writable = await toRoot.openWritable(toRelativePath, { mkdir: true, mode: mode & 0o777 });
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await writable.handle.write(buffer, written, bytesRead - written);
        if (bytesWritten === 0) {
          throw new Error(`OpenShell mirror copy made no write progress: ${toRelativePath}`);
        }
        written += bytesWritten;
      }
    }
    committed = true;
  } finally {
    await opened.handle.close();
    await writable?.handle.close();
    if (!committed) {
      await removeRootRelative(toRoot, toRelativePath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

function normalizeRootRelativePath(relativePath: string): string {
  return relativePath === "." ? "" : relativePath;
}

function getErrorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

function resolveProtectedSkillTarget(params: {
  input: string;
  skillsRoot: string;
  skillsContainerRoot: string;
}): ResolvedMountPath | null {
  const relativeRoot = path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS);
  const normalizedInput = path.posix.normalize(params.input.replace(/\\/g, "/"));
  const isAbsoluteContainer =
    normalizedInput === params.skillsContainerRoot ||
    normalizedInput.startsWith(`${params.skillsContainerRoot}/`);
  const isRelativeContainer =
    normalizedInput === relativeRoot || normalizedInput.startsWith(`${relativeRoot}/`);
  if (!isAbsoluteContainer && !isRelativeContainer) {
    return null;
  }

  const relative = isAbsoluteContainer
    ? path.posix.relative(params.skillsContainerRoot, normalizedInput)
    : path.posix.relative(relativeRoot, normalizedInput);
  const safeRelative = relative === "." ? "" : relative;
  const hostPath = safeRelative
    ? path.resolve(params.skillsRoot, ...safeRelative.split("/"))
    : params.skillsRoot;
  return {
    hostPath,
    relativePath: safeRelative ? path.posix.join(relativeRoot, safeRelative) : relativeRoot,
    containerPath: safeRelative
      ? path.posix.join(params.skillsContainerRoot, safeRelative)
      : params.skillsContainerRoot,
    mountHostRoot: params.skillsRoot,
    writable: false,
    source: "protectedSkill",
  };
}

function resolveProtectedSkillShadowTarget(params: {
  hostPath: string;
  workspaceSkillsShadowRoot: string;
  skillsRoot: string;
  skillsContainerRoot: string;
}): ResolvedMountPath | null {
  if (!isPathInside(params.workspaceSkillsShadowRoot, params.hostPath)) {
    return null;
  }

  const relative = path
    .relative(params.workspaceSkillsShadowRoot, params.hostPath)
    .split(path.sep)
    .join(path.posix.sep);
  const safeRelative = relative === "." ? "" : relative;
  const hostPath = safeRelative
    ? path.resolve(params.skillsRoot, ...safeRelative.split("/"))
    : params.skillsRoot;
  const relativeRoot = path.posix.join(...MATERIALIZED_SKILLS_CONTAINER_PARTS);
  return {
    hostPath,
    relativePath: safeRelative ? path.posix.join(relativeRoot, safeRelative) : relativeRoot,
    containerPath: safeRelative
      ? path.posix.join(params.skillsContainerRoot, safeRelative)
      : params.skillsContainerRoot,
    mountHostRoot: params.skillsRoot,
    writable: false,
    source: "protectedSkill",
  };
}

async function assertLocalPathSafety(params: {
  target: ResolvedMountPath;
  root: string;
  allowMissingLeaf: boolean;
  allowFinalSymlinkForUnlink: boolean;
}): Promise<void> {
  if (!params.target.hostPath) {
    throw new Error(`Missing local host path for ${params.target.containerPath}`);
  }
  const canonicalRoot = await fsPromises
    .realpath(params.root)
    .catch(() => path.resolve(params.root));
  const candidate = await resolveCanonicalCandidate(params.target.hostPath);
  if (!isPathInside(canonicalRoot, candidate)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot access: ${params.target.containerPath}`,
    );
  }

  const relative = path.relative(params.root, params.target.hostPath);
  const segments = relative
    .split(path.sep)
    .filter(Boolean)
    .slice(0, Math.max(0, relative.split(path.sep).filter(Boolean).length));
  let cursor = params.root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const stats = await fsPromises.lstat(cursor).catch(() => null);
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
    const exists = await fsPromises
      .lstat(cursor)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const canonical = await fsPromises.realpath(cursor).catch(() => cursor);
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
