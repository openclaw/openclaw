import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isSystemEventStoreCurrent } from "../../../infra/system-event-ownership.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeAgentIdStrict,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../tools/sessions-helpers.js";
import { resolveStoredSubagentCapabilities } from "../spawn/subagent-capabilities.js";
import type { SessionCapabilityLookup } from "../spawn/subagent-session-store.js";
import { matchesSubagentChildSessionOwner } from "./subagent-child-owner-match.js";
import { observeSubagentExecution } from "./subagent-execution-observation.js";
import { captureSubagentListReadContext, type SubagentListReadContext } from "./subagent-list.js";
import { getSubagentRunsForRequesterSession, subagentRuns } from "./subagent-registry-memory.js";
import {
  buildSubagentRunReadIndexFromRuns,
  listRunsForControllerFromRuns,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  listSubagentRunsForRequester,
} from "./subagent-registry-read.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentSessionListRunsSnapshotForRead,
  withSubagentRunReadSnapshot,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isRequesterSettleWakeForRun } from "./subagent-requester-settle-identity.js";
import {
  isSameSubagentRun,
  isSameSubagentRunOwner,
  latestSubagentRun,
} from "./subagent-run-generation.js";

export const DEFAULT_RECENT_MINUTES = 30;
export const MAX_RECENT_MINUTES = 24 * 60;

export type ResolvedSubagentController = {
  controllerSessionKey: string;
  controllerAgentId?: string;
  callerSessionKey: string;
  callerIsSubagent: boolean;
  controlScope: "children" | "none";
};

/** Resolve caller routing before preparing its persisted capability facts. */
export function resolveSubagentControllerIdentity(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
}): Omit<ResolvedSubagentController, "controlScope"> {
  const { alias } = resolveMainSessionAlias(params.cfg);
  const callerRaw = params.agentSessionKey?.trim() || alias;
  const callerSessionKey = resolveInternalSessionKey({ key: callerRaw, alias });
  const controllerAgentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: callerSessionKey,
    agentId: params.agentId,
  });
  return {
    controllerSessionKey: callerSessionKey,
    controllerAgentId,
    callerSessionKey,
    callerIsSubagent: isSubagentSessionKey(callerSessionKey),
  };
}

export function resolveSubagentController(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  agentId?: string;
  capabilityStore?: SessionCapabilityLookup;
}): ResolvedSubagentController {
  const identity = resolveSubagentControllerIdentity(params);
  if (!identity.callerIsSubagent) {
    return { ...identity, controlScope: "children" };
  }
  const capabilities = resolveStoredSubagentCapabilities(identity.callerSessionKey, {
    cfg: params.cfg,
    agentId: identity.controllerAgentId,
    store: params.capabilityStore,
  });
  return {
    ...identity,
    controlScope: capabilities.controlScope,
  };
}

export function listControlledSubagentRunsForTurn(
  controller: Pick<ResolvedSubagentController, "controllerSessionKey" | "controllerAgentId">,
  requesterTurnRunId?: string,
): SubagentRunRecord[] {
  // Cancellation owns only current resident runs; acquire their dispatch holds before yielding.
  const controlledRuns = listRunsForControllerFromRuns(
    subagentRuns,
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
      .filter((entry) =>
        isSameSubagentRun(
          getLatestLiveSubagentRunByChildSessionKey(
            entry.childSessionKey,
            undefined,
            entry.childAgentId,
          ),
          entry,
        ),
      )
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
  getExecutionObservation(entry: SubagentRunRecord): ReturnType<typeof observeSubagentExecution>;
};

function selectControlledSubagentRunFacts(
  index: SubagentRunReadIndex<SubagentRunReadRecord>,
  sessionKey: string,
  agentId: string,
  cfg?: OpenClawConfig,
): SubagentRunReadRecord[] {
  return [...index.runsByChildSessionKey.values()].flatMap((runs) =>
    runs.filter(
      (entry) =>
        isSubagentRunVisibleToSession(entry, sessionKey, agentId, cfg) &&
        (entry.childAgentId === undefined
          ? index.latestRunsByChildSessionKey.get(entry.childSessionKey.trim())
          : latestSubagentRun(runs, (candidate) =>
              matchesSubagentChildSessionOwner(
                candidate,
                entry.childSessionKey,
                entry.childAgentId,
              ),
            )) === entry,
    ),
  );
}

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
      inMemoryRuns: [...snapshot.keys()].flatMap((id) => subagentRuns.get(id) ?? []),
    });
    const visible = selectControlledSubagentRunFacts(index, key, agentId, cfg);
    return {
      index,
      runIds: visible.map((entry) => entry.runId),
      sessionKeys: visible
        .filter((entry) => entry.pauseReason === "sessions_yield")
        .map((entry) => entry.childSessionKey),
    };
  };
  return withSubagentRunReadSnapshot(
    subagentRuns,
    select,
    (selection, snapshot) => {
      const visibleIds = new Set(selection.runIds);
      const runs = [...snapshot.values()].filter((entry) => visibleIds.has(entry.runId));
      const list = captureSubagentListReadContext(runs, selection.index, snapshot, recentMinutes);
      return {
        runs: list.view.latest,
        list,
        getExecutionObservation: (entry: SubagentRunRecord) =>
          observeSubagentExecution(
            entry,
            getSubagentRunsForRequesterSession(entry.childSessionKey),
          ),
      };
    },
    { sessionKeys: [key], descendants: true },
  );
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
  return selectControlledSubagentRunFacts(index, controllerSessionKey, controllerAgentId, cfg);
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
  const key = childSessionKey.trim();
  // Qualified keys own their namespace; legacy raw rows retain requester-agent separation.
  const owner =
    agentId === undefined || parseAgentSessionKey(key)
      ? undefined
      : normalizeAgentIdStrict(agentId);
  return (
    getLatestLiveSubagentRunByChildSessionKey(
      key,
      owner === undefined
        ? undefined
        : (candidate) =>
            owner.ok &&
            matchesSubagentChildSessionOwner(candidate, key, owner.value) &&
            (candidate.childAgentId !== undefined ||
              resolveRunRequesterAgentId(candidate, cfg) === owner.value),
    ) ?? undefined
  );
}

export function isCurrentSubagentRun(entry: SubagentRunRecord, cfg: OpenClawConfig): boolean {
  return isSameSubagentRunOwner(
    getLatestOwnedSubagentRun(
      entry.childSessionKey,
      entry.childAgentId ?? resolveRunRequesterAgentId(entry, cfg),
      cfg,
    ),
    entry,
  );
}
