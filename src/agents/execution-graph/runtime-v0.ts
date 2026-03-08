import { createHash } from "node:crypto";
import {
  type ExecutionGraphNodeStateV0,
  type ExecutionGraphStateStoreV0,
  type PersistedExecutionGraphRunV0,
} from "./state-store-v0.js";

export type ExecutionGraphNodeDefinitionV0<TContext> = {
  id: string;
  deps?: string[];
  run: (params: {
    context: TContext;
    graphInputs: unknown;
    depOutputs: Record<string, unknown>;
  }) => Promise<unknown>;
  summarizeOutput?: (output: unknown) => string | undefined;
};

export type RunExecutionGraphV0Params<TContext> = {
  graphId: string;
  runId: string;
  planVersion: string;
  graphInputs?: unknown;
  context: TContext;
  nodes: ExecutionGraphNodeDefinitionV0<TContext>[];
  stateStore: ExecutionGraphStateStoreV0;
  nowMs?: () => number;
  maxErrorTraceChars?: number;
};

export type RunExecutionGraphV0Result = {
  status: "ok" | "failed";
  run: PersistedExecutionGraphRunV0;
  nodeOutputs: Record<string, unknown>;
  resumed: boolean;
  failedNodeId?: string;
  error?: string;
};

const DEFAULT_MAX_ERROR_TRACE_CHARS = 4000;

export async function runExecutionGraphV0<TContext>(
  params: RunExecutionGraphV0Params<TContext>,
): Promise<RunExecutionGraphV0Result> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const maxErrorTraceChars =
    typeof params.maxErrorTraceChars === "number" && params.maxErrorTraceChars > 0
      ? Math.floor(params.maxErrorTraceChars)
      : DEFAULT_MAX_ERROR_TRACE_CHARS;

  const executionOrder = resolveExecutionOrder(params.nodes);
  const nodeById = new Map(params.nodes.map((node) => [node.id, node]));

  const persisted = params.stateStore.load({ graphId: params.graphId, runId: params.runId });
  const resumed = Boolean(persisted);
  const run: PersistedExecutionGraphRunV0 =
    persisted ??
    ({
      version: 1,
      graphId: params.graphId,
      runId: params.runId,
      planVersion: params.planVersion,
      createdAtMs: nowMs(),
      updatedAtMs: nowMs(),
      nodeStates: {},
    } satisfies PersistedExecutionGraphRunV0);

  if (run.planVersion !== params.planVersion) {
    run.planVersion = params.planVersion;
  }

  const nodeOutputs: Record<string, unknown> = {};
  for (const nodeId of executionOrder) {
    const priorOutput = run.nodeStates[nodeId]?.output;
    if (priorOutput !== undefined) {
      nodeOutputs[nodeId] = priorOutput;
    }
  }

  for (const nodeId of executionOrder) {
    const node = nodeById.get(nodeId);
    if (!node) {
      continue;
    }
    const depOutputs: Record<string, unknown> = {};
    for (const depId of node.deps ?? []) {
      depOutputs[depId] = nodeOutputs[depId];
    }

    const inputsHash = hashStable({
      graphId: params.graphId,
      runId: params.runId,
      nodeId,
      planVersion: params.planVersion,
      graphInputs: params.graphInputs,
      depOutputs,
    });

    const previous = run.nodeStates[nodeId];
    const canReplay =
      previous?.status === "succeeded" &&
      previous.planVersion === params.planVersion &&
      previous.inputsHash === inputsHash;

    if (canReplay) {
      nodeOutputs[nodeId] = previous.output;
      continue;
    }

    const startedAt = nowMs();
    const runningState: ExecutionGraphNodeStateV0 = {
      nodeId,
      status: "running",
      planVersion: params.planVersion,
      inputsHash,
      outputsSummary: undefined,
      errorTrace: undefined,
      output: undefined,
      startedAtMs: startedAt,
      updatedAtMs: startedAt,
      attempts: (previous?.attempts ?? 0) + 1,
    };
    run.nodeStates[nodeId] = runningState;
    run.updatedAtMs = nowMs();
    params.stateStore.save(run);

    let output: unknown;
    try {
      output = await node.run({
        context: params.context,
        graphInputs: params.graphInputs,
        depOutputs,
      });
    } catch (err) {
      const failedAt = nowMs();
      const errorTrace = formatErrorTrace(err, maxErrorTraceChars);
      run.nodeStates[nodeId] = {
        ...runningState,
        status: "failed",
        errorTrace,
        outputsSummary: "failed",
        updatedAtMs: failedAt,
      };
      run.updatedAtMs = failedAt;
      params.stateStore.save(run);
      return {
        status: "failed",
        run,
        nodeOutputs,
        resumed,
        failedNodeId: nodeId,
        error: errorTrace,
      };
    }

    const completedAt = nowMs();
    const outputsSummary = summarizeOutput(node, output);
    run.nodeStates[nodeId] = {
      ...runningState,
      status: "succeeded",
      output,
      outputsSummary,
      updatedAtMs: completedAt,
    };
    run.updatedAtMs = completedAt;
    nodeOutputs[nodeId] = output;
    params.stateStore.save(run);
  }

  return {
    status: "ok",
    run,
    nodeOutputs,
    resumed,
  };
}

