import crypto from "node:crypto";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { resolveSpecialistTarget } from "../operator-control/specialist-resolver.js";
import {
  createWorkGraphState,
  isWorkGraphTerminal,
  listWorkGraphReadyNodeIds,
  markWorkGraphNodeFinished,
  markWorkGraphNodeStarted,
  markWorkGraphNodeTerminal,
  summarizeWorkGraph,
  type WorkGraphDependency,
  type WorkGraphDependencyType,
  type WorkGraphState,
} from "../operator-control/work-graph.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  ACP_SPAWN_MODES,
  ACP_SPAWN_STREAM_TARGETS,
  spawnAcpDirect,
  type SpawnAcpContext,
  type SpawnAcpMode,
} from "./acp-spawn.js";
import {
  SUBAGENT_SPAWN_MODES,
  spawnSubagentDirect,
  type SpawnSubagentContext,
  type SpawnSubagentMode,
} from "./subagent-spawn.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

export type SessionsScheduleRuntime = "subagent" | "acp";

export type SessionsScheduleNodeInput = {
  id: string;
  task: string;
  label?: string;
  runtime?: SessionsScheduleRuntime;
  agentId?: string;
  teamId?: string;
  capability?: string;
  role?: string;
  model?: string;
  thinking?: string;
  cwd?: string;
  runTimeoutSeconds?: number;
  timeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: "inherit" | "require";
  streamTo?: (typeof ACP_SPAWN_STREAM_TARGETS)[number];
};

export type SessionsScheduleDependencyInput = {
  from: string;
  to: string;
  type: WorkGraphDependencyType;
};

export type SessionsScheduleContext = SpawnSubagentContext &
  SpawnAcpContext & {
    sandboxed?: boolean;
  };

type ScheduledNodeRecord = {
  config: SessionsScheduleNodeInput;
  runtime: SessionsScheduleRuntime;
  resolvedAgentId?: string;
  resolvedTeamId?: string | null;
  resolvedCapability?: string | null;
  roleAliasUsed?: boolean;
  childSessionKey?: string;
  runId?: string;
  error?: string;
};

type ActiveSchedule = {
  scheduleId: string;
  requesterAgentId: string;
  context: SessionsScheduleContext;
  graph: WorkGraphState;
  nodes: Map<string, ScheduledNodeRecord>;
  activeByIdentityId: Map<string, number>;
  activeByTeamId: Map<string, number>;
  pumping: boolean;
};

export type SessionsScheduleResult = {
  status: "accepted";
  scheduleId: string;
  startedNodeIds: string[];
  summary: ReturnType<typeof summarizeWorkGraph>;
  nodes: Array<{
    id: string;
    runtime: SessionsScheduleRuntime;
    state: WorkGraphState["nodes"][string]["state"];
    resolvedAgentId?: string;
    resolvedTeamId?: string | null;
    resolvedCapability?: string | null;
    childSessionKey?: string;
    runId?: string;
    error?: string;
  }>;
  note: string;
};

const activeSchedules = new Map<string, ActiveSchedule>();

function resolveRequesterAgentId(ctx: SessionsScheduleContext): string {
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterInternalKey = ctx.agentSessionKey
    ? resolveInternalSessionKey({
        key: ctx.agentSessionKey,
        alias,
        mainKey,
      })
    : alias;
  return normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
}

function normalizeRuntime(node: SessionsScheduleNodeInput): SessionsScheduleRuntime {
  return node.runtime === "acp" ? "acp" : "subagent";
}

function normalizeDependencies(
  dependencies: SessionsScheduleDependencyInput[] | undefined,
): WorkGraphDependency[] {
  return (dependencies ?? []).map((dependency) => ({
    from: dependency.from,
    to: dependency.to,
    type: dependency.type,
  }));
}

