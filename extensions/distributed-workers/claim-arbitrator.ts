/** Redis-based distributed task claim using SETNX pattern. */

import { getFleetRedis } from "./fleet-redis.js";
import type { Task, TaskBackend } from "./types.js";

/**
 * Attempt to claim a task. Returns true if this node won the claim.
 *
 * Pattern:
 * 1. SET task-claim:{taskId} with NX (only if not exists) and EX (10s expiry)
 * 2. Inside lock window: re-read task, verify status is still "todo"
 * 3. Update task status to "doing" with claimed_by = nodeName
 * 4. Delete lock key
 */
export async function claimTask(
  task: Task,
  nodeName: string,
  backend: TaskBackend,
): Promise<boolean> {
  const redis = getFleetRedis();
  const lockKey = `task-claim:${task.id}`;

  if (redis) {
    try {
      const result = await redis.set(lockKey, nodeName, "EX", 10, "NX");
      if (result !== "OK") return false; // another worker got it
    } catch {
      // Redis unavailable — fall through to Archon-only claim (best effort)
    }
  }

  try {
    // Re-verify task is still claimable
    const [fresh] = await backend.fetchPendingTasks(nodeName);
    // Simple check: if the task we wanted is no longer in pending, someone else took it
    // In production, re-fetch the specific task by ID
    if (!fresh || fresh.id !== task.id) return false;

    // Claim it
    await backend.updateTaskStatus(task.id, "doing", {
      claimed_by: nodeName,
      claimed_at: new Date().toISOString(),
    });

    return true;
  } catch {
    return false;
  } finally {
    // Release the claim lock
    if (redis) {
      await redis.del(lockKey).catch(() => {});
    }
  }
}
