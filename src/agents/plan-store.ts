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

const LOCK_STALE_MS = 10_000;

/**
 * Validates that a namespace cannot escape the base directory via
 * path traversal (e.g. "../../etc").
 */
function hasControlOrForbiddenChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // Block ASCII control chars (0x00-0x1F) and Windows-forbidden chars.
    if (code <= 0x1f) {
      return true;
    }
    if ('<>:"|?*'.includes(s[i])) {
      return true;
    }
  }
  return false;
}

function validateNamespace(namespace: string): void {
  // Check raw input for traversal BEFORE normalizing — path.normalize()
  // resolves "foo/../bar" to "bar" which would pass a post-normalize check.
  if (!namespace || namespace === "." || namespace.includes("..")) {
    throw new Error(`Invalid plan namespace: "${namespace}"`);
  }
  const normalized = path.normalize(namespace);
  if (
    !normalized ||
    normalized === "." ||
    path.isAbsolute(normalized) ||
    hasControlOrForbiddenChars(normalized)
  ) {
    throw new Error(`Invalid plan namespace: "${namespace}"`);
  }
}

export class PlanStore {
  constructor(private readonly baseDir: string) {}

  private planPath(namespace: string): string {
    validateNamespace(namespace);
    return path.join(this.baseDir, namespace, "plan.json");
  }

  private lockPath(namespace: string): string {
    validateNamespace(namespace);
    return path.join(this.baseDir, namespace, ".lock");
  }

  /**
   * Reads the current plan for a namespace.
   * Returns null if no plan exists. Throws on parse/permission errors
   * so corruption is not silently ignored.
   */
  async read(namespace: string): Promise<StoredPlan | null> {
    try {
      const content = await fs.readFile(this.planPath(namespace), "utf-8");
      const plan = JSON.parse(content) as StoredPlan;
      // Runtime shape validation — catch corrupt or manually-edited plan files.
      if (
        !plan ||
        typeof plan !== "object" ||
        typeof plan.namespace !== "string" ||
        !Array.isArray(plan.steps)
      ) {
        throw new Error(
          `Plan file for "${namespace}" has invalid shape — expected {namespace, steps[]}`,
        );
      }
      // Verify stored namespace matches requested namespace to catch corruption.
      if (plan.namespace !== namespace) {
        throw new Error(
          `Plan namespace mismatch on read: expected "${namespace}", found "${plan.namespace}"`,
        );
      }
      return plan;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
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
          // Lock exists. Check if stale.
          try {
            const stat = await fs.stat(lockFile);
            if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
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