function buildScheduleSnapshot(schedule: ActiveSchedule): SessionsScheduleResult {
  const summary = summarizeWorkGraph(schedule.graph);
  return {
    status: "accepted",
    scheduleId: schedule.scheduleId,
    startedNodeIds: Array.from(schedule.nodes.values())
      .filter((node) => Boolean(node.runId))
      .map((node) => node.config.id)
      .toSorted((left, right) => left.localeCompare(right)),
    summary,
    nodes: Array.from(schedule.nodes.values())
      .map((node) => ({
        id: node.config.id,
        runtime: node.runtime,
        state: schedule.graph.nodes[node.config.id]?.state ?? "pending",
        resolvedAgentId: node.resolvedAgentId,
        resolvedTeamId: node.resolvedTeamId,
        resolvedCapability: node.resolvedCapability,
        childSessionKey: node.childSessionKey,
        runId: node.runId,
        error: node.error,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    note: "Ready nodes start immediately. Dependent nodes will start automatically when their prerequisites settle.",
  };
}

function isCapacityError(message: string): boolean {
  return (
    message.includes("max parallel capacity") ||
    message.includes("max concurrent sessions") ||
    message.includes("no available specialists")
  );
}

function resolveWaitTimeoutMs(node: ScheduledNodeRecord): number {
  const timeoutSeconds = node.config.runTimeoutSeconds ?? node.config.timeoutSeconds;
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return Math.max(1_000, Math.floor(timeoutSeconds * 1000) + 60_000);
  }
  return 24 * 60 * 60 * 1000;
}

function increment(map: Map<string, number>, key: string | null | undefined, delta: number): void {
  if (!key) {
    return;
  }
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) {
    map.delete(key);
    return;
  }
  map.set(key, next);
}

async function waitForScheduledNodeCompletion(params: {
  scheduleId: string;
  nodeId: string;
  runId: string;
}): Promise<void> {
  const schedule = activeSchedules.get(params.scheduleId);
  const node = schedule?.nodes.get(params.nodeId);
  if (!schedule || !node) {
    return;
  }

  try {
    const wait = await callGateway<{
      status?: "ok" | "error" | "timeout";
      error?: string;
      endedAt?: number;
    }>({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs: resolveWaitTimeoutMs(node),
      },
      timeoutMs: resolveWaitTimeoutMs(node) + 10_000,
    });

    const current = activeSchedules.get(params.scheduleId);
    const currentNode = current?.nodes.get(params.nodeId);
    if (!current || !currentNode) {
      return;
    }

    increment(current.activeByIdentityId, currentNode.resolvedAgentId, -1);
    increment(current.activeByTeamId, currentNode.resolvedTeamId, -1);

    if (wait?.status === "error") {
      currentNode.error = wait.error ?? "scheduled node failed";
      current.graph = markWorkGraphNodeFinished({
        state: current.graph,
        nodeId: params.nodeId,
        outcome: "failed",
        endedAt: wait.endedAt,
        failureReason: currentNode.error,
      });
    } else if (wait?.status === "timeout") {
      currentNode.error = "scheduled node timed out";
      current.graph = markWorkGraphNodeFinished({
        state: current.graph,
        nodeId: params.nodeId,
        outcome: "failed",
        endedAt: wait.endedAt,
        failureReason: currentNode.error,
      });
    } else {
      current.graph = markWorkGraphNodeFinished({
        state: current.graph,
        nodeId: params.nodeId,
        outcome: "completed",
        endedAt: wait?.endedAt,
      });
    }
  } catch (error) {
    const current = activeSchedules.get(params.scheduleId);
    const currentNode = current?.nodes.get(params.nodeId);
    if (!current || !currentNode) {
      return;
    }
    increment(current.activeByIdentityId, currentNode.resolvedAgentId, -1);
    increment(current.activeByTeamId, currentNode.resolvedTeamId, -1);
    currentNode.error = error instanceof Error ? error.message : String(error);
    current.graph = markWorkGraphNodeFinished({
      state: current.graph,
      nodeId: params.nodeId,
      outcome: "failed",
      failureReason: currentNode.error,
    });
  } finally {
    void pumpSchedule(params.scheduleId);
  }
}

