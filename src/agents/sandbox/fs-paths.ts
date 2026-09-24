/**
 * Sandbox filesystem mount and path resolution helpers.
 *
 * Builds the container-to-host mount table and maps requested sandbox paths to writable/read-only host targets.
 */
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

type ParsedBindMount = {
  hostRoot: string;
  containerRoot: string;
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
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const parsed of parsedBinds) {
    if (
      !parsed.writable ||
      seen.has(parsed.hostRoot) ||
      readonlyRoots.some((root) => isPathInside(parsed.hostRoot, root))
    ) {
      continue;
    }
    seen.add(parsed.hostRoot);
    roots.push(parsed.hostRoot);
  }
  return roots;
}

export function hasSandboxBindContainerPathAliases(binds: readonly string[] | undefined): boolean {
  for (const parsed of parseSandboxBindMounts(binds)) {
    if (parsed.hostRoot !== parsed.containerRoot) {
      return true;
    }
  }
  return false;
}

export function hasSandboxBindReadonlyHostShadows(binds: readonly string[] | undefined): boolean {
  const parsedBinds = parseSandboxBindMounts(binds);
  const writableRoots = parsedBinds.filter((bind) => bind.writable).map((bind) => bind.hostRoot);
  const readonlyRoots = parsedBinds.filter((bind) => !bind.writable).map((bind) => bind.hostRoot);
  return writableRoots.some((writableRoot) =>
    readonlyRoots.some((readonlyRoot) => isPathInside(writableRoot, readonlyRoot)),
  );
}

function parseSandboxBindMounts(binds: readonly string[] | undefined): ParsedBindMount[] {
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
  const mountsByContainer = [...params.mounts].toSorted(compareMountsByContainerPath);
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
      return resolveMountedContainerPath({
        mount: containerMount,
        containerPath: inputPosix,
        defaultContainerRoot: params.defaultContainerRoot,
      });
    }
  }

  if (!isSandboxHostPathAbsolute(inputPosix)) {
    const containerCandidate = resolveRelativeContainerCandidate({
      inputPosix,
      cwd: params.cwd,
      defaultContainerRoot: params.defaultContainerRoot,
      mountsByHost,
    });
    const containerMount = resolveSandboxFsMount(
      mountsByContainer,
      containerCandidate,
      params.containerOnlyMounts,
    );
    if (containerMount) {
      return resolveMountedContainerPath({
        mount: containerMount,
        containerPath: containerCandidate,
        defaultContainerRoot: params.defaultContainerRoot,
      });
    }
  }

  const hostResolved = resolveSandboxInputPath(input, params.cwd);
  const hostMount = findMountByHostPath(mountsByHost, hostResolved);
  if (hostMount) {
    const relHost = hostMount.relativeHostPath;
    const relPosix = relHost ? relHost.split(path.sep).join(path.posix.sep) : "";
    const containerPath = relPosix
      ? path.posix.join(hostMount.mount.containerRoot, relPosix)
      : hostMount.mount.containerRoot;
    const visibleMount = resolveSandboxFsMount(
      mountsByContainer,
      containerPath,
      params.containerOnlyMounts,
    );
    if (visibleMount) {
      return resolveMountedContainerPath({
        mount: visibleMount,
        containerPath,
        defaultContainerRoot: params.defaultContainerRoot,
      });
    }
  }

  if (path.posix.isAbsolute(inputPosix)) {
    resolveSandboxFsMount(mountsByContainer, inputPosix, params.containerOnlyMounts);
  }
  const escapeMessage = formatSandboxRootEscapeMessage({
    input,
    defaultWorkspaceRoot: params.defaultWorkspaceRoot,
    defaultContainerRoot: params.defaultContainerRoot,
  });
  throw new Error(escapeMessage);
}

