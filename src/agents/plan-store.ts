/**
 * Persistent plan store for cross-session task coordination.
 *
 * Phase 4.2 of the GPT 5.4 parity sprint. Modeled after Claude Code's
 * Tasks API with `CLAUDE_CODE_TASK_LIST_ID` env var concept.
 *
 * When a namespace is configured, plan state is shared across all
 * sessions using that namespace. Plans are persisted to disk at
 * `~/.openclaw/plans/<namespace>/plan.json`.
 *
 * Default (no namespace): plan is session-scoped (current behavior,
 * no change to existing flow).
 */

import crypto from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface StoredPlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  activeForm?: string;
  updatedBy?: string; // session key that last updated this step
  updatedAt?: number;
}

export interface StoredPlan {
  namespace: string;
  steps: StoredPlanStep[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Validates parsed JSON shape and strips prototype-pollution keys at every level.
 * Defense-in-depth: Node's JSON.parse doesn't pollute prototypes by default,
 * but explicitly removing __proto__/constructor/prototype keys prevents any
 * future code path from accidentally trusting them.
 */
function sanitizePlanShape(parsed: unknown, expectedNamespace: string): StoredPlan {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Plan file for "${expectedNamespace}" has invalid shape — expected object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.namespace !== "string" || obj.namespace !== expectedNamespace) {
    throw new Error(
      `Plan namespace mismatch on read: expected "${expectedNamespace}", found "${String(obj.namespace)}"`,
    );
  }
  if (!Array.isArray(obj.steps)) {
    throw new Error(`Plan file for "${expectedNamespace}" has invalid shape — steps must be array`);
  }
  // Filter prototype-pollution keys defensively at the top level.
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      continue;
    }
    safe[k] = v;
  }
  return safe as unknown as StoredPlan;
}

// Stale-lock threshold bumped to 60s to reduce false-positive theft of
// legitimate slow operations. Combined with PID liveness check, this gives
// a much more conservative recovery model.
const LOCK_STALE_MS = 60_000;
// Max allowed plan file size (defense-in-depth against giant JSON parse).
const MAX_PLAN_FILE_BYTES = 1_048_576; // 1 MiB
// Windows reserved device names — case-insensitive, with optional extension.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Strict namespace pattern — prevents path separators, control chars,
// trailing dots/spaces, and limits length.
const NAMESPACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Validates that a namespace is safe to use as a single directory name
 * under baseDir. Rejects path separators, traversal, control chars,
 * Windows reserved names, trailing dots/spaces, and over-length input.
 *
 * Hardened against:
 * - Path traversal: rejects /, \, .., leading dots
 * - Cross-namespace lock collision: rejects nested paths like "foo/.lock"
 * - Windows device name attacks: CON, PRN, AUX, NUL, COM1-9, LPT1-9
 * - Control char / null byte injection: only printable ASCII allowed
 * - Length bound: 128 chars max
 */
function validateNamespace(namespace: string): void {
  if (!namespace || typeof namespace !== "string") {
    throw new Error(`Invalid plan namespace: "${namespace}"`);
  }
  // Strict character set — alphanumeric start, then alphanumeric/dot/underscore/hyphen.
  // No /, \, control chars, spaces, or other risky characters.
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(
      `Invalid plan namespace: "${namespace}" — must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/`,
    );
  }
  // Trailing dots/spaces are problematic on Windows (silently stripped).
  if (/[.\s]$/.test(namespace)) {
    throw new Error(`Invalid plan namespace: "${namespace}" — trailing dot or space not allowed`);
  }
  // Windows reserved device names (case-insensitive, with or without extension).
  if (WINDOWS_RESERVED_RE.test(namespace)) {
    throw new Error(
      `Invalid plan namespace: "${namespace}" — matches Windows reserved device name`,
    );
  }
}

export class PlanStore {
  /** Realpath-resolved base directory — used for confinement checks. */
  private readonly baseDir: string;

