import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";

export type ExecutionGraphNodeStatus = "pending" | "running" | "succeeded" | "failed";

export type ExecutionGraphNodeStateV0 = {
  nodeId: string;
  status: ExecutionGraphNodeStatus;
  /** Logical graph plan/version identifier for deterministic replay compatibility checks. */
  planVersion: string;
  /** Stable hash of node inputs (graph inputs + dependency outputs). */
  inputsHash: string;
  /** Short human-readable result summary persisted for observability/debugging. */
  outputsSummary?: string;
  /** Truncated serialized error trace when node execution fails. */
  errorTrace?: string;
  /** Optional raw output used for deterministic downstream replay/resume. */
  output?: unknown;
  startedAtMs?: number;
  updatedAtMs: number;
  attempts: number;
};

export type PersistedExecutionGraphRunV0 = {
  version: 1;
  graphId: string;
  runId: string;
  planVersion: string;
  createdAtMs: number;
  updatedAtMs: number;
  nodeStates: Record<string, ExecutionGraphNodeStateV0>;
};

export interface ExecutionGraphStateStoreV0 {
  load(params: { graphId: string; runId: string }): PersistedExecutionGraphRunV0 | undefined;
  save(state: PersistedExecutionGraphRunV0): void;
  resolvePath(params: { graphId: string; runId: string }): string;
}

function resolveExecutionGraphStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

function sanitizeSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "unknown";
  }
  return trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function buildRunFileName(runId: string): string {
  const safeRunId = sanitizeSegment(runId) || "run";
  const hash = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return `${safeRunId}-${hash}.json`;
}

function toNodeState(value: unknown): ExecutionGraphNodeStateV0 | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const entry = value as Partial<ExecutionGraphNodeStateV0>;
  if (!entry.nodeId || typeof entry.nodeId !== "string") {
    return undefined;
  }
  if (
    entry.status !== "pending" &&
    entry.status !== "running" &&
    entry.status !== "succeeded" &&
    entry.status !== "failed"
  ) {
    return undefined;
  }
  if (!entry.planVersion || typeof entry.planVersion !== "string") {
    return undefined;
  }
  if (!entry.inputsHash || typeof entry.inputsHash !== "string") {
    return undefined;
  }
  if (typeof entry.updatedAtMs !== "number") {
    return undefined;
  }
  return {
    nodeId: entry.nodeId,
    status: entry.status,
    planVersion: entry.planVersion,
    inputsHash: entry.inputsHash,
    outputsSummary: typeof entry.outputsSummary === "string" ? entry.outputsSummary : undefined,
    errorTrace: typeof entry.errorTrace === "string" ? entry.errorTrace : undefined,
    output: entry.output,
    startedAtMs: typeof entry.startedAtMs === "number" ? entry.startedAtMs : undefined,
    updatedAtMs: entry.updatedAtMs,
    attempts:
      typeof entry.attempts === "number" && Number.isInteger(entry.attempts) && entry.attempts > 0
        ? entry.attempts
        : 1,
  };
}

function toPersistedRun(value: unknown): PersistedExecutionGraphRunV0 | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<PersistedExecutionGraphRunV0>;
  if (raw.version !== 1) {
    return undefined;
  }
  if (!raw.graphId || typeof raw.graphId !== "string") {
    return undefined;
  }
  if (!raw.runId || typeof raw.runId !== "string") {
    return undefined;
  }
  if (!raw.planVersion || typeof raw.planVersion !== "string") {
    return undefined;
  }
  if (typeof raw.createdAtMs !== "number" || typeof raw.updatedAtMs !== "number") {
    return undefined;
  }
  const nodeStatesRaw = raw.nodeStates;
  if (!nodeStatesRaw || typeof nodeStatesRaw !== "object") {
    return undefined;
  }

  const nodeStates: Record<string, ExecutionGraphNodeStateV0> = {};
  for (const [nodeId, nodeStateRaw] of Object.entries(nodeStatesRaw)) {
    const parsed = toNodeState(nodeStateRaw);
    if (!parsed) {
      continue;
    }
    nodeStates[nodeId] = parsed;
  }

  return {
    version: 1,
    graphId: raw.graphId,
    runId: raw.runId,
    planVersion: raw.planVersion,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
    nodeStates,
  };
}

export class FileExecutionGraphStateStoreV0 implements ExecutionGraphStateStoreV0 {
  private readonly env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
  }

  resolvePath(params: { graphId: string; runId: string }): string {
    const stateDir = resolveExecutionGraphStateDir(this.env);
    const graphId = sanitizeSegment(params.graphId) || "graph";
    const fileName = buildRunFileName(params.runId);
    return path.join(stateDir, "agents", "execution-graph-v0", graphId, fileName);
  }

  load(params: { graphId: string; runId: string }): PersistedExecutionGraphRunV0 | undefined {
    const pathname = this.resolvePath(params);
    const raw = loadJsonFile(pathname);
    const parsed = toPersistedRun(raw);
    if (!parsed) {
      return undefined;
    }
    if (parsed.graphId !== params.graphId || parsed.runId !== params.runId) {
      return undefined;
    }
    return parsed;
  }

  save(state: PersistedExecutionGraphRunV0): void {
    const pathname = this.resolvePath({ graphId: state.graphId, runId: state.runId });
    saveJsonFile(pathname, state);
  }
}

export function createInMemoryExecutionGraphStateStoreV0(
  seed: Record<string, PersistedExecutionGraphRunV0> = {},
): ExecutionGraphStateStoreV0 {
  const state = new Map<string, PersistedExecutionGraphRunV0>(Object.entries(seed));
  const keyOf = (params: { graphId: string; runId: string }) =>
    `${params.graphId}::${params.runId}`;
  return {
    load(params) {
      const key = keyOf(params);
      const value = state.get(key);
      if (!value) {
        return undefined;
      }
      return JSON.parse(JSON.stringify(value)) as PersistedExecutionGraphRunV0;
    },
    save(next) {
      state.set(
        keyOf({ graphId: next.graphId, runId: next.runId }),
        JSON.parse(JSON.stringify(next)),
      );
    },
    resolvePath(params) {
      return keyOf(params);
    },
  };
}
