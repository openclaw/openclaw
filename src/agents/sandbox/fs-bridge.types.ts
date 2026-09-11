/**
 * Public sandbox filesystem bridge contracts.
 *
 * Tool and backend code use this interface to access files through the sandbox
 * boundary instead of reaching directly into host paths.
 */
import type { DirectoryEntry } from "../../infra/directory-entries.js";

/** Resolved sandbox path with host, relative, and container views. */
export type SandboxResolvedPath = {
  hostPath?: string;
  relativePath: string;
  containerPath: string;
};

/** Minimal file stat shape returned by sandbox fs bridge implementations. */
export type SandboxFsStat = {
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
};

/** Filesystem operations exposed across the sandbox boundary. */
export type SandboxFsBridge = {
  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath;
  /**
   * Resolves the canonical mutation destination before caller authorization.
   *
   * Returns two views of the same destination:
   * - `policyPath`: the destination in the caller's policy namespace. Path
   *   grants, read-only carveouts, and protected-path policies must be
   *   evaluated against this path.
   * - `pinnedPath`: the canonical mutation target in the bridge's runtime
   *   namespace. Pass it back as `pinnedPath` on the mutation so the pinned
   *   operation lands on exactly the authorized location.
   *
   * The two paths differ when the runtime resolves sandbox aliases onto
   * different host roots. Pinned mutations walk their path without following
   * symlinks, so any component swapped after resolution fails the mutation
   * instead of redirecting it.
   *
   * Directory semantics: for `mkdir` both paths describe the directory
   * itself (which an existing alias may rename); for file-backed actions
   * (`write`, `create`, `remove`, `copy-destination`) both paths describe the
   * canonical parent plus the requested basename, so the basename never
   * changes.
   */
  resolvePinnedMutationTarget?(params: {
    filePath: string;
    cwd?: string;
    action: "write" | "create" | "mkdir" | "remove" | "copy-destination";
    signal?: AbortSignal;
  }): Promise<{ policyPath: string; pinnedPath: string }>;
  /** Directory metadata only; callers paginate it without activating file contents. */
  readDirectory?(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<DirectoryEntry[]>;
  /** Reads a safely opened regular file, rejecting growth beyond an optional byte limit. */
  readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
    maxBytes?: number;
  }): Promise<Buffer>;
  /** Streams a regular file within the sandbox when the backend supports native copying. */
  copyFile?(params: {
    sourcePath: string;
    destinationPath: string;
    cwd?: string;
    mkdir?: boolean;
    /** Pre-authorized canonical destination from resolvePinnedMutationTarget. */
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    /** Pre-authorized canonical mutation target from resolvePinnedMutationTarget. */
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  /**
   * Atomically creates a file only when no entry already exists at the path.
   * Backends without this capability must omit it rather than emulate it with
   * a check followed by writeFile.
   */
  createFileExclusive?(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    /** Pre-authorized canonical destination from resolvePinnedMutationTarget. */
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<"created" | "exists">;
  mkdirp(params: {
    filePath: string;
    cwd?: string;
    /** Pre-authorized canonical destination from resolvePinnedMutationTarget. */
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    /** Pre-authorized canonical destination from resolvePinnedMutationTarget. */
    pinnedPath?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  rename(params: { from: string; to: string; cwd?: string; signal?: AbortSignal }): Promise<void>;
  stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null>;
};