async function spawnScheduledNode(params: {
  schedule: ActiveSchedule;
  nodeId: string;
}): Promise<"started" | "deferred" | "failed"> {
  const node = params.schedule.nodes.get(params.nodeId);
  if (!node) {
    return "failed";
  }

  let resolvedAgentId = node.config.agentId?.trim() || "";
  let resolvedTeamId: string | null = null;
  let resolvedCapability: string | null = null;
  let roleAliasUsed = false;

  if (!resolvedAgentId) {
    try {
      const resolved = resolveSpecialistTarget({
        requesterId: params.schedule.requesterAgentId,
        teamId: node.config.teamId,
        capability: node.config.capability,
        role: node.config.role,
        runtimePreference: node.runtime,
        activeSessionsByIdentityId: params.schedule.activeByIdentityId,
        activeSessionsByTeamId: params.schedule.activeByTeamId,
      });
      resolvedAgentId = resolved.identityId;
      resolvedTeamId = resolved.teamId;
      resolvedCapability = resolved.capability;
      roleAliasUsed = resolved.roleAliasUsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCapacityError(message)) {
        return "deferred";
      }
      node.error = message;
      params.schedule.graph = markWorkGraphNodeTerminal({
        state: params.schedule.graph,
        nodeId: params.nodeId,
        outcome: "failed",
        failureReason: message,
      });
      return "failed";
    }
  }

  try {
    const result =
      node.runtime === "acp"
        ? await spawnAcpDirect(
            {
              task: node.config.task,
              label: node.config.label,
              agentId: resolvedAgentId,
              cwd: node.config.cwd,
              thread: node.config.thread,
              mode:
                typeof node.config.mode === "string" && ACP_SPAWN_MODES.includes(node.config.mode)
                  ? node.config.mode
                  : undefined,
              sandbox: node.config.sandbox,
              streamTo: node.config.streamTo,
            },
            params.schedule.context,
          )
        : await spawnSubagentDirect(
            {
              task: node.config.task,
              label: node.config.label,
              agentId: resolvedAgentId,
              model: node.config.model,
              thinking: node.config.thinking,
              runTimeoutSeconds: node.config.runTimeoutSeconds ?? node.config.timeoutSeconds,
              thread: node.config.thread,
              mode:
                typeof node.config.mode === "string" &&
                SUBAGENT_SPAWN_MODES.includes(node.config.mode)
                  ? node.config.mode
                  : undefined,
              cleanup: node.config.cleanup,
              sandbox: node.config.sandbox,
            },
            params.schedule.context,
          );

    if (result.status !== "accepted" || !result.runId) {
      node.error = result.error ?? "scheduled node failed to start";
      params.schedule.graph = markWorkGraphNodeTerminal({
        state: params.schedule.graph,
        nodeId: params.nodeId,
        outcome: "failed",
        failureReason: node.error,
      });
      return "failed";
    }

    node.resolvedAgentId = resolvedAgentId;
    node.resolvedTeamId = resolvedTeamId;
    node.resolvedCapability = resolvedCapability;
    node.roleAliasUsed = roleAliasUsed;
    node.childSessionKey = result.childSessionKey;
    node.runId = result.runId;
    params.schedule.graph = markWorkGraphNodeStarted(params.schedule.graph, params.nodeId);
    increment(params.schedule.activeByIdentityId, resolvedAgentId, 1);
    increment(params.schedule.activeByTeamId, resolvedTeamId, 1);
    void waitForScheduledNodeCompletion({
      scheduleId: params.schedule.scheduleId,
      nodeId: params.nodeId,
      runId: result.runId,
    });
    return "started";
  } catch (error) {
    node.error = error instanceof Error ? error.message : String(error);
    params.schedule.graph = markWorkGraphNodeTerminal({
      state: params.schedule.graph,
      nodeId: params.nodeId,
      outcome: "failed",
      failureReason: node.error,
    });
    return "failed";
  }
}

async function pumpSchedule(scheduleId: string): Promise<void> {
  const schedule = activeSchedules.get(scheduleId);
  if (!schedule || schedule.pumping) {
    return;
  }

  schedule.pumping = true;
  try {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const readyNodeIds = listWorkGraphReadyNodeIds(schedule.graph);
      if (readyNodeIds.length === 0) {
        break;
      }

      for (const nodeId of readyNodeIds) {
        const runningCount = Object.values(schedule.graph.nodes).filter(
          (node) => node.state === "running",
        ).length;
        if (schedule.graph.maxParallel && runningCount >= schedule.graph.maxParallel) {
          break;
        }
        const outcome = await spawnScheduledNode({
          schedule,
          nodeId,
        });
        if (outcome === "started" || outcome === "failed") {
          progressed = true;
        }
      }
    }
  } finally {
    schedule.pumping = false;
    if (isWorkGraphTerminal(schedule.graph)) {
      activeSchedules.delete(scheduleId);
    }
  }
}

export async function scheduleSessionsGraph(params: {
  nodes: SessionsScheduleNodeInput[];
  dependencies?: SessionsScheduleDependencyInput[];
  maxParallel?: number;
  context: SessionsScheduleContext;
}): Promise<SessionsScheduleResult> {
  const requesterAgentId = resolveRequesterAgentId(params.context);
  const scheduleId = `schedule:${crypto.randomUUID()}`;
  const graph = createWorkGraphState({
    nodeIds: params.nodes.map((node) => node.id),
    dependencies: normalizeDependencies(params.dependencies),
    maxParallel: params.maxParallel,
  });

  const schedule: ActiveSchedule = {
    scheduleId,
    requesterAgentId,
    context: params.context,
    graph,
    nodes: new Map(
      params.nodes.map((node) => [
        node.id,
        {
          config: node,
          runtime: normalizeRuntime(node),
        },
      ]),
    ),
    activeByIdentityId: new Map<string, number>(),
    activeByTeamId: new Map<string, number>(),
    pumping: false,
  };
  activeSchedules.set(scheduleId, schedule);
  await pumpSchedule(scheduleId);
  const current = activeSchedules.get(scheduleId) ?? schedule;
  return buildScheduleSnapshot(current);
}

export function resetSessionsScheduleStateForTests(): void {
  activeSchedules.clear();
}
