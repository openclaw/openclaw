/**
 * Runtime apply_patch tool and parser.
 * Parses OpenAI-style patch envelopes and applies add/update/delete/move hunks
 * through guarded host or sandbox filesystem operations.
 */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PATH_ALIAS_POLICIES, type PathAliasPolicy } from "@openclaw/fs-safe/advanced";
import { Type } from "typebox";
import { createAbortError } from "../infra/abort-signal.js";
import {
  type ApplyPatchContainmentSource,
  withApplyPatchContainmentHint,
} from "./apply-patch-containment-hint.js";
import {
  type ApplyPatchFileOptions,
  createPatchTarget,
  type PatchFileOps,
  resolvePatchFileOps,
  type SandboxApplyPatchConfig,
} from "./apply-patch-file-ops.js";
import { type Hunk, parsePatchText } from "./apply-patch-parse.js";
import { resolveApplyPatchInputPath, toDisplayPath } from "./apply-patch-paths.js";
import { applyUpdateHunk } from "./apply-patch-update.js";
import type { MemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import {
  preserveAtPrefixedRelativePath,
  resolvePathFromInput,
  resolveSandboxPathMapping,
} from "./path-policy.js";
import type { AgentTool } from "./runtime/index.js";
import { assertSandboxPath, markHostRootEscape } from "./sandbox-paths.js";
import { resolveSandboxFileMutationQueueKey } from "./sandbox/file-mutation-identity.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeysResolution,
} from "./sessions/tools/file-mutation-queue.js";

export type ApplyPatchSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
};

type ApplyPatchResult = {
  summary: ApplyPatchSummary;
  text: string;
  noOp?: boolean;
};

type ApplyPatchToolDetails = {
  summary: ApplyPatchSummary;
};

function normalizeUpdateComparison(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0 || normalized.endsWith("\n")) {
    return normalized;
  }
  return `${normalized}\n`;
}

type ApplyPatchOptions = ApplyPatchFileOptions & {
  patchInputPaths?: ReadonlyMap<string, string>;
};

const applyPatchSchema = Type.Object({
  input: Type.String({
    description: "Patch content using the *** Begin Patch/End Patch format.",
  }),
});

