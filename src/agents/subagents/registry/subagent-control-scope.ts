/** Controller identity, authorization, and controlled-run read scope. */
import type { TaskSummary } from "../../../../packages/gateway-protocol/src/schema/tasks.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { readTaskBackingInstance } from "../../../tasks/task-backing-records.js";
import { getTaskExecutionObservation } from "../../../tasks/task-execution-observation.js";
import { findTaskByRunId } from "../../../tasks/task-registry-query.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import { observeSubagentExecution } from "./subagent-execution-observation.js";
import { captureSubagentListReadContext, type SubagentListReadContext } from "./subagent-list.js";
import { getSubagentRunsForRequesterSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  buildSubagentRunReadIndexFromRuns,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  listSubagentRunsForController,
  listSubagentRunsForRequester,
} from "./subagent-registry-read.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentSessionListRunsSnapshotForRead,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRequesterSettleWakeForRun } from "./subagent-requester-settle-identity.js";

/** Recent-run default window used by subagent control UI/tools. */
export const DEFAULT_RECENT_MINUTES = 30;
/** Maximum recent-run window accepted by subagent control UI/tools. */
export const MAX_RECENT_MINUTES = 24 * 60;

/** Controller identity and capability scope resolved from the caller session. */
export type ResolvedSubagentController = {
  controllerSessionKey: string;
  controllerAgentId?: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};

/** Resolves which subagent runs the caller is allowed to control. */
export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
}): ResolvedSubagentController {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({
    key: callerRaw,
    alias,
    mainKey,
  });
  const controllerAgentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: callerSessionKey,
    agentId: params.agentId,
  });
  if (!isSubagentSessionKey(callerSessionKey)) {
    return {
      controllerSessionKey: callerSessionKey,
      controllerAgentId,
      callerSessionKey,
      callerIsSubagent: false,
      controlScope: "children",
    };
  }
  const capabilities = resolveStoredSubagentCapabilities(callerSessionKey, {
    cfg: params.cfg,
    agentId: controllerAgentId,
  });
  return {
    controllerSessionKey: callerSessionKey,
    controllerAgentId,
    callerSessionKey,
    callerIsSubagent: true,
    controlScope: capabilities.controlScope,
  };
}

export function listControlledSubagentRunsForTurn(
  controller: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">,
  requesterTurnRunId?: string,
): SubagentRunRecord[] {
  const controlledRuns = listSubagentRunsForController(
    controller.controllerSessionKey,
    controller.controllerAgentId,
  );
  if (requesterTurnRunId === undefined) {
    return controlledRuns;
  }
  const requesterRuns = listSubagentRunsForRequester(controller.controllerSessionKey, {
    requesterAgentId: controller.controllerAgentId,
  });
  const runsById = new Map(
    requesterRuns
      .filter((entry) => getLatestLiveSubagentRunByChildSessionKey(entry.childSessionKey) === entry)
      .map((entry) => [entry.runId, entry]),
  );
  return controlledRuns.filter(
    (entry) =>
      entry.requesterTurnRunId === requesterTurnRunId ||
      isRequesterSettleWakeForRun({
        entry,
        runId: requesterTurnRunId,
        requesterSessionKey: controller.controllerSessionKey,
        requesterAgentId: controller.controllerAgentId,
        runsById,
      }),
  );
}

function resolveRunRequesterAgentId(
  entry: Pick<SubagentRunReadRecord, "requesterSessionKey" | "requesterAgentId">,
  cfg?: OpenClawConfig,
): string | undefined {
  if (entry.requesterAgentId) {
    return entry.requesterAgentId;
  }
  const parsed = parseAgentSessionKey(entry.requesterSessionKey)?.agentId;
  if (parsed || !cfg) {
    return parsed;
  }
  return resolveSubagentRequesterAgentId(cfg, entry);
}