function resolveMountedContainerPath(params: {
  mount: SandboxFsMount;
  containerPath: string;
  defaultContainerRoot: string;
}): SandboxResolvedFsPath {
  const rel = path.posix.relative(params.mount.containerRoot, params.containerPath);
  const hostPath = rel
    ? path.resolve(params.mount.hostRoot, ...toHostSegments(rel))
    : params.mount.hostRoot;
  const containerPath = rel
    ? path.posix.join(params.mount.containerRoot, rel)
    : params.mount.containerRoot;
  return {
    hostPath,
    containerPath,
    relativePath: toDisplayRelative({
      containerPath,
      defaultContainerRoot: params.defaultContainerRoot,
    }),
    writable: params.mount.writable,
  };
}

function resolveRelativeContainerCandidate(params: {
  inputPosix: string;
  cwd: string;
  defaultContainerRoot: string;
  mountsByHost: SandboxFsMount[];
}): string {
  const cwdMount = findMountByHostPath(params.mountsByHost, path.resolve(params.cwd));
  if (cwdMount) {
    const relHost = cwdMount.relativeHostPath;
    const relPosix = relHost ? relHost.split(path.sep).join(path.posix.sep) : "";
    const containerCwd = relPosix
      ? path.posix.join(cwdMount.mount.containerRoot, relPosix)
      : cwdMount.mount.containerRoot;
    return normalizeContainerPathCore(path.posix.resolve(containerCwd, params.inputPosix));
  }
  const cwdPosix = normalizePosixInput(params.cwd);
  if (path.posix.isAbsolute(cwdPosix)) {
    return normalizeContainerPathCore(path.posix.resolve(cwdPosix, params.inputPosix));
  }
  return normalizeContainerPathCore(
    path.posix.resolve(params.defaultContainerRoot, params.inputPosix),
  );
}

function formatSandboxRootEscapeMessage(params: {
  input: string;
  defaultWorkspaceRoot: string;
  defaultContainerRoot: string;
}): string {
  const containerRoot = normalizeContainerPathCore(params.defaultContainerRoot);
  let workspaceRoot = shortenHomePath(path.resolve(params.defaultWorkspaceRoot));
  if (workspaceRoot.startsWith(`~${path.sep}`)) {
    workspaceRoot = workspaceRoot.replaceAll(path.sep, path.posix.sep);
  }
  return `Path escapes sandbox root (${workspaceRoot}; container root ${containerRoot}): ${params.input}. Use a path under ${containerRoot}/ instead.`;
}

function shortenHomePath(value: string): string {
  return shortenPathWithHome(value, { home: os.homedir(), prefix: "~" });
}

function compareMountsByContainerPath(a: SandboxFsMount, b: SandboxFsMount): number {
  const byLength = b.containerRoot.length - a.containerRoot.length;
  if (byLength !== 0) {
    return byLength;
  }
  // Keep resolver ordering aligned with docker mount precedence for default
  // workspace mounts, but never let bridge policy classify protected skills
  // as writable.
  return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}

function compareMountsByHostPath(a: SandboxFsMount, b: SandboxFsMount): number {
  const byLength = b.hostRoot.length - a.hostRoot.length;
  if (byLength !== 0) {
    return byLength;
  }
  return mountSourcePriority(b.source) - mountSourcePriority(a.source);
}

function mountSourcePriority(source: SandboxFsMount["source"]): number {
  if (source === "protectedSkill") {
    return 3;
  }
  if (source === "bind") {
    return 2;
  }
  if (source === "agent") {
    return 1;
  }
  return 0;
}

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
  return mount ?? null;
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

function toHostSegments(relativePosix: string): string[] {
  return relativePosix.split("/").filter(Boolean);
}

function toDisplayRelative(params: {
  containerPath: string;
  defaultContainerRoot: string;
}): string {
  const rel = path.posix.relative(params.defaultContainerRoot, params.containerPath);
  if (!rel) {
    return "";
  }
  if (!relativePathEscapesContainerRoot(rel)) {
    return rel;
  }
  return params.containerPath;
}

function normalizePosixInput(value: string): string {
  // Convert native separators, not literal backslashes in POSIX filenames.
  return value.split(path.sep).join(path.posix.sep);
}
