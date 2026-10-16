import os from "node:os";
import path from "node:path";
import { shortenPathWithHome } from "../../infra/home-display.js";
import { isPathInside } from "../../infra/path-guards.js";
import { normalizeSandboxInputPath, resolveSandboxInputPath } from "../sandbox-paths.js";
import type { SandboxFsBridgeContext } from "./backend-handle.types.js";
import {
  isSandboxHostPathAbsolute,
  resolveSandboxHostPathViaExistingAncestor,
} from "./host-paths.js";
import {
  isPathInsideContainerRoot,
  normalizeContainerPathCore,
  relativePathEscapesContainerRoot,
} from "./path-utils.js";
import { resolveSandboxMountSelection, resolveSandboxBindMounts } from "./workspace-mounts.js";

export type SandboxFsMount = {
  hostRoot: string;
  containerRoot: string;
  writable: boolean;
  source: "workspace" | "agent" | "bind" | "protectedSkill";
};

export type SandboxResolvedFsPath = {
  hostPath: string;
  relativePath: string;
  containerPath: string;
  writable: boolean;
};

export function buildSandboxFsMounts(sandbox: SandboxFsBridgeContext): SandboxFsMount[] {
  return resolveSandboxMountSelection({
    workspaceDir: sandbox.workspaceDir,
    agentWorkspaceDir: sandbox.agentWorkspaceDir,
    skillsWorkspaceDir: sandbox.skillsWorkspaceDir,
    workdir: sandbox.containerWorkdir,
    workspaceAccess: sandbox.workspaceAccess,
    binds: sandbox.docker.binds,
    readOnlyResourceMounts: sandbox.readOnlyResourceMounts,
  }).mounts.map((mount) => ({
    hostRoot: path.resolve(mount.hostPath),
    containerRoot: mount.containerPath,
    writable: !mount.readOnly,
    source: mount.source,
  }));
}

export function resolveWritableSandboxBindHostRoots(
  binds: readonly string[] | undefined,
): string[] {
  const parsedBinds = parseSandboxBindMounts(binds);
  const readonlyRoots = parsedBinds.filter((bind) => !bind.writable).map((bind) => bind.hostRoot);
  return [
    ...new Set(
      parsedBinds
        .filter(
          (bind) =>
            bind.writable && !readonlyRoots.some((root) => isPathInside(bind.hostRoot, root)),
        )
        .map((bind) => bind.hostRoot),
    ),
  ];
}

export function hasSandboxBindContainerPathAliases(binds: readonly string[] | undefined): boolean {
  return parseSandboxBindMounts(binds).some((mount) => mount.hostRoot !== mount.containerRoot);
}

export function hasSandboxBindReadonlyHostShadows(binds: readonly string[] | undefined): boolean {
  const parsedBinds = parseSandboxBindMounts(binds);
  const writableRoots = parsedBinds.filter((bind) => bind.writable).map((bind) => bind.hostRoot);
  const readonlyRoots = parsedBinds.filter((bind) => !bind.writable).map((bind) => bind.hostRoot);
  return writableRoots.some((writableRoot) =>
    readonlyRoots.some((readonlyRoot) => isPathInside(writableRoot, readonlyRoot)),
  );
}

function parseSandboxBindMounts(binds: readonly string[] | undefined) {
  return resolveSandboxBindMounts(binds).map((mount) => ({
    hostRoot: path.resolve(mount.hostPath),
    containerRoot: mount.containerPath,
    writable: !mount.readOnly,
  }));
}

