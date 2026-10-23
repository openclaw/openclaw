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
import type { PinnedSandboxEntry } from "./fs-bridge-path-safety.js";
import { relativePathEscapesContainerRoot } from "./path-utils.js";
import type { RemoteCanonicalPath } from "./remote-fs-bridge-canonical-path.js";
import { normalizeContainerPath } from "./remote-fs-bridge-paths.js";

/**
 * Builds the canonical frame for an already-authorized pinned destination.
 * File-backed operations pin the canonical parent (the filename is stripped
 * and re-attached by the caller); directory operations pin the directory
 * itself, which an existing alias may have renamed.
 */
export async function resolveRemotePinnedCanonicalFrame(params: {
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
    script: 'readlink -n -f -- "$1"',
    args: [params.mountRootPath],
    signal: params.signal,
  });
  const canonicalMountRoot = normalizeContainerPath(result.stdout.toString("utf8"));
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

export type RemotePinnedTarget = PinnedSandboxEntry;
