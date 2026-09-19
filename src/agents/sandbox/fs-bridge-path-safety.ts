/**
 * Host/container path safety guard for the sandbox filesystem bridge.
 *
 * Proves requested container paths stay inside allowed mounts before host paths are opened or mutated.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import type { PathAliasPolicy } from "../../infra/path-alias-guards.js";
import { isPathInside } from "../../infra/path-guards.js";
import { openRootFile, type RootFileOpenResult } from "./fs-bridge-path-safety.runtime.js";
import {
  resolveSandboxFsMount,
  type SandboxResolvedFsPath,
  type SandboxFsMount,
} from "./fs-paths.js";
import {
  getSandboxHostPathPolicyKey,
  normalizeSandboxHostPath,
  resolveSandboxHostPathViaExistingAncestor,
} from "./host-paths.js";
import {
  isPathInsideContainerRoot,
  normalizeContainerPathCore,
  relativePathEscapesContainerRoot,
} from "./path-utils.js";

type BoundaryAllowedType = "file" | "directory" | "file-or-directory";

function sandboxBoundaryError(action: string, containerPath: string, error: unknown): Error {
  if (error instanceof Error && !(error instanceof FsSafeError && error.code === "not-file")) {
    return error;
  }
  return new Error(`Sandbox boundary checks failed; cannot ${action}: ${containerPath}`, {
    cause: error,
  });
}

/** Caller-provided path safety requirements for one fs bridge operation. */
type PathSafetyOptions = {
  action: string;
  aliasPolicy?: PathAliasPolicy;
  requireWritable?: boolean | "subtree";
  allowedType?: BoundaryAllowedType;
};

/** Path plus operation constraints to validate before execution. */
export type PathSafetyCheck = {
  target: SandboxResolvedFsPath;
  options: PathSafetyOptions;
};

/** Container entry pinned by mount root plus lexical parent and basename. */
export type PinnedSandboxEntry = {
  mountRootPath: string;
  relativeParentPath: string;
  basename: string;
};

/** Entry anchored by canonical parent path after symlink resolution. */
export type AnchoredSandboxEntry = {
  canonicalParentPath: string;
  basename: string;
};

/** Directory entry pinned relative to a container mount root. */
export type PinnedSandboxDirectoryEntry = {
  mountRootPath: string;
  relativePath: string;
};

type RunCommand = (
  script: string,
  options?: {
    args?: string[];
    stdin?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
  },
) => Promise<{ stdout: Buffer }>;

/** Validates sandbox fs bridge paths against mount, symlink, and writability boundaries. */
export class SandboxFsPathGuard {
  private readonly mountsByContainer: Array<SandboxFsMount & { canonicalHostRoot: string }>;
  private readonly runCommand: RunCommand;
  private readonly containerOnlyMounts: readonly string[];

  constructor(params: {
    mountsByContainer: SandboxFsMount[];
    containerOnlyMounts?: readonly string[];
    runCommand: RunCommand;
  }) {
    this.mountsByContainer = params.mountsByContainer.map((mount) => ({
      hostRoot: mount.hostRoot,
      containerRoot: mount.containerRoot,
      writable: mount.writable,
      source: mount.source,
      canonicalHostRoot: resolveSandboxHostPathViaExistingAncestor(mount.hostRoot),
    }));
    this.runCommand = params.runCommand;
    this.containerOnlyMounts = params.containerOnlyMounts ?? [];
  }

  async assertPathChecks(checks: PathSafetyCheck[]): Promise<void> {
    for (const check of checks) {
      await this.assertPathSafety(check.target, check.options);
    }
  }

  async assertPathSafety(target: SandboxResolvedFsPath, options: PathSafetyOptions) {
    // fs-safe pins one expected type. Select directory mutations explicitly;
    // its descriptor/type checks still reject swaps after this observation.
    const allowedType =
      options.allowedType === "file-or-directory"
        ? this.pathIsExistingDirectory(target.hostPath)
          ? "directory"
          : "file"
        : options.allowedType;
    const guarded = await this.openBoundaryWithinRequiredMount(target, options.action, {
      aliasPolicy: options.aliasPolicy,
      allowedType,
    });
    await this.assertGuardedPathSafety(target, { ...options, allowedType }, guarded);
  }

