import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "../../infra/errors.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import { createSerializableRunParamsSnapshot } from "./prepared-run.ts";
import {
  AGENT_RUN_PARENT_CALLBACK_FIELDS,
  AGENT_RUN_PARENT_MUTABLE_REF_FIELDS,
  AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS,
} from "./run-event-bridge.ts";
import { normalizeAgentWorkerLaunchMode, type AgentWorkerLaunchMode } from "./worker-mode.js";

export type PiRunWorkerMode = AgentWorkerLaunchMode;

export type PiRunWorkerBlockerCode =
  | "non_cloneable_run_params"
  | "unbridgeable_function"
  | "worker_entry_unavailable";

export interface PiRunWorkerBlocker {
  code: PiRunWorkerBlockerCode;
  field?: string;
  message: string;
}

export type PiRunWorkerLaunchDecision =
  | {
      mode: "inline";
      reason: "disabled" | "not_ready" | "worker_child";
      blockers?: PiRunWorkerBlocker[];
    }
  | {
      mode: "worker";
      reason: "requested" | "serializable";
    };

const PARENT_OWNED_FIELDS = new Set<string>([
  ...AGENT_RUN_PARENT_CALLBACK_FIELDS,
  ...AGENT_RUN_PARENT_POLICY_CALLBACK_FIELDS,
  ...AGENT_RUN_PARENT_MUTABLE_REF_FIELDS,
  "enqueue",
  "replyOperation",
]);

const SEMANTIC_BLOCKER_FIELDS = new Set<string>();

export function isDefaultPiRunWorkerEntryAvailable(): boolean {
  return existsSync(fileURLToPath(new URL("../runtime-worker.entry.js", import.meta.url)));
}

export function normalizePiRunWorkerMode(value: string | undefined): PiRunWorkerMode {
  if (value === undefined) {
    return "auto";
  }
  return normalizeAgentWorkerLaunchMode(value);
}

export function collectPiRunWorkerBlockers(params: RunEmbeddedPiAgentParams): PiRunWorkerBlocker[] {
  const blockers: PiRunWorkerBlocker[] = [];

  for (const [field, value] of Object.entries(params)) {
    if (PARENT_OWNED_FIELDS.has(field) || SEMANTIC_BLOCKER_FIELDS.has(field)) {
      continue;
    }

    if (typeof value === "function") {
      blockers.push({
        code: "unbridgeable_function",
        field,
        message: `${field} is a function and has no worker callback bridge`,
      });
    }
  }

  try {
    structuredClone(createSerializableRunParamsSnapshot(params));
  } catch (error) {
    blockers.push({
      code: "non_cloneable_run_params",
      message: `sanitized run params are not structured-cloneable: ${formatErrorMessage(error)}`,
    });
  }

  return blockers;
}

export function decidePiRunWorkerLaunch(params: {
  runParams: RunEmbeddedPiAgentParams;
  mode?: string | undefined;
  workerEntryAvailable?: boolean | undefined;
  workerChild?: boolean | undefined;
}): PiRunWorkerLaunchDecision {
  if (params.workerChild) {
    return {
      mode: "inline",
      reason: "worker_child",
    };
  }

  const mode = normalizePiRunWorkerMode(params.mode);

  if (mode === "inline") {
    return {
      mode: "inline",
      reason: "disabled",
    };
  }

  if (!(params.workerEntryAvailable ?? isDefaultPiRunWorkerEntryAvailable())) {
    const blocker: PiRunWorkerBlocker = {
      code: "worker_entry_unavailable",
      message: "worker entry is not available in this runtime build",
    };
    if (mode === "worker") {
      throw new Error(
        `PI worker mode was requested, but the run is not worker-ready: ${blocker.code}`,
      );
    }
    return {
      mode: "inline",
      reason: "not_ready",
      blockers: [blocker],
    };
  }

  const blockers = collectPiRunWorkerBlockers(params.runParams);
  if (blockers.length > 0) {
    if (mode === "worker") {
      throw new Error(
        `PI worker mode was requested, but the run is not worker-ready: ${blockers
          .map((blocker) => blocker.field ?? blocker.code)
          .join(", ")}`,
      );
    }

    return {
      mode: "inline",
      reason: "not_ready",
      blockers,
    };
  }

  if (mode === "worker") {
    return {
      mode: "worker",
      reason: "requested",
    };
  }

  return {
    mode: "worker",
    reason: "serializable",
  };
}