const ApplyPatchToolOutputSchema = Type.Object(
  {
    summary: Type.Object(
      {
        added: Type.Array(Type.String()),
        modified: Type.Array(Type.String()),
        deleted: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/** Create the agent tool wrapper for applying patch-envelope input. */
export function createApplyPatchTool(
  options: {
    cwd?: string;
    root?: string;
    sandbox?: SandboxApplyPatchConfig;
    workspaceOnly?: boolean;
    containmentSource?: ApplyPatchContainmentSource;
    abortSignal?: AbortSignal;
    memoryWriteProvenance?: MemoryWriteProvenanceObserver;
  } = {},
): AgentTool<typeof applyPatchSchema, ApplyPatchToolDetails> {
  const cwd = options.cwd ?? process.cwd();
  const root = options.root ?? cwd;
  const sandbox = options.sandbox;
  const workspaceOnly = options.workspaceOnly !== false;

  return {
    name: "apply_patch",
    label: "apply_patch",
    description: "Patch one/many files. Input requires *** Begin Patch and *** End Patch.",
    parameters: applyPatchSchema,
    outputSchema: ApplyPatchToolOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const executionSignal = options.abortSignal
        ? AbortSignal.any(signal ? [signal, options.abortSignal] : [options.abortSignal])
        : signal;
      const params = args as { input?: string };
      const input = typeof params.input === "string" ? params.input : "";
      if (!input.trim()) {
        throw new Error("Provide a patch input.");
      }
      if (executionSignal?.aborted) {
        throw createAbortError("Aborted");
      }

      let result: Awaited<ReturnType<typeof applyPatch>>;
      try {
        result = await applyPatch(input, {
          cwd,
          root,
          sandbox,
          workspaceOnly,
          memoryWriteProvenance: options.memoryWriteProvenance,
          signal: executionSignal,
        });
      } catch (error) {
        throw withApplyPatchContainmentHint(
          error,
          workspaceOnly ? options.containmentSource : undefined,
        );
      }

      // A no-op patch is not terminal — the model may still be mid-task and
      // needs a continuation, not an ended turn.
      return {
        content: [{ type: "text", text: result.text }],
        details: { summary: result.summary },
      };
    },
  };
}

/** Parse and apply a patch envelope to the configured filesystem target. */
async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
  const parsed = parsePatchText(input);
  if (parsed.hunks.length === 0) {
    throw new Error("No files were modified.");
  }

  const patchOptions = {
    ...options,
    patchInputPaths: await resolvePatchInputPaths(parsed.hunks, options),
  };
  // Targets resolve against the patch's initial filesystem snapshot, like its input paths.
  const resolution = resolvePatchHunks(parsed.hunks, patchOptions);
  // Hold every path the envelope touches for the whole run, so the preflight
  // reads the same state the commit pass mutates.
  return await withFileMutationQueueKeysResolution(
    resolution.then((hunks) => hunks.flatMap(({ keys }) => keys)),
    async () => {
      const hunks = await resolution;
      // Acquire only after queue admission, before the first read, so root I/O cannot
      // reorder source calls. Retain the same owner across hunks.
      const fileOps = await resolvePatchFileOps(patchOptions);
      await preflightUpdateHunks(hunks, fileOps, patchOptions.signal);
      return await commitPatchHunks(hunks, fileOps, patchOptions);
    },
  );
}

type PatchTarget = Awaited<ReturnType<typeof resolvePatchPath>>;
type ResolvedHunk = {
  hunk: Hunk;
  target: PatchTarget;
  moveTarget?: PatchTarget;
  /** Preflight state keys; see `preflightUpdateHunks`. Commit compares them to detect moves. */
  stage: string;
  moveStage?: string;
  /** Queue identities held for the run, including a path's identity once a link on it is gone. */
  keys: string[];
  /** Moving the source removes its contents, not only a final link to them. */
  removesContents: boolean;
  /** Snapshot admission refused a path an earlier removal frees; admission repeats in commit order. */
  readmit?: true;
  /** The preflight cannot read the source before the commit pass admits it. */
  unread?: true;
};

type OrderedTarget = Pick<ResolvedHunk, "target" | "stage" | "keys" | "readmit" | "unread"> & {
  /** An earlier removal of this path, or of a link above it, that it stages by. */
  removed?: UnlinkedPath;
};

/** A path a delete or move removes, and whether it was a symlink rather than the file it names. */
type UnlinkedPath = {
  path: string;
  key: string;
  stage: string;
  /** The path was a symlink or lies under a removed path, so later hunks stage it by spelling. */
  link: boolean;
  /** Host `dev:ino` of a hardlinked file; strict admission refuses its other names until then. */
  inode?: string;
};

async function resolvePatchHunks(
  hunks: Hunk[],
  options: ApplyPatchOptions,
): Promise<ResolvedHunk[]> {
  const resolved: ResolvedHunk[] = [];
  const unlinked: UnlinkedPath[] = [];
  for (const hunk of hunks) {
    throwIfPatchAborted(options.signal);
    if (hunk.kind === "delete") {
      const target = await resolveOrderedPatchPath(
        hunk.path,
        options,
        unlinked,
        PATH_ALIAS_POLICIES.unlinkTarget,
      );
      // A path an earlier hunk already frees keeps that staging; otherwise inspect the entry.
      const removed =
        target.removed && (target.removed.link || target.readmit)
          ? target.removed
          : await resolveUnlinkedPath(hunk.path, target.target, target.stage, options);
      unlinked.push(removed);
      resolved.push({
        hunk,
        target: target.target,
        stage: removed.stage,
        keys: [...target.keys, removed.key],
        removesContents: true,
        ...(target.readmit ? { readmit: true } : {}),
      });
      continue;
    }
    const target = await resolveOrderedPatchPath(hunk.path, options, unlinked);
    const moveTarget =
      hunk.kind === "update" && hunk.movePath
        ? await resolveOrderedPatchPath(hunk.movePath, options, unlinked)
        : undefined;
    let removesContents = true;
    if (moveTarget && moveTarget.stage !== target.stage) {
      const source = await resolveUnlinkedPath(hunk.path, target.target, target.stage, options);
      // Only a snapshot link still names its target; a spelling stage is a regular file by now.
      removesContents = !source.link || target.stage !== target.target.queueKey;
      unlinked.push(source);
      target.keys.push(source.key);
    }
    resolved.push({
      hunk,
      target: target.target,
      stage: target.stage,
      keys: moveTarget ? [...target.keys, ...moveTarget.keys] : target.keys,
      removesContents,
      ...(moveTarget ? { moveTarget: moveTarget.target, moveStage: moveTarget.stage } : {}),
      ...(target.readmit || moveTarget?.readmit ? { readmit: true } : {}),
      ...(target.unread ? { unread: true } : {}),
    });
  }
  return resolved;
}

const PATH_STAGE = "\0path\0";

/**
 * Queue identity follows a final symlink to the file it names, so a link and
 * its target share one key, but removing the link leaves that file in place.
 * Such a path stages by its spelling instead, apart from the file it named.
 */
async function resolveUnlinkedPath(
  rawFilePath: string,
  target: PatchTarget,
  stage: string,
  options: ApplyPatchOptions,
): Promise<UnlinkedPath> {
  const key = await resolvePathKey(target, options);
  // The host checks the entry itself; spelling case can differ from the realpath key.
  const stat = options.sandbox ? undefined : await lstatHostPath(target.resolved);
  const link = options.sandbox ? key !== target.queueKey : stat?.isSymbolicLink() === true;
  const lexical = await resolveLexicalPatchPath(rawFilePath, options);
  const inode = hardlinkInode(stat);
  return {
    path: lexical,
    key,
    stage: link ? PATH_STAGE + lexical : stage,
    link,
    ...(inode ? { inode } : {}),
  };
}

/** Queue identity of the directory entry itself, not the file a final link names. */
async function resolvePathKey(
  target: Pick<PatchTarget, "resolved">,
  options: ApplyPatchOptions,
): Promise<string> {
  const paths = options.sandbox ? path.posix : path;
  const parent = paths.dirname(target.resolved);
  const parentKey = options.sandbox
    ? await resolveSandboxFileMutationQueueKey({
        bridge: options.sandbox.bridge,
        root: options.sandbox.root,
        filePath: parent,
        cwd: options.cwd,
        signal: options.signal,
      })
    : await resolveFileMutationQueueKey(parent);
  return paths.join(parentKey, paths.basename(target.resolved));
}

async function resolvePatchFilePath(rawFilePath: string, options: ApplyPatchOptions) {
  return (
    options.patchInputPaths?.get(rawFilePath) ??
    (options.sandbox
      ? await resolveApplyPatchInputPath(rawFilePath, options)
      : preserveAtPrefixedRelativePath(rawFilePath, options.cwd))
  );
}

/** The unadmitted spelling of a patch path, for matching it against earlier removals. */
async function resolveLexicalPatchPath(
  rawFilePath: string,
  options: ApplyPatchOptions,
): Promise<string> {
  const filePath = await resolvePatchFilePath(rawFilePath, options);
  return options.sandbox
    ? options.sandbox.bridge.resolvePath({ filePath, cwd: options.cwd }).containerPath
    : resolvePathFromInput(filePath, options.cwd);
}

/**
 * Admission sees the snapshot, so a path at or under a link an earlier hunk
 * unlinks (for example `Delete File: link` then `Add File: link`) still names
 * the link here; it stages by spelling, apart from the link target. When an
 * earlier removal changes what admission sees (a link or file replaced by a
 * directory, the other name of a hardlink), a refused path is admitted again
 * in commit order instead, so the link target is never used.
 */
async function resolveOrderedPatchPath(
  rawFilePath: string,
  options: ApplyPatchOptions,
  unlinked: readonly UnlinkedPath[],
  aliasPolicy: PathAliasPolicy = PATH_ALIAS_POLICIES.strict,
): Promise<OrderedTarget> {
  if (unlinked.length === 0) {
    const target = await resolvePatchPath(rawFilePath, options, aliasPolicy);
    return { target, stage: target.queueKey, keys: [target.queueKey] };
  }
  const lexical = await resolveLexicalPatchPath(rawFilePath, options);
  let target: PatchTarget;
  try {
    target = await resolvePatchPath(rawFilePath, options, aliasPolicy);
  } catch (error) {
    const removed = findUnlinkedPath(unlinked, { lexical }, options);
    const placeholder = { resolved: lexical, display: rawFilePath };
    if (removed) {
      const queueKey = removed.key;
      return {
        target: { ...placeholder, queueKey },
        stage: removed.stage,
        keys: [queueKey],
        readmit: true,
        removed,
      };
    }
    const freed = await resolveFreedHardlink(rawFilePath, options, unlinked);
    if (!freed) {
      throw error;
    }
    return {
      target: freed,
      stage: freed.queueKey,
      keys: [freed.queueKey],
      readmit: true,
      unread: true,
    };
  }
  const removed = findUnlinkedPath(
    unlinked,
    {
      lexical,
      key: unlinked.some((entry) => entry.link) ? await resolvePathKey(target, options) : undefined,
    },
    options,
  );
  return removed?.link
    ? { target, stage: removed.stage, keys: [target.queueKey, removed.key], removed }
    : { target, stage: target.queueKey, keys: [target.queueKey] };
}

/** Another name of a host hardlink an earlier hunk removes; admission waits for commit order. */
async function resolveFreedHardlink(
  rawFilePath: string,
  options: ApplyPatchOptions,
  unlinked: readonly UnlinkedPath[],
): Promise<PatchTarget | undefined> {
  if (options.sandbox || !unlinked.some((entry) => entry.inode)) {
    return undefined;
  }
  const target = await resolvePatchPath(
    rawFilePath,
    options,
    PATH_ALIAS_POLICIES.unlinkTarget,
  ).catch(() => undefined);
  const stat = target && (await lstatHostPath(target.resolved));
  const inode = hardlinkInode(stat);
  const removedNames = unlinked.filter((entry) => inode && entry.inode === inode).length;
  // Strict admission accepts it only once every other name is gone.
  return stat && removedNames > 0 && stat.nlink - removedNames === 1 ? target : undefined;
}

async function lstatHostPath(filePath: string) {
  return await fs.lstat(filePath).catch(() => undefined);
}

function hardlinkInode(stat: Stats | undefined): string | undefined {
  return stat?.isFile() && stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : undefined;
}

/**
 * The latest removal of this path itself, matched by spelling or entry
 * identity, or of a path above it.
 */
function findUnlinkedPath(
  unlinked: readonly UnlinkedPath[],
  entryPath: { lexical: string; key?: string },
  options: ApplyPatchOptions,
): UnlinkedPath | undefined {
  const paths = options.sandbox ? path.posix : path;
  for (const entry of unlinked.toReversed()) {
    const relative = paths.relative(entry.path, entryPath.lexical);
    if (relative === "" || entry.key === entryPath.key) {
      return entry;
    }
    const outside =
      relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative);
    if (!outside) {
      return {
        path: entryPath.lexical,
        key: paths.join(entry.key, relative),
        stage: PATH_STAGE + entryPath.lexical,
        link: true,
      };
    }
  }
  return undefined;
}

const REMOVED = Symbol("removed");

/**
 * Reject predictable update failures (missing file, context mismatch, invalid
 * UTF-8) before any hunk mutates the workspace. Staged contents follow earlier
 * adds, updates, deletes, and moves by physical identity. A path at a removed
 * link, or under a removed path, stages by spelling and starts out removed.
 */
async function preflightUpdateHunks(
  hunks: ResolvedHunk[],
  fileOps: PatchFileOps,
  signal: AbortSignal | undefined,
): Promise<void> {
  // Absent: read the file; null: the commit pass admits and reads it first.
  const staged = new Map<string, string | null | typeof REMOVED>();
  for (const { hunk, target, stage, moveStage, removesContents, unread } of hunks) {
    throwIfPatchAborted(signal);
    if (hunk.kind !== "update") {
      staged.set(stage, hunk.kind === "add" ? hunk.contents : REMOVED);
      continue;
    }
    const current = staged.has(stage)
      ? staged.get(stage)
      : stage.startsWith(PATH_STAGE)
        ? REMOVED
        : unread
          ? null
          : undefined;
    let unreadable = false;
    const applied =
      current === null
        ? null
        : await applyUpdateHunk(target.resolved, hunk.chunks, {
            readFile:
              current === undefined
                ? (filePath) =>
                    fileOps.readFile(filePath).catch((error: unknown) => {
                      unreadable = true;
                      throw error;
                    })
                : async () => readStaged(current),
          }).catch((error: unknown) => {
            if (unreadable && hasCaseVariant(staged, stage)) {
              return null;
            }
            throw error;
          });
    if (moveStage !== undefined && moveStage !== stage) {
      if (removesContents) {
        staged.set(stage, REMOVED);
      }
      staged.set(moveStage, applied);
    } else {
      staged.set(stage, applied);
    }
  }
}

/**
 * A missing path keeps its spelling in its identity, so on a case-insensitive
 * filesystem a file an earlier hunk creates can stage under another spelling.
 * Leave such an unreadable path to the commit pass.
 */
function hasCaseVariant(staged: ReadonlyMap<string, unknown>, stage: string): boolean {
  const folded = stage.toLowerCase();
  return [...staged.keys()].some((key) => key.toLowerCase() === folded);
}

function readStaged(current: string | typeof REMOVED): string {
  if (current === REMOVED) {
    throw new Error("an earlier hunk in this patch removes it");
  }
  return current;
}

function throwIfPatchAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw createAbortError("Aborted", { cause: signal.reason });
  }
}