  async openReadableFile(
    target: SandboxResolvedFsPath,
    signal?: AbortSignal,
    expectedPolicyPath?: string,
    allowedType?: BoundaryAllowedType,
  ): Promise<RootFileOpenResult & { ok: true }> {
    const resolved = await this.resolveCanonicalReadTarget(target, "read files", signal);
    const opened = await this.openBoundaryWithinRequiredMount(resolved.target, "read files", {
      allowedType:
        allowedType === "file-or-directory"
          ? this.pathIsExistingDirectory(resolved.target.hostPath)
            ? "directory"
            : "file"
          : allowedType,
    });
    if (!opened.ok) {
      throw sandboxBoundaryError("read files", target.containerPath, opened.error);
    }
    try {
      this.assertExpectedPolicyPath(resolved.target, opened.path, expectedPolicyPath);
      // Resolve aliases in the container before opening host bytes: an
      // intermediate hop can cross mounts even when its host endpoint does not.
      // Reject a host alias changed after that resolution; keep the same FD.
      if (
        getSandboxHostPathPolicyKey(resolved.canonicalHostPath) !==
        getSandboxHostPathPolicyKey(opened.path)
      ) {
        throw new Error(
          `Sandbox path is hidden by another mount: ${target.containerPath}. Use the mounted container path directly.`,
        );
      }
    } catch (error) {
      fs.closeSync(opened.fd);
      throw error;
    }
    return opened;
  }

  private async resolveCanonicalEndpoint(
    containerPath: string,
    options?: { identity?: boolean; signal?: AbortSignal },
  ) {
    const canonicalPath = await this.resolveCanonicalContainerPath({
      containerPath,
      allowFinalSymlinkForUnlink: false,
      resolveIdentity: options?.identity,
      signal: options?.signal,
    });
    const mount = resolveSandboxFsMount(
      this.mountsByContainer,
      canonicalPath,
      this.containerOnlyMounts,
      {
        containerOnlyAsUnmapped: options?.identity,
      },
    );
    const relative = mount
      ? path.posix.relative(mount.containerRoot, canonicalPath).split("/")
      : [];
    return {
      containerPath: canonicalPath,
      mount,
      hostPath: mount ? path.resolve(mount.hostRoot, ...relative) : undefined,
      canonicalHostPath: mount ? path.resolve(mount.canonicalHostRoot, ...relative) : undefined,
    };
  }

  async resolveFileIdentity(target: SandboxResolvedFsPath, signal?: AbortSignal): Promise<string> {
    const resolved = await this.resolveCanonicalEndpoint(target.containerPath, {
      identity: true,
      signal,
    });
    // Identity coordinates callers; it must not authorize a read or prevent
    // unlinking an unresolved/outside final symlink. Unmapped endpoints never
    // borrow the hidden host path's identity.
    return resolved.canonicalHostPath ?? `container:${resolved.containerPath}`;
  }

  async resolveReadPolicyPath(
    target: SandboxResolvedFsPath,
    signal?: AbortSignal,
  ): Promise<string> {
    const resolved = await this.resolveCanonicalReadTarget(target, "authorize file reads", signal);
    return this.policyPathForHostIdentity(resolved.target, resolved.canonicalHostPath);
  }

  private policyPathForHostIdentity(target: SandboxResolvedFsPath, observedPath: string): string {
    return this.policyPathForCanonicalHostIdentity(
      target,
      resolveIdentityPathViaExistingAncestorSync(observedPath),
    );
  }

  private policyPathForCanonicalHostIdentity(
    target: SandboxResolvedFsPath,
    observedPath: string,
  ): string {
    const canonicalHostPath = normalizeSandboxHostPath(observedPath);
    const requestedMount = this.resolveMountByContainerPath(target.containerPath);
    const selected =
      requestedMount && isPathInside(requestedMount.canonicalHostRoot, canonicalHostPath)
        ? requestedMount
        : this.mountsByContainer
            .toSorted((a, b) => b.canonicalHostRoot.length - a.canonicalHostRoot.length)
            .find((mount) => isPathInside(mount.canonicalHostRoot, canonicalHostPath));
    if (!selected) {
      throw new Error(`Sandbox path escapes allowed mounts: ${target.containerPath}`);
    }
    const relativeHost = path.relative(selected.canonicalHostRoot, canonicalHostPath);
    return normalizeContainerPathCore(
      relativeHost
        ? path.posix.join(selected.containerRoot, ...relativeHost.split(path.sep))
        : selected.containerRoot,
    );
  }

