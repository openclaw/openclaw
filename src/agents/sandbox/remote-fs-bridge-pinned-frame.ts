/**
 * Pinned mutation frame helpers for the remote shell-backed sandbox bridge.
 *
 * An already-authorized pinned destination is converted into the canonical
 * frame the mutation helper walks. Only the infrastructure-owned mount root
 * alias is re-read; sandbox-writable path components are never followed
 * again, so a post-authorization swap fails the containment check instead of
 * redirecting the mutation.
 */
import path from "node:path";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "./backend-handle.types.js";
import { relativePathEscapesContainerRoot } from "./path-utils.js";
import type { RemoteCanonicalPath } from "./remote-fs-bridge-canonical-path.js";
import {
  normalizeContainerPath,
  resolveRemoteMountByContainerPath,
  type RemoteMountInfo,
} from "./remote-fs-bridge-paths.js";

/** Maps a resolver action to the mutation action label used in errors. */
const REMOTE_PINNED_ACTION_LABELS: Record<
  "write" | "create" | "mkdir" | "remove" | "copy-destination",
  string
> = {
  write: "write files",
  create: "create files",
  mkdir: "create directories",
  remove: "remove files",
  "copy-destination": "copy files",
};

export function remotePinnedActionLabel(
  action: "write" | "create" | "mkdir" | "remove" | "copy-destination",
): string {
  return REMOTE_PINNED_ACTION_LABELS[action];
}

/**
 * Builds the canonical frame for an already-authorized pinned destination.
 * File-backed operations pin the canonical parent (the filename is stripped
 * and re-attached by the caller); directory operations pin the directory
 * itself, which an existing alias may have renamed.
 */
async function resolveRemotePinnedCanonicalFrame(params: {
  pinnedPath: string;
  directory: boolean;
  mountRootPath: string;
  action: string;
  signal?: AbortSignal;
  runRemoteShellScript(command: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
}): Promise<RemoteCanonicalPath> {
  const pinnedPath = normalizeContainerPath(params.pinnedPath);
  const probePath = params.directory ? pinnedPath : path.posix.dirname(pinnedPath);
  const result = await params.runRemoteShellScript({
    script: 'canonical_root=$(readlink -f -- "$1")\nprintf "%s\\n" "$canonical_root"',
    args: [params.mountRootPath],
    signal: params.signal,
  });
  const canonicalMountRoot = normalizeContainerPath(result.stdout.toString("utf8").trim());
  if (!canonicalMountRoot.startsWith("/")) {
    throw new Error(`Sandbox path canonicalization failed; cannot ${params.action}: ${pinnedPath}`);
  }
  const relative = path.posix.relative(canonicalMountRoot, probePath);
  if (relativePathEscapesContainerRoot(relative)) {
    throw new Error(`Sandbox path escapes allowed mounts; cannot ${params.action}: ${pinnedPath}`);
  }
  return {
    canonicalPath: probePath,
    canonicalMountRoot,
    logicalPath:
      relative === "."
        ? params.mountRootPath
        : normalizeContainerPath(path.posix.join(params.mountRootPath, relative)),
  };
}

/**
 * Validates a pre-authorized pinned destination against the requested entry.
 * File-backed pins must preserve the requested basename so the mutation lands
 * on the authorized entry; directory pins authorize the full directory, which
 * an existing alias may rename.
 */
export function authorizedRemotePinnedPath(
  pinnedPath: string | undefined,
  containerPath: string,
  action: string,
  options?: { directory?: boolean },
): string | undefined {
  if (pinnedPath === undefined) {
    return undefined;
  }
  const canonical = normalizeContainerPath(pinnedPath);
  if (
    !options?.directory &&
    path.posix.basename(canonical) !== path.posix.basename(containerPath)
  ) {
    throw new Error(
      `Pinned sandbox destination does not match the requested path; cannot ${action}: ${containerPath}`,
    );
  }
  return canonical;
}

export type RemotePinnedTargetParams = {
  containerPath: string;
  mountRootPath: string;
  action: string;
  requireWritable?: boolean;
  directory?: boolean;
  includeDescendants?: boolean;
  allowFinalSymlinkForUnlink?: boolean;
  /** Pre-authorized canonical pin path; skips destination re-canonicalization. */
  pinnedCanonicalPath?: string;
  signal?: AbortSignal;
};

export type RemotePinnedTarget = {
  mountRootPath: string;
  relativeParentPath: string;
  basename: string;
};

/**
 * Resolves the pinned mutation entry for a remote destination. Mount policy
 * is resolved in the logical namespace, but the mutation is pinned to the
 * canonical root so a legitimate symlinked workspace root is not reopened.
 */
export async function resolveRemotePinnedTarget(
  params: RemotePinnedTargetParams,
  deps: {
    mounts: RemoteMountInfo[];
    resolveCanonicalPath(params: {
      containerPath: string;
      mountRootPath: string;
      action: string;
      allowFinalSymlinkForUnlink?: boolean;
      signal?: AbortSignal;
    }): Promise<RemoteCanonicalPath>;
    assertRemoteProtectedPathWritable(params: {
      containerPath: string;
      action: string;
      displayPath?: string;
      signal?: AbortSignal;
      includeDescendants?: boolean;
    }): Promise<void>;
    runRemoteShellScript(
      command: SandboxBackendCommandParams,
    ): Promise<SandboxBackendCommandResult>;
  },
): Promise<RemotePinnedTarget> {
  const basename = params.directory ? "" : path.posix.basename(params.containerPath);
  if (!params.directory && (!basename || basename === "." || basename === "/")) {
    throw new Error(`Invalid sandbox entry target: ${params.containerPath}`);
  }
  const { canonicalPath, canonicalMountRoot, logicalPath } =
    params.pinnedCanonicalPath !== undefined
      ? await resolveRemotePinnedCanonicalFrame({
          // mkdirp pins the directory itself; file operations pin their parent.
          pinnedPath: params.pinnedCanonicalPath,
          directory: params.directory === true,
          mountRootPath: params.mountRootPath,
          action: params.action,
          signal: params.signal,
          runRemoteShellScript: (command) => deps.runRemoteShellScript(command),
        })
      : await deps.resolveCanonicalPath({
          // mkdirp pins the directory itself; file operations pin their parent and
          // retain no-follow handling for the final filename.
          containerPath: normalizeContainerPath(
            params.directory ? params.containerPath : path.posix.dirname(params.containerPath),
          ),
          mountRootPath: params.mountRootPath,
          action: params.action,
          allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
          signal: params.signal,
        });
  const mount = resolveRemoteMountByContainerPath(deps.mounts, logicalPath);
  if (!mount) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
    );
  }
  if (params.requireWritable && !mount.writable) {
    throw new Error(`Sandbox path is read-only; cannot ${params.action}: ${params.containerPath}`);
  }
  if (params.requireWritable) {
    await deps.assertRemoteProtectedPathWritable({
      containerPath: path.posix.join(logicalPath, basename),
      action: params.action,
      displayPath: params.containerPath,
      signal: params.signal,
      includeDescendants: params.includeDescendants,
    });
  }
  // Resolve mount policy in the logical namespace, but pin mutations to the
  // canonical root so a legitimate symlinked workspace root is not reopened.
  const relativeParentPath = path.posix.relative(canonicalMountRoot, canonicalPath);
  if (relativePathEscapesContainerRoot(relativeParentPath)) {
    throw new Error(
      `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.containerPath}`,
    );
  }
  return {
    mountRootPath: canonicalMountRoot,
    relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
    basename,
  };
}
