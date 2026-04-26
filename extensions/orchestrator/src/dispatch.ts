// Dispatch path. Takes a queued task, applies the routing decision,
// and either:
//   - synthetic mode: short-circuits to a canned `done` (no spawn);
//   - shadow / live mode: enqueues an inbox message for the Fleet
//     Orchestrator agent to pick up and spawn the specialist via
//     sessions_spawn (recon A-B2 picks the LLM-tool-prompted path).
//
// The actual spawn-watch path (polling for `subagent_done` per recon
// A-B2 step 6) is implemented in Unit 6 alongside the trajectory
// reader. This unit ships only the up-to-spawn half.

import { enqueueInboxMessage, type InboxOptions } from "./inbox.js";
import { decide, type CompiledRoutingConfig } from "./routing.js";
import { type Store } from "./store.js";
import type { Task, TaskKind, TaskResult } from "./types/schema.js";

export type DispatchMode = "synthetic" | "shadow" | "live";

export interface DispatchOptions {
  /** Required: the loaded routing config from `loadConfig`. */
  config: CompiledRoutingConfig;
  /** Mode flag. v0 default is "synthetic" until Unit 11 flips. */
  mode: DispatchMode;
  /** Override clock (for tests). */
  now?: () => number;
  /** Override agents root (for tests; passed through to inbox). */
  agentsDir?: string;
  /**
   * Synthetic-mode result generator. Tests inject a deterministic
   * factory; the production path uses a canned "synthetic OK" result.
   */
  syntheticResult?: (task: Task) => TaskResult;
}

export interface DispatchResult {
  task: Task;
  /** When mode is "synthetic", the task is already terminal-or-near-terminal. */
  state: Task["state"];
  /** True if an inbox message was enqueued (live/shadow). */
  enqueued: boolean;
  /** True if approval is required for this agent (recon A-S3). */
  requiresApproval: boolean;
}

const DEFAULT_SYNTHETIC_RESULT: (task: Task) => TaskResult = (task) => ({
  text: `synthetic completion for task ${task.id} (mode=synthetic; no specialist spawned)`,
  textPath: null,
  artefacts: [],
  specialistSessionId: `synthetic-${task.id}`,
});

function approvalRequiredFor(
  agentId: string,
  agentCapabilities: ReadonlyArray<string>,
  config: CompiledRoutingConfig,
): boolean {
  if (config.approvalRequired.includes(agentId)) {
    return true;
  }
  if (config.approvalRequiredCapabilities.length === 0) {
    return false;
  }
  const required = new Set(config.approvalRequiredCapabilities);
  return agentCapabilities.some((c) => required.has(c));
}

/**
 * Apply the routing decision to a queued task and either:
 *   1. Synthetically complete it (mode === "synthetic").
 *   2. Enqueue an inbox message for the orchestrator agent to spawn
 *      the specialist (mode === "shadow" | "live").
 *
 * The store is the single writer; this function calls into it via the
 * store's `transition` API so the lockfile-protected CAS path is honoured.
 */
export function dispatchTask(
  task: Task,
  store: Store,
  options: DispatchOptions & {
    /**
     * Capability resolver for the assigned agent. Defaults to the
     * v0 prefix table from `inferCapabilities`. Tests inject a stub.
     */
    inferCapabilities?: (agentId: string) => string[];
  },
): DispatchResult {
  if (task.state !== "queued") {
    throw new Error(`dispatchTask: task ${task.id} must be queued (got ${task.state})`);
  }

  const now = options.now ?? Date.now;
  const decision = decide(task.goal, task.requiredCapabilities, options.config);

  const inferCaps = options.inferCapabilities ?? (() => []);
  const agentCapabilities = inferCaps(decision.assignedAgentId);
  const requiresApproval = approvalRequiredFor(
    decision.assignedAgentId,
    agentCapabilities,
    options.config,
  );

  // queued -> assigned (routing decision recorded).
  let next = store.transition(task.id, {
    type: "route",
    routing: { ...decision, decidedAt: new Date(now()).toISOString() },
  });

  if (options.mode === "synthetic") {
    // Short-circuit: skip spawn, mint a synthetic in_progress + result.
    next = store.transition(task.id, {
      type: "start",
      specialistSessionId: `synthetic-${task.id}`,
    });
    const result = (options.syntheticResult ?? DEFAULT_SYNTHETIC_RESULT)(next);
    next = store.transition(task.id, {
      type: "complete",
      result,
      requiresApproval,
    });
    return {
      task: next,
      state: next.state,
      enqueued: false,
      requiresApproval,
    };
  }

  // shadow / live: enqueue inbox message for the orchestrator agent to
  // spawn. The actual transition to in_progress and beyond is driven by
  // the spawn-watch loop (Unit 6). For now we leave the task in
  // `assigned` and return.
  const inboxOptions: InboxOptions = {};
  if (options.agentsDir != null) {
    inboxOptions.agentsDir = options.agentsDir;
  }
  enqueueInboxMessage(
    {
      taskId: next.id,
      goal: next.goal,
      assignedAgentId: decision.assignedAgentId,
      capabilities: [...next.requiredCapabilities],
    },
    inboxOptions,
  );

  return {
    task: next,
    state: next.state,
    enqueued: true,
    requiresApproval,
  };
}

/** Re-export for callers that want the kind enum without importing types/schema directly. */
export type { TaskKind };