export function resolveSandboxFsPathWithMounts(params: {
  filePath: string;
  cwd: string;
  defaultWorkspaceRoot: string;
  defaultContainerRoot: string;
  mounts: SandboxFsMount[];
  containerOnlyMounts?: readonly string[];
}): SandboxResolvedFsPath {
  const mountsByContainer = params.mounts.toSorted(compareMountsByContainerPath);
  // The default workspace is an input alias, not a readable host mount. It wins
  // exact host-root ties so a second bind cannot redirect cwd-relative inputs.
  const workspaceAlias: SandboxFsMount = {
    hostRoot: path.resolve(params.defaultWorkspaceRoot),
    containerRoot: params.defaultContainerRoot,
    writable: false,
    source: "workspace",
  };
  const mountsByHost = [...params.mounts, workspaceAlias].toSorted((a, b) => {
    if (
      (a === workspaceAlias || b === workspaceAlias) &&
      path.relative(a.hostRoot, b.hostRoot) === ""
    ) {
      return Number(b === workspaceAlias) - Number(a === workspaceAlias);
    }
    return compareMountsByHostPath(a, b);
  });
  const input = params.filePath;
  const inputPosix = normalizePosixInput(normalizeSandboxInputPath(input));

  if (path.posix.isAbsolute(inputPosix)) {
    // Host-absolute inputs can live beneath a container-only /tmp. Only claim
    // a container input here when a host-backed mount provides its namespace.
    const containerMount = mountsByContainer.find((mount) =>
      isPathInsideContainerRoot(mount.containerRoot, inputPosix),
    );
    if (containerMount) {
      resolveSandboxFsMount(mountsByContainer, inputPosix, params.containerOnlyMounts);
      return resolveMountedContainerPath(containerMount, inputPosix, params.defaultContainerRoot);
    }
  }

  if (!isSandboxHostPathAbsolute(inputPosix)) {
    const cwdMount = findMountByHostPath(mountsByHost, path.resolve(params.cwd));
    const cwd = cwdMount ? mountedHostPathToContainer(cwdMount) : normalizePosixInput(params.cwd);
    const containerCandidate = normalizeContainerPathCore(
      path.posix.resolve(
        cwdMount || path.posix.isAbsolute(cwd) ? cwd : params.defaultContainerRoot,
        inputPosix,
      ),
    );
    const containerMount = resolveSandboxFsMount(
      mountsByContainer,
      containerCandidate,
      params.containerOnlyMounts,
    );
    if (containerMount) {
      return resolveMountedContainerPath(
        containerMount,
        containerCandidate,
        params.defaultContainerRoot,
      );
    }
  }

  const hostResolved = resolveSandboxInputPath(input, params.cwd);
  const hostMount = findMountByHostPath(mountsByHost, hostResolved);
  if (hostMount) {
    const containerPath = mountedHostPathToContainer(hostMount);
    const visibleMount = resolveSandboxFsMount(
      mountsByContainer,
      containerPath,
      params.containerOnlyMounts,
    );
    if (visibleMount) {
      return resolveMountedContainerPath(visibleMount, containerPath, params.defaultContainerRoot);
    }
  }

  if (path.posix.isAbsolute(inputPosix)) {
    resolveSandboxFsMount(mountsByContainer, inputPosix, params.containerOnlyMounts);
  }
  const containerRoot = normalizeContainerPathCore(params.defaultContainerRoot);
  let workspaceRoot = shortenPathWithHome(path.resolve(params.defaultWorkspaceRoot), {
    home: os.homedir(),
    prefix: "~",
  });
  if (workspaceRoot.startsWith(`~${path.sep}`)) {
    workspaceRoot = workspaceRoot.replaceAll(path.sep, path.posix.sep);
  }
  throw new Error(
    `Path escapes sandbox root (${workspaceRoot}; container root ${containerRoot}): ${input}. Use a path under ${containerRoot}/ instead.`,
  );
}

function resolveMountedContainerPath(
  mount: SandboxFsMount,
  requestedPath: string,
  defaultContainerRoot: string,
): SandboxResolvedFsPath {
  const rel = path.posix.relative(mount.containerRoot, requestedPath);
  const hostPath = rel
    ? path.resolve(mount.hostRoot, ...rel.split("/").filter(Boolean))
    : mount.hostRoot;
  const containerPath = rel ? path.posix.join(mount.containerRoot, rel) : mount.containerRoot;
  const relativePath = path.posix.relative(defaultContainerRoot, containerPath);
  return {
    hostPath,
    containerPath,
    relativePath: relativePathEscapesContainerRoot(relativePath) ? containerPath : relativePath,
    writable: mount.writable,
  };
}

