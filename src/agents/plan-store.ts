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

// O_NOFOLLOW is POSIX; Windows fs constants don't define it. Feature-detect
// to keep the read/lock paths cross-platform (matches the pattern in
// `src/infra/fs-safe.ts:72-84`). On Windows the symlink rejection
// degrades to none — Windows symlinks to outside baseDir would still be
// caught by the realpath-based `confine()` walk.
const SUPPORTS_NOFOLLOW = process.platform !== "win32" && "O_NOFOLLOW" in fsConstants;
const NOFOLLOW_FLAG = SUPPORTS_NOFOLLOW ? fsConstants.O_NOFOLLOW : 0;

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

const VALID_STEP_STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);

/**
 * Validates parsed JSON shape AND constructs a fresh prototype-safe
 * StoredPlan from validated fields only.
 *
 * Defense-in-depth: Node's JSON.parse doesn't pollute prototypes by
 * default, but constructing a fresh object only including known fields
 * (instead of returning the parsed input) guarantees that any
 * `__proto__`/`constructor`/`prototype` keys present in the source JSON
 * are dropped at every level — top-level AND per-step. The prior
 * shallow filter left step objects unfiltered, and `mergeSteps()`
 * spreads step objects via `{ ...update, ...attribution }`, so a stored
 * step containing pollution keys could have survived to the spread.
 *
 * Also enforces:
 * - Namespace matches the requested namespace (file-rename detection).
 * - Each step has non-empty `step` text + valid `status`.
 * - Required `createdAt`/`updatedAt` are non-negative numbers.
 *
 * Codex P2 (PR #67542 r3094816890) + Copilot #3105043468 / #3096520083 / #3105169764.
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
  // Per-step validation — fail fast at read time instead of crashing in
  // mergeSteps()/render() with a confusing TypeError later.
  for (let i = 0; i < obj.steps.length; i += 1) {
    const step: unknown = obj.steps[i];
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(
        `Plan file for "${expectedNamespace}" has invalid step at index ${i} — expected object, got ${Array.isArray(step) ? "array" : typeof step}`,
      );
    }
    const s = step as Record<string, unknown>;
    if (typeof s.step !== "string" || s.step.length === 0) {
      throw new Error(
        `Plan file for "${expectedNamespace}" has invalid step at index ${i} — \`step\` must be a non-empty string`,
      );
    }
    if (typeof s.status !== "string" || !VALID_STEP_STATUSES.has(s.status)) {
      throw new Error(
        `Plan file for "${expectedNamespace}" has invalid step at index ${i} — \`status\` must be one of ${[...VALID_STEP_STATUSES].join(", ")}, got "${String(s.status)}"`,
      );
    }
    if (s.activeForm !== undefined && typeof s.activeForm !== "string") {
      throw new Error(
        `Plan file for "${expectedNamespace}" has invalid step at index ${i} — \`activeForm\` must be a string when present`,
      );
    }
    // PR-F review fix (Copilot #3105397845): also validate updatedBy /
    // updatedAt when present. These are persisted by `mergeSteps()` so
    // they round-trip through the store; without validation, malformed
    // values could silently survive read.
    if (s.updatedBy !== undefined && typeof s.updatedBy !== "string") {
      throw new Error(
        `Plan file for "${expectedNamespace}" has invalid step at index ${i} — \`updatedBy\` must be a string when present`,
      );
    }
    if (
      s.updatedAt !== undefined &&
      (typeof s.updatedAt !== "number" || !Number.isFinite(s.updatedAt) || s.updatedAt < 0)
    ) {
      throw new Error(
        `Plan file for "${expectedNamespace}" has invalid step at index ${i} — \`updatedAt\` must be a non-negative number when present`,
      );
    }
  }
  // Required timestamps. Numeric only — string ISO timestamps would silently
  // pass `typeof === "number"` checks downstream as NaN.
  if (typeof obj.createdAt !== "number" || !Number.isFinite(obj.createdAt) || obj.createdAt < 0) {
    throw new Error(
      `Plan file for "${expectedNamespace}" has invalid \`createdAt\` — expected non-negative number`,
    );
  }
  if (typeof obj.updatedAt !== "number" || !Number.isFinite(obj.updatedAt) || obj.updatedAt < 0) {
    throw new Error(
      `Plan file for "${expectedNamespace}" has invalid \`updatedAt\` — expected non-negative number`,
    );
  }
  // PR-F review fix (Copilot #3105043468 / #3096520083 etc): build clean
  // step objects too — the prior shallow filter only stripped
  // prototype-pollution keys at the top level, but `mergeSteps()` later
  // spreads step objects (`{ ...update, ...attribution }`), so a stored
  // step containing `__proto__`/`constructor`/`prototype` could survive
  // and reach the spread. Construct each safe step from validated fields
  // only, dropping all other keys.
  const safeSteps: StoredPlanStep[] = [];
  for (let i = 0; i < obj.steps.length; i += 1) {
    const s = obj.steps[i] as Record<string, unknown>;
    const safeStep: StoredPlanStep = {
      step: s.step as string,
      status: s.status as StoredPlanStep["status"],
      ...(typeof s.activeForm === "string" ? { activeForm: s.activeForm } : {}),
      ...(typeof s.updatedBy === "string" ? { updatedBy: s.updatedBy } : {}),
      ...(typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt)
        ? { updatedAt: s.updatedAt }
        : {}),
    };
    safeSteps.push(safeStep);
  }
  // Filter prototype-pollution keys defensively at the top level too.
  // (Step objects above are already prototype-safe by construction.)
  const safe: StoredPlan = {
    namespace: obj.namespace,
    steps: safeSteps,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
  return safe;
}

// Stale-lock threshold bumped to 60s to reduce false-positive theft of
// legitimate slow operations. Combined with PID liveness check, this gives
// a much more conservative recovery model.
const LOCK_STALE_MS = 60_000;
// Hard upper bound (PR-F review fix, Codex P1 #3096565561): even if the
// PID-liveness probe says the lock holder is alive, a lock older than
// this hard cap is force-evicted. Mitigates the PID-reuse failure mode
// where a crashed process's PID gets recycled by an unrelated process,
// causing `process.kill(holderPid, 0)` to falsely report the original
// holder as still alive and deadlocking subsequent writers indefinitely.
// 5 minutes is well above any legitimate plan write (typically <1s).
const LOCK_HARD_MAX_MS = 5 * 60_000;
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
   * Confines a resolved path to baseDir. Throws if the lexical OR
   * realpath-resolved target escapes the realpathed base.
   *
   * Codex P1 (PR #67542 r3095586226): the lexical-only check let a
   * symlinked namespace dir bypass confinement. e.g.
   *   `<baseDir>/ns -> /tmp/attacker`
   * lexically resolves to `<baseDir>/ns/plan.json` (which IS under
   * baseDir on paper), but every subsequent open() follows the symlink
   * to `/tmp/attacker/plan.json`. The leaf `O_NOFOLLOW` we already
   * apply only blocks the FINAL hop, not parent-directory symlinks.
   *
   * This walks the longest existing ancestor of `target`, realpath()s
   * it, and rejects if the realpath escapes baseDir.
   */
  private confine(target: string): string {
    const rel = path.relative(this.baseDir, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Plan path escapes base directory: ${target}`);
    }
    // Realpath the deepest existing ancestor (start from the parent and
    // walk up). If it resolves outside baseDir, reject — a parent
    // symlink would redirect us elsewhere.
    let probe = path.dirname(target);
    while (probe.startsWith(this.baseDir)) {
      try {
        const resolved = realpathSync(probe);
        const ancestorRel = path.relative(this.baseDir, resolved);
        if (ancestorRel.startsWith("..") || path.isAbsolute(ancestorRel)) {
          throw new Error(
            `Plan path escapes base directory via parent symlink: ${target} (resolves to ${resolved})`,
          );
        }
        return target;
      } catch (err: unknown) {
        // ENOENT — this ancestor doesn't exist yet; walk up and try again.
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          const next = path.dirname(probe);
          if (next === probe) {
            break; // hit filesystem root
          }
          probe = next;
          continue;
        }
        // Anything else (loop detection, permission denied) is hostile.
        throw err;
      }
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
      // O_NOFOLLOW (POSIX-only): refuse to follow symlinks at the leaf
      // path. PR-F review fix (Copilot #3105043456): feature-detected
      // via SUPPORTS_NOFOLLOW so the path stays cross-platform — on
      // Windows the flag is `0` and parent-symlink confinement is still
      // enforced via realpath in `confine()`.
      handle = await fs.open(planFile, fsConstants.O_RDONLY | NOFOLLOW_FLAG);
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
   * Returns a release function. Stale locks (older than `LOCK_STALE_MS`,
   * currently 60s) are cleaned up opportunistically by the next
   * lock() caller. PID liveness is checked before eviction to avoid
   * stealing from a slow-but-alive holder; a hard cap
   * (`LOCK_HARD_MAX_MS`, 5 minutes) overrides the alive check to
   * guarantee progress under PID-reuse / process-stuck scenarios.
   */
  async lock(namespace: string): Promise<() => Promise<void>> {
    const lockFile = this.lockPath(namespace);
    const dir = path.dirname(lockFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Generate a unique lock token so release can verify ownership.
    const lockToken = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    // Try to acquire lock with O_EXCL (fails if file exists).
    // If lock exists but is stale (older than LOCK_STALE_MS = 60s),
    // remove and retry. A hard cap (LOCK_HARD_MAX_MS = 5 min)
    // overrides PID-liveness if the lock has been held longer than
    // any legitimate write would need (PID-reuse mitigation).
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      let handle: fs.FileHandle | undefined;
      try {
        // PR-F review fix (Copilot #3105043461): include O_NOFOLLOW so
        // an attacker who plants `<namespace>/.lock` as a symlink
        // BEFORE we try to acquire it can't redirect the create
        // outside `baseDir`. `confine()` rejects parent-symlink
        // redirection but doesn't catch a leaf-symlink at `.lock`.
        // O_EXCL+O_CREAT+O_NOFOLLOW together enforce: file must not
        // exist AND must not be a symlink.
        handle = await fs.open(
          lockFile,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG,
          0o600,
        );
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
                  // PR-F review fix (Codex P1 #3096565561): hard cap
                  // overrides the alive check to mitigate PID reuse.
                  // After a crash + reboot (or any PID rollover), the
                  // holder PID may belong to an unrelated process that
                  // would never release this lock. The hard cap
                  // guarantees progress; legitimate plan writes are
                  // sub-second so reaching `LOCK_HARD_MAX_MS` (5 min)
                  // is overwhelmingly likely a reused-PID or stuck
                  // process.
                  if (ageMs <= LOCK_HARD_MAX_MS) {
                    // Holder is alive AND within hard cap — wait, don't steal.
                    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
                    continue;
                  }
                  // Hard cap exceeded — fall through to the unlink branch
                  // below. Comment-only signal (no log import in this
                  // module): the lock was force-evicted past the deadman.
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
              // PR-F review fix (Codex P2 #3096565570): if this is the
              // final iteration, the loop would exit here without ever
              // attempting acquisition of the now-free lock. Reset the
              // retry budget for one extra acquisition attempt to
              // guarantee at least one try after a successful stale
              // cleanup. This prevents avoidable write failures right
              // when the stale threshold is crossed late in the loop.
              if (i === maxRetries - 1) {
                i -= 1; // grant one extra iteration
              }
              continue; // Retry after removing stale lock.
            }
          } catch (inspectErr: unknown) {
            // PR-F review fix (Copilot #3096520125 / #3105169755):
            // only swallow transient/expected errors here. The
            // explicit `throw new Error("Lock path is not a regular
            // file")` from the lstat-based check above (and EPERM /
            // unexpected errors in general) must be surfaced to the
            // caller so symlink-attack attempts and misconfigurations
            // aren't silently degraded into "Failed to acquire plan
            // lock" retries.
            const code = (inspectErr as NodeJS.ErrnoException).code;
            if (code === "ENOENT") {
              // Lock vanished between EEXIST and lstat — retry normally.
              continue;
            }
            // Anything else (non-file lock target, EPERM, EACCES,
            // structural problems) is hostile and must be surfaced.
            throw inspectErr;
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