async function commitPatchHunks(
  hunks: ResolvedHunk[],
  fileOps: PatchFileOps,
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  const summary: ApplyPatchSummary = {
    added: [],
    modified: [],
    deleted: [],
  };
  const seen = {
    added: new Set<string>(),
    modified: new Set<string>(),
    deleted: new Set<string>(),
  };
  const noOpPaths = new Set<string>();

  for (const entry of hunks) {
    throwIfPatchAborted(options.signal);
    const { hunk } = entry;
    const { target, moveTarget } = entry.readmit ? await readmitPatchHunk(hunk, options) : entry;

    if (hunk.kind === "add") {
      await ensureDir(target.resolved, fileOps);
      await createPatchTarget({
        target,
        contents: hunk.contents,
        ops: fileOps,
        hint: `Use "*** Update File: ${target.display}" to change it, or delete it earlier in the same patch.`,
      });
      recordSummary(summary, seen, "added", target.display);
      continue;
    }

    if (hunk.kind === "delete") {
      await fileOps.remove(target.resolved);
      recordSummary(summary, seen, "deleted", target.display);
      continue;
    }

    const applied = await applyUpdateHunk(target.resolved, hunk.chunks, fileOps);
    if (moveTarget) {
      await ensureDir(moveTarget.resolved, fileOps);
    }
    // Container aliases can name the same file; stages follow physical identity.
    if (moveTarget && entry.moveStage !== entry.stage) {
      noOpPaths.delete(target.display);
      await createPatchTarget({
        target: moveTarget,
        contents: applied,
        ops: fileOps,
        hint: "Delete it earlier in the same patch to replace it.",
      });
      await fileOps.remove(target.resolved);
      recordSummary(summary, seen, "modified", moveTarget.display);
      continue;
    }
    const existing = await fileOps.readFile(target.resolved);
    if (normalizeUpdateComparison(existing) === normalizeUpdateComparison(applied)) {
      noOpPaths.add(target.display);
    } else {
      noOpPaths.delete(target.display);
      await fileOps.writeFile(target.resolved, applied);
      recordSummary(summary, seen, "modified", target.display);
    }
  }

  const noOp = noOpPaths.size > 0 && Object.values(summary).every((paths) => paths.length === 0);
  return {
    summary,
    text: noOp ? `No changes made to ${Array.from(noOpPaths).join(", ")}.` : formatSummary(summary),
    ...(noOp ? { noOp: true } : {}),
  };
}