function compareMountsByContainerPath(a: SandboxFsMount, b: SandboxFsMount): number {
  // Keep resolver ordering aligned with docker mount precedence for default
  // workspace mounts, but never let bridge policy classify protected skills
  // as writable.
  return (
    b.containerRoot.length - a.containerRoot.length ||
    MOUNT_SOURCE_PRIORITY[b.source] - MOUNT_SOURCE_PRIORITY[a.source]
  );
}

function compareMountsByHostPath(a: SandboxFsMount, b: SandboxFsMount): number {
  return (
    b.hostRoot.length - a.hostRoot.length ||
    MOUNT_SOURCE_PRIORITY[b.source] - MOUNT_SOURCE_PRIORITY[a.source]
  );
}

const MOUNT_SOURCE_PRIORITY = { workspace: 0, agent: 1, bind: 2, protectedSkill: 3 };

export function resolveSandboxFsMount<T extends { containerRoot: string }>(
  mounts: readonly T[],
  target: string,
  containerOnlyMounts: readonly string[] = [],
  options?: { containerOnlyAsUnmapped?: boolean },
): T | null {
  let mount: T | null = null;
  for (const entry of mounts) {
    if (
      isPathInsideContainerRoot(entry.containerRoot, target) &&
      (!mount || entry.containerRoot.length > mount.containerRoot.length)
    ) {
      mount = entry;
    }
  }
  if (
    containerOnlyMounts.some(
      (mask) =>
        isPathInsideContainerRoot(mask, target) &&
        (!mount || mask.length >= mount.containerRoot.length),
    )
  ) {
    if (options?.containerOnlyAsUnmapped) {
      return null;
    }
    throw new Error(
      `Sandbox path is container-only: ${target}. Use exec to access this mount; file tools require a host-backed bind mount.`,
    );
  }
  return mount;
}

function findMountByHostPath(
  mounts: SandboxFsMount[],
  target: string,
): {
  mount: SandboxFsMount;
  relativeHostPath: string;
} | null {
  // Preserve explicit input spelling before resolving source aliases. A longer
  // canonical source must not steal cwd from a symlinked workspace input root.
  const lexical = mounts.find((mount) => isPathInside(mount.hostRoot, path.resolve(target)));
  if (lexical) {
    return { mount: lexical, relativeHostPath: path.relative(lexical.hostRoot, target) };
  }
  for (const mount of mounts) {
    const relativeHostPath = relativePathInsideHost(mount.hostRoot, target);
    if (relativeHostPath !== null) {
      return { mount, relativeHostPath };
    }
  }
  return null;
}

function relativePathInsideHost(root: string, target: string): string | null {
  const canonicalRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(root));
  const resolvedTarget = path.resolve(target);
  // Preserve the final path segment so pre-existing symlink leaves are validated
  // by the dedicated symlink guard later in the bridge flow.
  const canonicalTargetParent = resolveSandboxHostPathViaExistingAncestor(
    path.dirname(resolvedTarget),
  );
  const canonicalTarget = path.resolve(canonicalTargetParent, path.basename(resolvedTarget));
  return isPathInside(canonicalRoot, canonicalTarget)
    ? path.relative(canonicalRoot, canonicalTarget)
    : null;
}

function mountedHostPathToContainer(params: {
  mount: SandboxFsMount;
  relativeHostPath: string;
}): string {
  return params.relativeHostPath
    ? path.posix.join(params.mount.containerRoot, normalizePosixInput(params.relativeHostPath))
    : params.mount.containerRoot;
}

function normalizePosixInput(value: string): string {
  // Convert native separators, not literal backslashes in POSIX filenames.
  return value.split(path.sep).join(path.posix.sep);
}
