/**
 * Input resolution, path extraction, and display for the apply_patch envelope grammar.
 * Used by pre-execution policy hooks that only need destination paths, not the
 * full strict patch parser.
 */
import path from "node:path";
import { relativePathEscapesRoot } from "../infra/path-guards.js";
import { preserveAtPrefixedRelativePath, resolvePathFromInput } from "./path-policy.js";
import { normalizeFileReferencePrefix, resolveSandboxInputPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

/** Raw targets from the apply_patch envelope grammar. */
type ApplyPatchTarget = {
  kind: "add" | "delete" | "move" | "update";
  path: string;
};

const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";

function readPatchText(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && "input" in input) {
    const candidate = input.input;
    return typeof candidate === "string" ? candidate : undefined;
  }
  return undefined;
}

function normalizeMarkerHeaderLine(line: string | undefined): string | undefined {
  if (line === undefined) {
    return undefined;
  }
  const startTrimmed = line.trimStart();
  return startTrimmed.startsWith("***") ? startTrimmed.trimEnd() : undefined;
}

function readMarkerPath(line: string | undefined, marker: string): string | undefined {
  const candidate = normalizeMarkerHeaderLine(line);
  return candidate?.startsWith(marker) ? candidate.slice(marker.length) : undefined;
}

/** Walk the executor-compatible envelope grammar without resolving its paths. */
function extractApplyPatchTargets(input: unknown): ApplyPatchTarget[] {
  const text = readPatchText(input);
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const targets: ApplyPatchTarget[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines.at(index);
    const addPath = readMarkerPath(line, ADD_FILE_MARKER);
    if (addPath !== undefined) {
      targets.push({ kind: "add", path: addPath });
      while (index + 1 < lines.length && lines.at(index + 1)?.startsWith("+")) {
        index += 1;
      }
      continue;
    }
    const deletePath = readMarkerPath(line, DELETE_FILE_MARKER);
    if (deletePath !== undefined) {
      targets.push({ kind: "delete", path: deletePath });
      continue;
    }
    const updatePath = readMarkerPath(line, UPDATE_FILE_MARKER);
    if (updatePath === undefined) {
      continue;
    }
    targets.push({ kind: "update", path: updatePath });
    let lookahead = index + 1;
    while (lookahead < lines.length && lines.at(lookahead)?.trim() === "") {
      lookahead += 1;
    }
    const movePath = readMarkerPath(lines.at(lookahead), MOVE_TO_MARKER);
    if (movePath !== undefined) {
      targets.push({ kind: "move", path: movePath });
      lookahead += 1;
    }
    while (lookahead < lines.length) {
      const lookaheadLine = lines.at(lookahead);
      if (lookaheadLine === undefined || lookaheadLine.startsWith("***")) {
        break;
      }
      lookahead += 1;
    }
    index = lookahead - 1;
  }
  return targets;
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
