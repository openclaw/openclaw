import fs from "node:fs/promises";
import path from "node:path";

/**
 * Small, structured per-session "working context" capsule.
 *
 * The JSONL transcript preserves *semantic* continuity (what was said and
 * decided). It does not cleanly preserve *engineering* working state — which
 * repo the agent was operating in, which branch, any temp clones in play,
 * etc. After `/compact` or `/new`, that state is easy to lose even when the
 * summary is fine.
 *
 * This module provides a minimal, stable file format for persisting that
 * working context next to the session file. It is intentionally small,
 * append-free, best-effort, and independent of runtime/engine wiring so it
 * can be adopted incrementally (see #67511 for the broader proposal).
 */

export type SessionWorkingContext = {
  /** Runtime cwd the agent last observed. */
  cwd?: string;
  /** Repository root the agent is actively modifying, if any. */
  activeRepoRoot?: string;
  /** Git branch checked out in the active repo, if known. */
  branch?: string;
  /** Temporary clones the session is currently using. */
  tempClones?: string[];
  /** Remote most recently pushed to. */
  lastPushRemote?: string;
  /** Branch most recently pushed. */
  lastPushBranch?: string;
  /** Whether the session is running inside a sandbox. */
  sandboxed?: boolean;
  /** ISO timestamp of the last update. Set by the writer; ignored on input. */
  updatedAt?: string;
  /** Free-form notes the agent may persist (short; not a transcript). */
  notes?: string;
};

/** Current on-disk schema version. Bump when the persisted shape changes. */
export const SESSION_WORKING_CONTEXT_VERSION = 1 as const;

type PersistedEnvelope = {
  version: number;
  context: SessionWorkingContext;
};

/**
 * Resolve the path of the working-context capsule for a given session file.
 *
 * Given `/path/to/session.jsonl`, returns `/path/to/session.context.json`.
 * The capsule sits next to the transcript so it is naturally scoped to the
 * session and cleaned up with it.
 */
export function resolveWorkingContextPath(sessionFile: string): string {
  const trimmed = sessionFile.trim();
  if (!trimmed) {
    throw new Error("resolveWorkingContextPath: sessionFile is required");
  }
  const dir = path.dirname(trimmed);
  const base = path.basename(trimmed);
  const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
  return path.join(dir, `${stem}.context.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Normalize a raw record into a {@link SessionWorkingContext}, discarding
 * unknown fields and values of the wrong type. Returns an empty object if
 * nothing usable is present.
 */
export function normalizeWorkingContext(raw: unknown): SessionWorkingContext {
  if (!isPlainObject(raw)) {
    return {};
  }
  const out: SessionWorkingContext = {};
  const cwd = coerceString(raw.cwd);
  if (cwd) out.cwd = cwd;
  const activeRepoRoot = coerceString(raw.activeRepoRoot);
  if (activeRepoRoot) out.activeRepoRoot = activeRepoRoot;
  const branch = coerceString(raw.branch);
  if (branch) out.branch = branch;
  const tempClones = coerceStringArray(raw.tempClones);
  if (tempClones) out.tempClones = tempClones;
  const lastPushRemote = coerceString(raw.lastPushRemote);
  if (lastPushRemote) out.lastPushRemote = lastPushRemote;
  const lastPushBranch = coerceString(raw.lastPushBranch);
  if (lastPushBranch) out.lastPushBranch = lastPushBranch;
  if (typeof raw.sandboxed === "boolean") out.sandboxed = raw.sandboxed;
  const updatedAt = coerceString(raw.updatedAt);
  if (updatedAt) out.updatedAt = updatedAt;
  const notes = coerceString(raw.notes);
  if (notes) out.notes = notes;
  return out;
}

/**
 * Read and parse the working-context capsule for a session.
 *
 * Returns `null` when the capsule does not exist or is unreadable/invalid.
 * Missing capsules are not errors — older sessions simply have no capsule.
 */
export async function readWorkingContext(
  sessionFile: string,
): Promise<SessionWorkingContext | null> {
  const capsulePath = resolveWorkingContextPath(sessionFile);
  let raw: string;
  try {
    raw = await fs.readFile(capsulePath, "utf-8");
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const envelope = parsed as Partial<PersistedEnvelope>;
  if (typeof envelope.version !== "number" || envelope.version <= 0) {
    return null;
  }
  if (envelope.version > SESSION_WORKING_CONTEXT_VERSION) {
    // Forward-compatible: read what we understand; ignore what we don't.
  }
  return normalizeWorkingContext(envelope.context);
}

/**
 * Persist the working-context capsule for a session.
 *
 * Writes atomically via temp + rename. The directory is created if needed.
 * `updatedAt` is stamped automatically; callers should not pass one.
 */
export async function writeWorkingContext(
  sessionFile: string,
  context: SessionWorkingContext,
  opts: { now?: () => Date } = {},
): Promise<string> {
  const capsulePath = resolveWorkingContextPath(sessionFile);
  await fs.mkdir(path.dirname(capsulePath), { recursive: true });
  const now = (opts.now ?? (() => new Date()))().toISOString();
  const normalized = normalizeWorkingContext({ ...context });
  normalized.updatedAt = now;
  const envelope: PersistedEnvelope = {
    version: SESSION_WORKING_CONTEXT_VERSION,
    context: normalized,
  };
  const tmpPath = `${capsulePath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, serialized, "utf-8");
    await fs.rename(tmpPath, capsulePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
  return capsulePath;
}

/**
 * Remove the working-context capsule for a session, if one exists.
 * Returns `true` when a capsule was removed, `false` otherwise.
 */
export async function clearWorkingContext(sessionFile: string): Promise<boolean> {
  const capsulePath = resolveWorkingContextPath(sessionFile);
  try {
    await fs.unlink(capsulePath);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
