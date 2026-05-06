import { formatErrorMessage } from "../../infra/errors.js";
import {
  AGENT_RUN_PARENT_CALLBACK_FIELDS,
  AGENT_RUN_PARENT_MUTABLE_REF_FIELDS,
  AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS,
} from "./run-event-bridge.js";
import type { AgentHarnessAttemptParams } from "./types.js";
import { normalizeAgentWorkerLaunchMode, type AgentWorkerLaunchMode } from "./worker-mode.js";

export type AgentHarnessWorkerMode = AgentWorkerLaunchMode;

export type AgentHarnessWorkerBlocker = {
  field?: string;
  reason: string;
};

export type AgentHarnessWorkerLaunchDecision =
  | {
      mode: "inline";
      reason: "disabled" | "not_serializable";
      blockers?: AgentHarnessWorkerBlocker[];
    }
  | {
      mode: "worker";
      reason: "requested" | "serializable";
    };

const LIVE_OBJECT_FIELDS = [
  "authProfileStore",
  "authStorage",
  "contextEngine",
  "model",
  "modelRegistry",
  "replyOperation",
  "runtimePlan",
] as const;

const PARENT_OWNED_FIELDS = new Set<string>([
  ...AGENT_RUN_PARENT_CALLBACK_FIELDS,
  ...AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS,
  ...AGENT_RUN_PARENT_MUTABLE_REF_FIELDS,
]);

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function collectFunctionFieldBlockers(
  params: AgentHarnessAttemptParams,
): AgentHarnessWorkerBlocker[] {
  return Object.entries(params)
    .filter(
      (entry): entry is [string, (...args: never[]) => unknown] =>
        typeof entry[1] === "function" && !PARENT_OWNED_FIELDS.has(entry[0]),
    )
    .map(([field]) => ({
      field,
      reason: "function callbacks must stay in the parent process or be replaced by worker events",
    }));
}

export function collectAgentHarnessWorkerBlockers(
  params: AgentHarnessAttemptParams,
): AgentHarnessWorkerBlocker[] {
  const record = params as Record<string, unknown>;
  const blockers: AgentHarnessWorkerBlocker[] = [];
  for (const field of LIVE_OBJECT_FIELDS) {
    if (isPresent(record[field])) {
      blockers.push({
        field,
        reason: "live runtime object is not part of the serializable worker contract",
      });
    }
  }
  blockers.push(...collectFunctionFieldBlockers(params));
  const cloneProbe: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  for (const field of [...LIVE_OBJECT_FIELDS, ...PARENT_OWNED_FIELDS]) {
    delete cloneProbe[field];
  }
  try {
    structuredClone(cloneProbe);
  } catch (error) {
    blockers.push({
      reason: `structured clone failed: ${formatErrorMessage(error)}`,
    });
  }
  return blockers;
}

export function resolveAgentHarnessWorkerLaunch(params: {
  attempt: AgentHarnessAttemptParams;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessWorkerLaunchDecision {
  const mode = normalizeAgentWorkerLaunchMode(params.env?.OPENCLAW_AGENT_WORKER_MODE);
  if (mode === "inline") {
    return { mode: "inline", reason: "disabled" };
  }
  const blockers = collectAgentHarnessWorkerBlockers(params.attempt);
  if (blockers.length > 0) {
    if (mode === "worker") {
      throw new Error(
        `Agent harness worker mode was requested, but this attempt is not worker-serializable: ${blockers
          .map((blocker) =>
            blocker.field ? `${blocker.field}: ${blocker.reason}` : blocker.reason,
          )
          .join("; ")}`,
      );
    }
    return { mode: "inline", reason: "not_serializable", blockers };
  }
  return { mode: "worker", reason: mode === "worker" ? "requested" : "serializable" };
}