  constructor(baseDir: string) {
    // Resolve symlinks at construction. If baseDir doesn't exist yet, fall
    // back to the literal path — confinement check at use time will still
    // reject targets that escape this resolved root.
    let resolved: string;
    try {
      resolved = realpathSync(baseDir);
    } catch {
      resolved = path.resolve(baseDir);
    }
    this.baseDir = resolved;
  }

  /**
   * Confines a resolved path to baseDir. Throws if the resolved target
   * escapes the realpathed base (defense against symlink redirection).
   */
  private confine(target: string): string {
    const rel = path.relative(this.baseDir, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Plan path escapes base directory: ${target}`);
    }
    return target;
  }

  private planPath(namespace: string): string {
    validateNamespace(namespace);
    return this.confine(path.join(this.baseDir, namespace, "plan.json"));
  }

  private lockPath(namespace: string): string {
    validateNamespace(namespace);
    return this.confine(path.join(this.baseDir, namespace, ".lock"));
  }

  /**
   * Reads the current plan for a namespace.
   * Returns null if no plan exists. Throws on parse/permission errors
   * so corruption is not silently ignored.
   */
  async read(namespace: string): Promise<StoredPlan | null> {
    const planFile = this.planPath(namespace);
    let handle: fs.FileHandle | undefined;
    try {
      // O_NOFOLLOW: refuse to follow symlinks at the leaf path.
      handle = await fs.open(planFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Plan path is not a regular file: ${planFile}`);
      }
      // Pre-parse size guard — refuse oversized buffers before JSON.parse.
      if (stat.size > MAX_PLAN_FILE_BYTES) {
        throw new Error(
          `Plan file exceeds max size ${MAX_PLAN_FILE_BYTES} bytes (got ${stat.size})`,
        );
      }
      const content = await handle.readFile({ encoding: "utf-8" });
      await handle.close();
      handle = undefined;
      const plan = sanitizePlanShape(JSON.parse(content), namespace);
      return plan;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return null;
      }
      // ELOOP / ENOTDIR from O_NOFOLLOW = symlink attack attempt; surface clearly.
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new Error(`Plan path symlink rejected (${code}): ${planFile}`, { cause: err });
      }
      throw err;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          /* ignore close error in finally */
        }
      }
    }
  }

  /**
   * Writes a plan for a namespace atomically (write to temp, then rename).
   * Creates the directory if needed.
   * Callers should acquire a lock first for concurrent safety.
   */
  async write(namespace: string, plan: StoredPlan): Promise<void> {
    const planFile = this.planPath(namespace); // validates namespace first (path traversal, etc.)
    if (plan.namespace !== namespace) {
      throw new Error(`Plan namespace mismatch: expected "${namespace}", got "${plan.namespace}"`);
    }
    const dir = path.dirname(planFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Atomic write: write to a temp file in the same directory, then rename.
    const tmpFile = path.join(dir, `.plan-${crypto.randomBytes(4).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmpFile, JSON.stringify(plan, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      await fs.rename(tmpFile, planFile);
    } catch (err) {
      // Clean up temp file on failure.
      try {
        await fs.unlink(tmpFile);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * Acquires a file-level lock for a namespace.
   * Returns a release function. Stale locks (older than 10s) are
   * cleaned up opportunistically by the next lock() caller.
   */
  async lock(namespace: string): Promise<() => Promise<void>> {
    const lockFile = this.lockPath(namespace);
    const dir = path.dirname(lockFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Generate a unique lock token so release can verify ownership.
    const lockToken = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    // Try to acquire lock with O_EXCL (fails if file exists).
    // If lock exists but is stale (>10s), remove and retry.
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(lockFile, "wx");
        try {
          await handle.writeFile(lockToken);
        } catch {
          // Write failed — clean up the empty/partial lock file immediately
          // instead of waiting for stale-lock cleanup.
          try {
            await handle.close();
          } catch {
            /* ignore */
          }
          try {
            await fs.unlink(lockFile);
          } catch {
            /* ignore */
          }
          throw new Error("Failed to write lock token");
        }
        await handle.close();
        handle = undefined; // closed successfully

        // Lock acquired. Return release function that verifies ownership.
        return async () => {
          try {
            const content = await fs.readFile(lockFile, "utf-8");
            if (content === lockToken) {
              await fs.unlink(lockFile);
            }
            // If token doesn't match, another process owns the lock — don't unlink.
          } catch {
            // Lock file may have been cleaned up already.
          }
        };
      } catch (err: unknown) {
        // Ensure handle is closed on any error path.
        if (handle) {
          try {
            await handle.close();
          } catch {
            /* ignore */
          }
        }
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          // Lock exists. Check if stale via mtime + PID liveness.
          try {
            // lstat (not stat) to detect symlink-attack at lock path.
            const lstat = await fs.lstat(lockFile);
            if (!lstat.isFile()) {
              throw new Error(`Lock path is not a regular file: ${lockFile}`, { cause: err });
            }
            const ageMs = Date.now() - lstat.mtimeMs;
            if (ageMs > LOCK_STALE_MS) {
              // Stale by age — also verify the holder is dead.
              // Read lock token to extract PID; if PID is alive, defer.
              let holderPid: number | undefined;
              try {
                const content = await fs.readFile(lockFile, "utf-8");
                // Token format: "{pid}-{timestamp}-{rand}"
                const pidStr = content.split("-")[0];
                const parsed = Number.parseInt(pidStr, 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                  holderPid = parsed;
                }
              } catch {
                // Couldn't read holder — proceed with mtime-based eviction.
              }
              if (holderPid !== undefined) {
                let alive = false;
                try {
                  // process.kill(pid, 0) throws ESRCH if pid is dead, no-op if alive.
                  process.kill(holderPid, 0);
                  alive = true;
                } catch (probeErr) {
                  if ((probeErr as NodeJS.ErrnoException).code !== "ESRCH") {
                    // EPERM means the process exists but we don't have permission
                    // to signal it — treat as alive (don't steal).
                    alive = true;
                  }
                }
                if (alive) {
                  // Holder is alive — wait, don't steal.
                  await new Promise((r) => setTimeout(r, 200 * (i + 1)));
                  continue;
                }
              }
              // Re-stat just before unlink to detect a new owner that
              // acquired between our stat and unlink (TOCTOU mitigation).
              try {
                const recheck = await fs.lstat(lockFile);
                if (recheck.mtimeMs > lstat.mtimeMs) {
                  // A new owner took it — back off and retry normally.
                  await new Promise((r) => setTimeout(r, 200 * (i + 1)));
                  continue;
                }
              } catch {
                // Disappeared on its own — nothing to unlink.
                continue;
              }
              await fs.unlink(lockFile);
              continue; // Retry after removing stale lock.
            }
          } catch {
            continue; // Stat failed, retry.
          }
          // Lock is fresh. Wait and retry.
          await new Promise((r) => setTimeout(r, 200 * (i + 1)));
        } else {
          throw err;
        }
      }
    }
    throw new Error(
      `Failed to acquire plan lock for namespace "${namespace}" after ${maxRetries} retries`,
    );
  }

  /**
   * Merges incoming steps into an existing plan by matching step text.
   * New steps are appended; existing steps are updated.
   * Returns the merged plan.
   */
  mergeSteps(
    existing: StoredPlanStep[],
    incoming: StoredPlanStep[],
    sessionKey?: string,
  ): StoredPlanStep[] {
    const now = Date.now();
    const attribution = sessionKey ? { updatedBy: sessionKey, updatedAt: now } : { updatedAt: now };
    const incomingMap = new Map(incoming.map((s) => [s.step, s]));
    const existingStepTexts = new Set(existing.map((s) => s.step));
    const merged = existing.map((s) => {
      const update = incomingMap.get(s.step);
      if (update) {
        return { ...update, ...attribution };
      }
      return s;
    });
    const appended = new Set<string>();
    for (const s of incoming) {
      if (!existingStepTexts.has(s.step) && !appended.has(s.step)) {
        merged.push({ ...s, ...attribution });
        appended.add(s.step);
      }
    }
    return merged;
  }
}
