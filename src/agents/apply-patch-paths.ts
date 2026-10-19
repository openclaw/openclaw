/**
 * Input resolution, path extraction, and display for the apply_patch envelope grammar.
 * Used by pre-execution policy hooks that only need destination paths, not the
 * full strict patch parser.
 */
import path from "node:path";
import { extractApplyPatchTargets } from "./apply-patch-targets.js";
import { preserveAtPrefixedRelativePath, resolvePathFromInput } from "./path-policy.js";
import { normalizeFileReferencePrefix, resolveSandboxInputPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

function relativePathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    path.isAbsolute(relativePath)
  );
}

export function toDisplayPath(resolved: string, cwd: string): string {
  const relative = path.relative(cwd, resolved);
  if (!relative) {
    return path.basename(resolved);
  }
  if (relativePathEscapesRoot(relative)) {
    return resolved;
  }
  return relative;
}

// Policy hooks accept malformed envelopes; the executor owns strict validation.
// Target scanning still follows its header/body rules and keeps first-seen order.
export type ApplyPatchPathExtractionOptions = {
  /** Tool execution cwd. Defaults to process.cwd(), matching createApplyPatchTool. */
  cwd?: string;
  /** Run cancellation propagated to remote path disambiguation. */
  signal?: AbortSignal;
  /** Sandbox bridge used by apply_patch execution, when the tool runs in a sandbox. */
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

/** Resolve a patch input through the same literal-@ policy used by execution. */
export async function resolveApplyPatchInputPath(
  raw: string,
  options: ApplyPatchPathExtractionOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
  const preserved = await preserveAtPrefixedRelativePath(
    raw,
    cwd,
    options.sandbox?.bridge,
    options.signal,
  );
  if (!raw.startsWith("@") || preserved !== raw) {
    return preserved;
  }
  const referenced = normalizeFileReferencePrefix(raw);
  return referenced === "~" || referenced.startsWith("~/") || referenced.startsWith("~\\")
    ? resolvePathFromInput(raw, cwd)
    : referenced;
}

function normalizePatchPath(
  raw: string,
  options: ApplyPatchPathExtractionOptions = {},
): string | undefined {
  if (raw.length === 0) {
    return undefined;
  }
  const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
  try {
    const filePath = preserveAtPrefixedRelativePath(raw, cwd);
    const resolved = options.sandbox
      ? options.sandbox.bridge.resolvePath({
          filePath,
          cwd,
        })
      : undefined;
    const normalized = path.normalize(
      resolved
        ? (resolved.hostPath ?? resolved.containerPath)
        : resolveSandboxInputPath(filePath, cwd),
    );
    return normalized && normalized !== "." ? normalized : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve distinct target paths without admitting or executing the patch. */
export function extractApplyPatchTargetPaths(
  input: unknown,
  options: ApplyPatchPathExtractionOptions = {},
): string[] {
  const paths = new Set<string>();
  for (const target of extractApplyPatchTargets(input)) {
    const normalized = normalizePatchPath(target.path, options);
    if (normalized) {
      paths.add(normalized);
    }
  }
  return [...paths];
}

/** Derive policy-visible paths using the asynchronous resolver used by execution. */
export async function extractResolvedApplyPatchTargetPaths(
  input: unknown,
  options: ApplyPatchPathExtractionOptions = {},
): Promise<string[]> {
  const paths = new Set<string>();
  const cwd = options.cwd ?? options.sandbox?.root ?? process.cwd();
  for (const target of extractApplyPatchTargets(input)) {
    try {
      const filePath = await resolveApplyPatchInputPath(target.path, options);
      const resolved = options.sandbox?.bridge.resolvePath({ filePath, cwd });
      const normalized = resolved?.hostPath
        ? path.normalize(resolved.hostPath)
        : resolved
          ? path.posix.normalize(resolved.containerPath)
          : path.normalize(resolveSandboxInputPath(filePath, cwd));
      if (normalized && normalized !== ".") {
        paths.add(normalized);
      }
    } catch {
      options.signal?.throwIfAborted();
      // Derived paths are best-effort metadata; execution remains authoritative.
    }
  }
  return [...paths];
}
