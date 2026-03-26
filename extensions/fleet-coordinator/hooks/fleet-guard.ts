/**
 * Fleet guard hooks — block destructive operations and coordinate Docker locks.
 *
 * Ported from .claude/hooks/fleet-guard.sh (PreToolUse) and fleet-release.sh (PostToolUse).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { acquireLock, releaseLock, getLockHolder } from "../fleet-redis.js";

const DESTRUCTIVE_DOCKER_PATTERNS = [
  /docker\s+rm\s+-f/,
  /docker\s+rmi/,
  /docker\s+system\s+prune/,
  /docker\s+volume\s+rm/,
];

const FORCE_PUSH_PATTERNS = [/git\s+push\s+--force/, /git\s+push\s+-f/];

const CATASTROPHIC_RM_PATTERNS = [/rm\s+-rf\s+\//, /rm\s+-rf\s+~/];

const DOCKER_LOCK_TRIGGERS = [
  /docker\s+compose/,
  /docker\s+build/,
  /docker\s+stop/,
  /docker\s+restart/,
];

// Track locks acquired during PreToolUse so PostToolUse can release them
const activeLocks = new Map<string, string>();

function isBlocked(command: string): { blocked: boolean; reason: string } {
  for (const pattern of DESTRUCTIVE_DOCKER_PATTERNS) {
    if (pattern.test(command))
      return {
        blocked: true,
        reason: `Blocked: destructive Docker operation (${command.slice(0, 80)})`,
      };
  }
  for (const pattern of FORCE_PUSH_PATTERNS) {
    if (pattern.test(command))
      return { blocked: true, reason: "Blocked: force push is prohibited by fleet guard" };
  }
  for (const pattern of CATASTROPHIC_RM_PATTERNS) {
    if (pattern.test(command))
      return { blocked: true, reason: "Blocked: catastrophic delete operation" };
  }
  return { blocked: false, reason: "" };
}

function needsDockerLock(command: string): boolean {
  return DOCKER_LOCK_TRIGGERS.some((p) => p.test(command));
}

export function registerFleetGuard(api: OpenClawPluginApi): void {
  const nodeId = process.env.WORKER_NODE_NAME || "unknown";

  api.on("before_tool_call", async (event) => {
    const ev = event as Record<string, unknown>;
    const toolName = ev.toolName as string | undefined;
    const args = ev.args as Record<string, unknown> | undefined;

    // Only guard shell execution tools
    if (toolName !== "Bash" && toolName !== "system_run" && toolName !== "node_exec") return;

    const command = (args?.command as string) || (args?.cmd as string) || "";
    if (!command) return;

    // Hard blocks (no Redis needed)
    const { blocked, reason } = isBlocked(command);
    if (blocked) {
      api.logger.error(reason);
      return { block: true, reason };
    }

    // Docker lock coordination
    if (needsDockerLock(command)) {
      const lockKey = `${nodeId}:docker`;
      const holder = await getLockHolder(lockKey);

      if (holder && !holder.startsWith(`agent:${nodeId}`)) {
        const msg = `Docker lock held by ${holder}. Waiting or retry later.`;
        api.logger.warn(msg);
        return { block: true, reason: msg };
      }

      const lockId = `agent:${nodeId}:${Date.now()}`;
      const acquired = await acquireLock(lockKey, lockId, 300);
      if (acquired) {
        activeLocks.set(lockKey, lockId);
      }
    }
  });

  api.on("after_tool_call", async () => {
    // Release any locks acquired during the tool call
    for (const [key, holder] of activeLocks) {
      await releaseLock(key, holder);
      activeLocks.delete(key);
    }
  });
}