async function readmitPatchHunk(
  hunk: Hunk,
  options: ApplyPatchOptions,
): Promise<{ target: PatchTarget; moveTarget?: PatchTarget }> {
  return {
    target: await resolvePatchPath(
      hunk.path,
      options,
      hunk.kind === "delete" ? PATH_ALIAS_POLICIES.unlinkTarget : PATH_ALIAS_POLICIES.strict,
    ),
    ...(hunk.kind === "update" && hunk.movePath
      ? { moveTarget: await resolvePatchPath(hunk.movePath, options) }
      : {}),
  };
}

async function resolvePatchInputPaths(
  hunks: Hunk[],
  options: ApplyPatchOptions,
): Promise<Map<string, string>> {
  const rawPaths = new Set<string>();
  for (const hunk of hunks) {
    rawPaths.add(hunk.path);
    if (hunk.kind === "update" && hunk.movePath) {
      rawPaths.add(hunk.movePath);
    }
  }
  const resolved = new Map<string, string>();
  for (const rawPath of rawPaths) {
    // Literal-@ meaning belongs to the patch's initial filesystem snapshot.
    // Resolving after an earlier hunk mutates state can silently retarget later hunks.
    resolved.set(
      rawPath,
      options.sandbox
        ? await resolveApplyPatchInputPath(rawPath, options)
        : preserveAtPrefixedRelativePath(rawPath, options.cwd),
    );
  }
  return resolved;
}