  async resolveCanonicalReadTarget(
    target: SandboxResolvedFsPath,
    action: string,
    signal?: AbortSignal,
  ) {
    const resolved = await this.resolveCanonicalEndpoint(target.containerPath, { signal });
    if (!resolved.mount || !resolved.hostPath || !resolved.canonicalHostPath) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${action}: ${resolved.containerPath}`,
      );
    }
    return {
      target: {
        ...target,
        containerPath: resolved.containerPath,
        hostPath: resolved.hostPath,
        writable: resolved.mount.writable,
      },
      canonicalHostPath: resolved.canonicalHostPath,
    };
  }

  private resolveRequiredMount(containerPath: string, action: string) {
    const lexicalMount = this.resolveMountByContainerPath(containerPath);
    if (!lexicalMount) {
      throw new Error(`Sandbox path escapes allowed mounts; cannot ${action}: ${containerPath}`);
    }
    return lexicalMount;
  }

  private finalizePinnedEntry(params: {
    mount: SandboxFsMount;
    parentPath: string;
    basename: string;
    targetPath: string;
    action: string;
  }): PinnedSandboxEntry {
    const relativeParentPath = path.posix.relative(params.mount.containerRoot, params.parentPath);
    if (relativePathEscapesContainerRoot(relativeParentPath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${params.action}: ${params.targetPath}`,
      );
    }
    return {
      mountRootPath: params.mount.containerRoot,
      relativeParentPath: relativeParentPath === "." ? "" : relativeParentPath,
      basename: params.basename,
    };
  }

  private async assertGuardedPathSafety(
    target: SandboxResolvedFsPath,
    options: PathSafetyOptions,
    guarded: RootFileOpenResult,
  ) {
    if (!guarded.ok) {
      if (guarded.reason !== "path") {
        const canFallbackToDirectoryStat =
          guarded.reason === "io" &&
          options.allowedType === "directory" &&
          this.pathIsExistingDirectory(target.hostPath);
        if (!canFallbackToDirectoryStat) {
          throw sandboxBoundaryError(options.action, target.containerPath, guarded.error);
        }
      }
    } else {
      fs.closeSync(guarded.fd);
    }

    const canonicalContainerPath = await this.resolveCanonicalContainerPath({
      containerPath: target.containerPath,
      allowFinalSymlinkForUnlink: options.aliasPolicy?.allowFinalSymlinkForUnlink === true,
    });
    // Re-check the canonical path against mounts so symlinks cannot escape the sandbox root.
    const canonicalMount = this.resolveRequiredMount(canonicalContainerPath, options.action);
    if (
      options.requireWritable === "subtree" &&
      this.containerOnlyMounts.some((mask) =>
        isPathInsideContainerRoot(canonicalContainerPath, mask),
      )
    ) {
      throw new Error(
        `Sandbox subtree contains a container-only mount; cannot ${options.action}: ${target.containerPath}. Use exec to access this mount.`,
      );
    }
    // Removing or moving a parent must not bypass a narrower read-only mount.
    if (
      options.requireWritable &&
      (!canonicalMount.writable ||
        (options.requireWritable === "subtree" &&
          this.mountsByContainer.some(
            (mount) =>
              !mount.writable &&
              isPathInsideContainerRoot(canonicalContainerPath, mount.containerRoot),
          )))
    ) {
      throw new Error(
        `Sandbox path is read-only; cannot ${options.action}: ${target.containerPath}`,
      );
    }
  }

  private async openBoundaryWithinRequiredMount(
    target: SandboxResolvedFsPath,
    action: string,
    options?: {
      aliasPolicy?: PathAliasPolicy;
      allowedType?: "file" | "directory";
    },
  ): Promise<RootFileOpenResult> {
    const lexicalMount = this.resolveRequiredMount(target.containerPath, action);
    const guarded = await openRootFile({
      absolutePath: target.hostPath,
      rootPath: lexicalMount.hostRoot,
      boundaryLabel: "sandbox mount root",
      // Follow in-mount symlink hops (fs-safe rejects them by default):
      // escaping hops still fail with fs-safe's containment error, and the
      // canonical container path is re-checked against mounts afterwards.
      rejectSymlinks: false,
      aliasPolicy: options?.aliasPolicy,
      allowedType: options?.allowedType,
    });
    return guarded;
  }

  resolvePinnedEntry(target: SandboxResolvedFsPath, action: string): PinnedSandboxEntry {
    const basename = path.posix.basename(target.containerPath);
    if (!basename || basename === "." || basename === "/") {
      throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
    }
    const parentPath = normalizeContainerPathCore(path.posix.dirname(target.containerPath));
    const mount = this.resolveRequiredMount(parentPath, action);
    return this.finalizePinnedEntry({
      mount,
      parentPath,
      basename,
      targetPath: target.containerPath,
      action,
    });
  }

  async resolveAnchoredSandboxEntry(
    target: SandboxResolvedFsPath,
    action: string,
  ): Promise<AnchoredSandboxEntry> {
    const basename = path.posix.basename(target.containerPath);
    if (!basename || basename === "." || basename === "/") {
      throw new Error(`Invalid sandbox entry target: ${target.containerPath}`);
    }
    const parentPath = normalizeContainerPathCore(path.posix.dirname(target.containerPath));
    const canonicalParentPath = await this.resolveCanonicalContainerPath({
      containerPath: parentPath,
      allowFinalSymlinkForUnlink: false,
    });
    // Anchor mutations to the canonical parent; the basename is applied after boundary checks.
    this.resolveRequiredMount(canonicalParentPath, action);
    return {
      canonicalParentPath,
      basename,
    };
  }

  async resolveAnchoredPinnedEntry(
    target: SandboxResolvedFsPath,
    action: string,
  ): Promise<PinnedSandboxEntry> {
    const anchoredTarget = await this.resolveAnchoredSandboxEntry(target, action);
    const mount = this.resolveRequiredMount(anchoredTarget.canonicalParentPath, action);
    return this.finalizePinnedEntry({
      mount,
      parentPath: anchoredTarget.canonicalParentPath,
      basename: anchoredTarget.basename,
      targetPath: target.containerPath,
      action,
    });
  }

  /**
   * Resolves the canonical mutation destination so callers can authorize the
   * real target before pinning. File-backed actions resolve the canonical
   * parent and re-attach the requested basename; directory actions
   * (`options.directory`) canonicalize the directory itself, which an
   * existing alias may rename, and tolerate the mount root.
   */
  async resolveCanonicalMutationTarget(
    target: SandboxResolvedFsPath,
    action: string,
    options?: { directory?: boolean },
  ): Promise<string> {
    if (options?.directory) {
      const canonicalPath = await this.resolveCanonicalContainerPath({
        containerPath: target.containerPath,
        allowFinalSymlinkForUnlink: false,
      });
      this.resolveRequiredMount(canonicalPath, action);
      return canonicalPath;
    }
    const anchoredTarget = await this.resolveAnchoredSandboxEntry(target, action);
    this.resolveRequiredMount(anchoredTarget.canonicalParentPath, action);
    return anchoredTarget.canonicalParentPath === "/"
      ? `/${anchoredTarget.basename}`
      : `${anchoredTarget.canonicalParentPath}/${anchoredTarget.basename}`;
  }

  async resolveAnchoredPinnedDirectoryEntry(
    target: SandboxResolvedFsPath,
    action: string,
  ): Promise<PinnedSandboxDirectoryEntry> {
    // Resolve allowed aliases before no-follow descriptor traversal pins the directory.
    const containerPath = await this.resolveCanonicalContainerPath({
      containerPath: target.containerPath,
      allowFinalSymlinkForUnlink: false,
    });
    return this.resolvePinnedDirectoryEntry({ ...target, containerPath }, action);
  }

  resolvePinnedDirectoryEntry(
    target: SandboxResolvedFsPath,
    action: string,
  ): PinnedSandboxDirectoryEntry {
    const mount = this.resolveRequiredMount(target.containerPath, action);
    const relativePath = path.posix.relative(mount.containerRoot, target.containerPath);
    if (relativePathEscapesContainerRoot(relativePath)) {
      throw new Error(
        `Sandbox path escapes allowed mounts; cannot ${action}: ${target.containerPath}`,
      );
    }
    return {
      mountRootPath: mount.containerRoot,
      relativePath: relativePath === "." ? "" : relativePath,
    };
  }

  private pathIsExistingDirectory(hostPath: string): boolean {
    try {
      return fs.statSync(hostPath).isDirectory();
    } catch {
      return false;
    }
  }

  private assertExpectedPolicyPath(
    target: SandboxResolvedFsPath,
    observedPolicyPath: string,
    expectedPolicyPath: string | undefined,
  ): void {
    if (
      expectedPolicyPath !== undefined &&
      // openRootFile already bound this admitted path to the returned FD.
      // Re-resolving it here would observe a later pathname replacement.
      this.policyPathForCanonicalHostIdentity(target, observedPolicyPath) !==
        normalizeContainerPathCore(expectedPolicyPath)
    ) {
      throw new Error(`Sandbox file changed after authorization: ${target.containerPath}`);
    }
  }

  private resolveMountByContainerPath(containerPath: string) {
    const normalized = normalizeContainerPathCore(containerPath);
    return resolveSandboxFsMount(this.mountsByContainer, normalized, this.containerOnlyMounts);
  }

  private async resolveCanonicalContainerPath(params: {
    containerPath: string;
    allowFinalSymlinkForUnlink: boolean;
    resolveIdentity?: boolean;
    signal?: AbortSignal;
  }): Promise<string> {
    // Resolve the deepest existing path and append missing suffixes to handle create operations.
    const script = [
      "set -eu",
      'target="$1"',
      'allow_final="$2"',
      'identity="$3"',
      'suffix=""',
      // Explicitly suppress the readlink delimiter and retain a sentinel so
      // command substitution cannot discard newline bytes from the path.
      "read_canonical() {",
      '  canonical=$(readlink -n -f -- "$cursor" && printf .) || return',
      "  canonical=${canonical%.}",
      "}",
      'probe="$target"',
      // Targets are normalized absolute paths; parameter expansion preserves
      // path bytes that dirname/basename command substitution would strip.
      'if [ "$allow_final" = "1" ] && [ -L "$target" ]; then probe=${target%/*}; probe=${probe:-/}; fi',
      'cursor="$probe"',
      'while [ ! -e "$cursor" ] && [ ! -L "$cursor" ]; do',
      "  parent=${cursor%/*}; parent=${parent:-/}",
      '  if [ "$parent" = "$cursor" ]; then break; fi',
      "  base=${cursor##*/}",
      '  suffix="/$base$suffix"',
      '  cursor="$parent"',
      "done",
      'if [ "$identity" = "1" ]; then',
      // Match the host identity owner's existing-ancestor fallback, including
      // dangling links and loops, without relaxing read/mutation validation.
      "  while ! read_canonical; do",
      "    parent=${cursor%/*}; parent=${parent:-/}",
      '    if [ "$parent" = "$cursor" ]; then canonical="$target"; suffix=""; break; fi',
      "    base=${cursor##*/}",
      '    suffix="/$base$suffix"',
      '    cursor="$parent"',
      "  done",
      "else",
      "  read_canonical",
      "fi",
      'printf "%s%s\\n" "$canonical" "$suffix"',
    ].join("\n");
    const result = await this.runCommand(script, {
      args: [
        params.containerPath,
        params.allowFinalSymlinkForUnlink ? "1" : "0",
        params.resolveIdentity ? "1" : "0",
      ],
      signal: params.signal,
    });
    // Remove the record terminator, not significant whitespace in the path.
    const canonical = result.stdout.toString("utf8").replace(/\n$/, "");
    if (!canonical.startsWith("/")) {
      throw new Error(`Failed to resolve canonical sandbox path: ${params.containerPath}`);
    }
    return normalizeContainerPathCore(canonical);
  }
}