export function isSubagentRunVisibleToSession(
  entry: SubagentRunReadRecord,
  sessionKey: string,
  agentId: string,
  cfg?: OpenClawConfig,
): boolean {
  const controllerKey = entry.controllerSessionKey?.trim();
  const requesterKey = entry.requesterSessionKey.trim();
  // Completion routing can target a different session than control ownership.
  // Both owners may read the run, while ensureControllerOwnsRun still gates mutations.
  const requesterAgentId = resolveRunRequesterAgentId(entry, cfg);
  const controllerAgentId =
    (controllerKey ? parseAgentSessionKey(controllerKey)?.agentId : undefined) ?? requesterAgentId;
  const normalizedAgentId = normalizeAgentId(agentId);
  return (
    (controllerKey === sessionKey && controllerAgentId === normalizedAgentId) ||
    (requesterKey === sessionKey && requesterAgentId === normalizedAgentId)
  );
}

export type ControlledSubagentRunsReadContext = {
  runs: SubagentRunRecord[];
  list: SubagentListReadContext;
  getExecutionObservation(entry: SubagentRunRecord): NonNullable<TaskSummary["execution"]>;
};

/** Builds one stable snapshot for controlled-run listing and descendant status reads. */
export async function buildControlledSubagentRunsReadContext(
  controllerSessionKey: string,
  controllerAgentId?: string,
  cfg?: OpenClawConfig,
  recentMinutes = DEFAULT_RECENT_MINUTES,
): Promise<ControlledSubagentRunsReadContext> {
  const key = controllerSessionKey.trim();
  const agentId = controllerAgentId ?? parseAgentSessionKey(key)?.agentId;
  if (!key || !agentId) {
    return {
      runs: [],
      list: captureSubagentListReadContext(
        [],
        buildSubagentRunReadIndexFromRuns({ runs: new Map() }),
        new Map(),
        recentMinutes,
      ),
      getExecutionObservation: () => ({ state: "unknown" }),
    };
  }

  const select = (snapshot: Map<string, SubagentRunReadRecord>) => {
    const index = buildSubagentRunReadIndexFromRuns({
      runs: snapshot,
      inMemoryRuns: subagentRuns.values(),
    });
    const visible = [...index.latestRunsByChildSessionKey.values()].filter((entry) =>
      isSubagentRunVisibleToSession(entry, key, agentId, cfg),
    );
    return {
      index,
      runIds: visible.map((entry) => entry.runId),
      sessionKeys: visible
        .filter((entry) => entry.pauseReason === "sessions_yield")
        .map((entry) => entry.childSessionKey),
    };
  };
  return withSubagentRunReadSnapshot(subagentRuns, select, (selection, snapshot) =>
    buildControlledReadContext(
      snapshot,
      selection.index,
      new Set(selection.runIds),
      cfg,
      recentMinutes,
    ),
  );
}

function buildControlledReadContext(
  snapshot: ReadonlyMap<string, SubagentRunRecord>,
  readIndex: SubagentRunReadIndex<SubagentRunReadRecord>,
  visibleIds: ReadonlySet<string>,
  cfg?: OpenClawConfig,
  recentMinutes = DEFAULT_RECENT_MINUTES,
): ControlledSubagentRunsReadContext {
  const runs = [...snapshot.values()].filter((entry) => visibleIds.has(entry.runId));
  const list = captureSubagentListReadContext(runs, readIndex, snapshot, recentMinutes);
  return {
    runs: list.view.latest,
    list,
    getExecutionObservation: (entry) => {
      const taskRunId = entry.taskRunId ?? entry.runId;
      const task = findTaskByRunId(taskRunId);
      const backing = readTaskBackingInstance(task?.detail);
      const requesterAgentId = resolveRunRequesterAgentId(entry, cfg);
      // Child sessions and logical tasks survive successor runs; only the selected
      // backing generation may contribute activity to this snapshot's detail row.
      if (
        task?.runtime === "subagent" &&
        task.runId === taskRunId &&
        task.childSessionKey === entry.childSessionKey &&
        task.requesterSessionKey === entry.requesterSessionKey &&
        requesterAgentId !== undefined &&
        task.requesterAgentId === requesterAgentId &&
        task.agentId ===
          (parseAgentSessionKey(entry.childSessionKey)?.agentId ?? requesterAgentId) &&
        backing?.runtime === "subagent" &&
        backing.generation === entry.generation
      ) {
        return getTaskExecutionObservation(task);
      }
      return observeSubagentExecution(
        entry,
        getSubagentRunsForRequesterSession(entry.childSessionKey),
      );
    },
  };
}