function summarizeOutput<TContext>(
  node: ExecutionGraphNodeDefinitionV0<TContext>,
  output: unknown,
): string | undefined {
  const custom = node.summarizeOutput?.(output);
  if (custom && custom.trim()) {
    return custom.trim().slice(0, 240);
  }
  return summarizeUnknown(output);
}

function summarizeUnknown(output: unknown): string | undefined {
  if (output === undefined) {
    return "undefined";
  }
  if (output === null) {
    return "null";
  }
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) {
      return "string(empty)";
    }
    return `string(${trimmed.slice(0, 96)})`;
  }
  if (typeof output === "number" || typeof output === "boolean") {
    return `${typeof output}(${String(output)})`;
  }
  if (Array.isArray(output)) {
    return `array(len=${output.length})`;
  }
  if (typeof output === "object") {
    return `object(keys=${Object.keys(output).length})`;
  }
  return typeof output;
}

function resolveExecutionOrder<TContext>(
  nodes: ExecutionGraphNodeDefinitionV0<TContext>[],
): string[] {
  const nodeById = new Map<string, ExecutionGraphNodeDefinitionV0<TContext>>();
  for (const node of nodes) {
    if (!node.id || !node.id.trim()) {
      throw new Error("execution graph v0: node id is required");
    }
    if (nodeById.has(node.id)) {
      throw new Error(`execution graph v0: duplicate node id '${node.id}'`);
    }
    nodeById.set(node.id, node);
  }

  for (const node of nodes) {
    for (const dep of node.deps ?? []) {
      if (!nodeById.has(dep)) {
        throw new Error(`execution graph v0: node '${node.id}' depends on unknown node '${dep}'`);
      }
      if (dep === node.id) {
        throw new Error(`execution graph v0: node '${node.id}' cannot depend on itself`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const indexById = new Map<string, number>();

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    indexById.set(node.id, i);
    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.deps ?? []) {
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      outgoing.get(dep)?.push(node.id);
    }
  }

  let queue = Array.from(inDegree.entries())
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)
    .toSorted((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));

  const order: string[] = [];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }
    order.push(next);
    for (const child of outgoing.get(next) ?? []) {
      const degree = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, degree);
      if (degree === 0) {
        queue.push(child);
      }
    }
    queue = queue.toSorted((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));
  }

  if (order.length !== nodes.length) {
    throw new Error("execution graph v0: cycle detected");
  }

  return order;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).toSorted();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringifyFallback(value)).digest("hex");
}

function stableStringifyFallback(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    return String(value);
  }
}

function formatErrorTrace(err: unknown, maxChars: number): string {
  const text =
    err instanceof Error
      ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}`
      : typeof err === "string"
        ? err
        : JSON.stringify(err);
  if (!text) {
    return "unknown error";
  }
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…`;
}