function recordSummary(
  summary: ApplyPatchSummary,
  seen: {
    added: Set<string>;
    modified: Set<string>;
    deleted: Set<string>;
  },
  bucket: keyof ApplyPatchSummary,
  value: string,
) {
  if (seen[bucket].has(value)) {
    return;
  }
  seen[bucket].add(value);
  summary[bucket].push(value);
}

function formatSummary(summary: ApplyPatchSummary): string {
  const lines = ["Success. Updated the following files:"];
  for (const file of summary.added) {
    lines.push(`A ${file}`);
  }
  for (const file of summary.modified) {
    lines.push(`M ${file}`);
  }
  for (const file of summary.deleted) {
    lines.push(`D ${file}`);
  }
  return lines.join("\n");
}

async function ensureDir(filePath: string, ops: PatchFileOps) {
  const parent = path.dirname(filePath);
  if (!parent || parent === ".") {
    return;
  }
  await ops.mkdirp?.(parent);
}

async function resolvePatchPath(
  rawFilePath: string,
  options: ApplyPatchOptions,
  aliasPolicy: PathAliasPolicy = PATH_ALIAS_POLICIES.strict,
): Promise<{ resolved: string; queueKey: string; display: string }> {
  const filePath = await resolvePatchFilePath(rawFilePath, options);
  if (options.sandbox) {
    const resolved = options.sandbox.bridge.resolvePath({
      filePath,
      cwd: options.cwd,
    });
    if (options.workspaceOnly !== false) {
      const legacyBridge = options.sandbox.bridge.pathMappings === undefined;
      const workspaceMapping = resolveSandboxPathMapping(
        options.sandbox.workspaceMounts ?? [],
        resolved.containerPath,
      );
      if (!legacyBridge && !workspaceMapping) {
        throw markHostRootEscape(
          new Error(`Path escapes sandbox root (${options.sandbox.root}): ${filePath}`),
        );
      }
      if (resolved.hostPath) {
        // Descriptor-less SDK bridges retain their published host-root admission.
        // A declared mapping miss above must never enter that compatibility path.
        const root = legacyBridge ? options.sandbox.root : workspaceMapping!.mapping.hostRoot;
        await assertSandboxPath({
          filePath: resolved.hostPath,
          cwd: root,
          root,
          allowFinalSymlinkForUnlink: aliasPolicy.allowFinalSymlinkForUnlink,
          allowFinalHardlinkForUnlink: aliasPolicy.allowFinalHardlinkForUnlink,
        });
      }
    }
    return {
      // Keep the admitted namespace: another bind can share this host source
      // with a different destination or permission. Queue identity stays physical.
      resolved: resolved.containerPath,
      queueKey: await resolveSandboxFileMutationQueueKey({
        bridge: options.sandbox.bridge,
        root: options.sandbox.root,
        filePath,
        cwd: options.cwd,
        signal: options.signal,
      }),
      display: resolved.relativePath || resolved.containerPath,
    };
  }

  const workspaceOnly = options.workspaceOnly !== false;
  const resolved = workspaceOnly
    ? (
        await assertSandboxPath({
          filePath,
          cwd: options.cwd,
          root: options.root ?? options.cwd,
          allowFinalSymlinkForUnlink: aliasPolicy.allowFinalSymlinkForUnlink,
          allowFinalHardlinkForUnlink: aliasPolicy.allowFinalHardlinkForUnlink,
        })
      ).resolved
    : resolvePathFromInput(filePath, options.cwd);
  return {
    resolved,
    queueKey: await resolveFileMutationQueueKey(resolved),
    display: toDisplayPath(resolved, options.cwd),
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.applyPatchTestApi")] = {
    applyPatch,
  };
}