/** Cancellation consumes current ownership facts without hydrating retained result payloads. */
export function listControlledSubagentRunFacts(
  controllerSessionKey: string,
  controllerAgentId: string | undefined,
  cfg: OpenClawConfig,
): SubagentRunReadRecord[] {
  if (!controllerAgentId) {
    return [];
  }
  const index = buildSubagentRunReadIndexFromRuns({
    runs: getSubagentSessionListRunsSnapshotForRead(subagentRuns),
  });
  return [...index.latestRunsByChildSessionKey.values()].filter((entry) =>
    isSubagentRunVisibleToSession(entry, controllerSessionKey, controllerAgentId, cfg),
  );
}

export function ensureSubagentControllerOwnsRun(params: {
  cfg: OpenClawConfig;
  controller: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">;
  entry: SubagentRunReadRecord;
}) {
  const controllerKey = params.entry.controllerSessionKey?.trim();
  const owner = controllerKey || params.entry.requesterSessionKey;
  const ownerStorePath = controllerKey
    ? params.entry.controllerStorePath
    : params.entry.requesterStorePath;
  const ownerAgentId =
    parseAgentSessionKey(owner)?.agentId ?? resolveRunRequesterAgentId(params.entry, params.cfg);
  const controllerAgentId =
    params.controller.controllerAgentId ??
    parseAgentSessionKey(params.controller.controllerSessionKey)?.agentId;
  if (
    owner === params.controller.controllerSessionKey &&
    ownerAgentId === controllerAgentId &&
    // Retained v2026.9.5 tasks lack store provenance; preserve their control until retirement.
    (ownerStorePath === undefined || isSystemEventStoreCurrent(owner, ownerStorePath, ownerAgentId))
  ) {
    return undefined;
  }
  return "Subagents can only control runs spawned from their own session.";
}

export function getLatestOwnedSubagentRun(
  childSessionKey: string,
  agentId: string | undefined,
  cfg: OpenClawConfig,
): SubagentRunRecord | undefined {
  // Agent-scoped child keys already carry their sole owner; any newer generation fences
  // the old row. Bare per-agent keys need the explicit owner to avoid cross-agent shadowing.
  const ownerFilter = parseAgentSessionKey(childSessionKey) ? undefined : agentId;
  return (
    getLatestLiveSubagentRunByChildSessionKey(
      childSessionKey,
      ownerFilter
        ? (candidate) => resolveRunRequesterAgentId(candidate, cfg) === ownerFilter
        : undefined,
    ) ?? undefined
  );
}

export function isCurrentSubagentRun(entry: SubagentRunRecord, cfg?: OpenClawConfig): boolean {
  if (!cfg) {
    return getLatestLiveSubagentRunByChildSessionKey(entry.childSessionKey) === entry;
  }
  return (
    getLatestOwnedSubagentRun(
      entry.childSessionKey,
      resolveRunRequesterAgentId(entry, cfg),
      cfg,
    ) === entry
  );
}

export function isSameSubagentRunGeneration(
  live: SubagentRunRecord,
  snapshot: SubagentRunRecord,
): boolean {
  return (
    live.childSessionKey === snapshot.childSessionKey &&
    live.runId === snapshot.runId &&
    live.generation === snapshot.generation &&
    live.createdAt === snapshot.createdAt
  );
}
