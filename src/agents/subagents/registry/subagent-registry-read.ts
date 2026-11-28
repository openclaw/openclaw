import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import { preparePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { listLiveAgentRunIds } from "../../../infra/agent-run-registry.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { listSwarmRunReservationIds } from "../swarm/swarm-scheduler.js";
import {
  matchesSubagentChildSessionIdentity,
  resolveRecordedRequester,
  resolveSubagentChildAgentId,
} from "./subagent-child-owner-match.js";
import {
  getRecordedSubagentChildAuthority,
  getSubagentActivationRuns,
  getSubagentChildSessionCandidates,
  getSubagentRunsForChildSession,
  getSubagentRunsForRequesterSession,
  getSubagentSessionReadLookup,
  subagentRuns,
} from "./subagent-registry-memory.js";
import {
  buildLatestSubagentRunReadIndexFromRuns,
  getLatestSubagentRunForChild,
  getSubagentRunByChildSessionKeyFromRuns,
  listRunsForControllerFromRuns,
  listRunsForRequesterFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
  type LatestSubagentRunReadIndex,
  type SubagentRunReadIndex,
} from "./subagent-registry-queries.js";
import { captureSubagentSessionListReadIndex } from "./subagent-registry-read-index.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import {
  getSubagentSessionListRunsSnapshotForChildSessions,
  getSubagentRunsSnapshotForChildSession,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentSessionListRunsSnapshotForSessions,
  prepareSubagentSessionListReadCache,
} from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { owesRequesterCompletion } from "./subagent-requester-settle-identity.js";
import { compareSubagentRunGeneration, latestSubagentRun } from "./subagent-run-generation.js";
import {
  isSubagentRunLive,
  isSubagentRunQueued,
  isYieldedSubagentRun,
} from "./subagent-run-liveness.js";
export { isSubagentRunLive, isSubagentRunQueued } from "./subagent-run-liveness.js";

export type { SubagentRunReadIndex } from "./subagent-registry-queries.js";
export type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentRootRequester = {
  sessionKey: string;
  agentId?: string;
  storePath?: string;
};

/** A logical session key may exist in more than one physical store. */
export function restartSessionOwnerKey(owner: Required<SubagentRootRequester>): string {
  return JSON.stringify([owner.agentId, owner.storePath, owner.sessionKey]);
}

/** Follow delegated ancestry until the exact owner of an independent turn. */
export async function resolveRootSubagentRequester(
  start: Required<SubagentRootRequester>,
  cfg: OpenClawConfig,
  chatRoots: ReadonlySet<string>,
): Promise<Required<SubagentRootRequester>> {
  let root = start;
  const visited = new Set<string>();
  for (;;) {
    const identity = restartSessionOwnerKey(root);
    if (visited.has(identity) || chatRoots.has(identity)) {
      return root;
    }
    visited.add(identity);
    const entry = latestSubagentRun(getSubagentRunsForChildSession(root.sessionKey, root.agentId));
    if (!entry) {
      return root;
    }
    const authority = getRecordedSubagentChildAuthority(entry);
    if (authority.status === "mismatch") {
      return root;
    }
    const session = await readSessionEntryReadOnlyInWorker({
      ...root,
      projection: "list",
    });
    if (!matchesSubagentChildSessionIdentity(entry, session ?? null)) {
      return root;
    }
    // sessions_send also registers requester edges, but does not create a child.
    const spawnedBy = normalizeOptionalString(session?.spawnedBy);
    if (!spawnedBy && session?.createdVia !== "spawn") {
      return root;
    }
    const parent =
      spawnedBy ??
      normalizeOptionalString(session?.parentSessionKey) ??
      entry.controllerSessionKey ??
      entry.requesterSessionKey;
    const parentAgentId =
      parent === entry.requesterSessionKey
        ? resolveRecordedRequester(entry)
        : resolveSubagentChildAgentId({ childSessionKey: parent });
    if (!parentAgentId) {
      return root;
    }
    const requester = {
      sessionKey: parent,
      agentId: parentAgentId,
      storePath:
        parent === entry.requesterSessionKey
          ? entry.requesterStorePath
          : parent === entry.controllerSessionKey
            ? entry.controllerStorePath
            : undefined,
    };
    root = { ...requester, storePath: await preparePhysicalSessionStorePath(requester, cfg) };
  }
}

/** Snapshot live delegated inputs; restart selection resolves their ancestry. */
export function* listLiveSubagentSessions(): Generator<
  SubagentRootRequester & { sessionId?: string }
> {
  for (const runId of listLiveAgentRunIds()) {
    const entry = subagentRuns.get(runId);
    if (entry && isSubagentRunLive(entry)) {
      yield {
        sessionKey: entry.childSessionKey,
        agentId: entry.childAgentId,
        sessionId: entry.childSessionIdentity?.sessionId,
      };
    }
  }
}

function isWaitingSubagentRun(entry: SubagentRunRecord): boolean {
  return !entry.collect && isYieldedSubagentRun(entry);
}

type YieldWaitSource = "waiting" | "resume" | undefined;

function resolveYieldWaitingChild(
  sessionKey: string,
  agentId: string,
  runId: string,
  visited: Set<string>,
): YieldWaitSource {
  let source: YieldWaitSource;
  for (const child of getSubagentRunsForRequesterSession(sessionKey)) {
    if (
      resolveRecordedRequester(child) !== agentId ||
      child.requesterSettleWake?.requesterYieldBatch !== true ||
      (child.requesterSettleWake.requesterRunId &&
        child.requesterSettleWake.requesterRunId !== runId)
    ) {
      continue;
    }
    const childSource = subagentRuns.isCompletionAuthorityRetired(child)
      ? "resume"
      : isYieldedSubagentRun(child)
        ? owesRequesterCompletion(child)
          ? resolveSubagentYieldWaitSource(child, visited)
          : undefined
        : owesRequesterCompletion(child) &&
            (isSubagentRunLive(child) || child.execution.status === "terminal")
          ? "waiting"
          : "resume";
    // Stopped descendants need root reconciliation, even beside a surviving wait.
    if (childSource === "resume") {
      return childSource;
    }
    source ??= childSource;
  }
  return source;
}

/** Distinguish a reachable wake from stopped descendants needing requester recovery. */
export function resolveSubagentYieldWaitSource(
  entry: SubagentRunRecord,
  visited = new Set<string>(),
): YieldWaitSource {
  if (!isWaitingSubagentRun(entry) || visited.has(entry.runId)) {
    return undefined;
  }
  visited.add(entry.runId);
  if (entry.waitForMessage) {
    return "waiting";
  }
  const authority = getRecordedSubagentChildAuthority(entry);
  return authority.status === "verified"
    ? resolveYieldWaitingChild(entry.childSessionKey, authority.childAgentId, entry.runId, visited)
    : undefined;
}

/** Yield owners retain their task across restart, without retaining an execution. */
export function* listYieldWaitingSessions() {
  for (const entry of getSubagentActivationRuns(subagentRuns)) {
    if (isWaitingSubagentRun(entry)) {
      yield {
        sessionKey: entry.childSessionKey,
        agentId: entry.childAgentId,
        sessionId: entry.childSessionIdentity?.sessionId,
        parked: true,
      };
    }
    if (entry.requesterSettleWake?.requesterYieldBatch) {
      yield {
        sessionKey: entry.requesterSessionKey,
        agentId: resolveRecordedRequester(entry),
        storePath: entry.requesterStorePath,
        sessionId: entry.completionRequesterSessionId,
        parked: true,
      };
    }
  }
}

export function resolveSessionYieldWait(
  sessionKey: string,
  session: Pick<
    InternalSessionEntry,
    | "sessionId"
    | "lifecycleRevision"
    | "lifecycleRunId"
    | "lastRunId"
    | "activeWriterRunId"
    | "archivedAt"
    | "incognito"
    | "status"
    | "endedAt"
    | "pendingFinalDelivery"
  >,
  agentId: string,
): YieldWaitSource | "unreachable" {
  if (session.archivedAt !== undefined || session.incognito) {
    return undefined;
  }
  const interruptedRunId = session.lifecycleRunId ?? session.lastRunId;
  if (interruptedRunId?.startsWith("announce:requester-settle:")) {
    for (const child of getSubagentRunsForRequesterSession(sessionKey)) {
      if (
        !subagentRuns.isCompletionAuthorityRetired(child) &&
        resolveRecordedRequester(child) === agentId &&
        child.requesterSettleWake !== undefined
      ) {
        // The registry owns this continuation even if recovery changed its cohort or retry ID.
        return "waiting";
      }
    }
  }
  const ownWait = getLatestLiveSubagentRunByChildSessionKey(
    sessionKey,
    (run) =>
      run.runId === session.lifecycleRunId &&
      (!session.activeWriterRunId || session.activeWriterRunId === run.runId) &&
      isWaitingSubagentRun(run) &&
      matchesSubagentChildSessionIdentity(run, session),
    agentId,
  );
  if (ownWait) {
    // Its requester owns reconciliation; paused children are never independently replayed.
    return resolveSubagentYieldWaitSource(ownWait) ? "waiting" : "unreachable";
  }
  // The lifecycle owner records only a yield as an ended execution without a
  // terminal status. A running or replaced turn must not inherit an older wait.
  if (
    !session.lifecycleRunId ||
    session.status !== undefined ||
    !Number.isFinite(session.endedAt) ||
    session.pendingFinalDelivery ||
    (session.activeWriterRunId && session.activeWriterRunId !== session.lifecycleRunId)
  ) {
    return undefined;
  }
  const source = resolveYieldWaitingChild(sessionKey, agentId, session.lifecycleRunId, new Set());
  if (source) {
    return source;
  }
  // A child whose continuation was lost still owes its requester a registry
  // settlement. That completion, not a second root recovery input, owns the wake.
  for (const child of getSubagentRunsForRequesterSession(sessionKey)) {
    if (
      resolveRecordedRequester(child) === agentId &&
      (child.requesterSettleWake ||
        (owesRequesterCompletion(child) &&
          (child.execution.status !== "terminal" ||
            isYieldedSubagentRun(child) ||
            child.delivery?.status === "pending" ||
            child.delivery?.status === "in_progress")))
    ) {
      return "waiting";
    }
  }
  return "unreachable";
}

/** Resolve live owners through the existing aliases without scanning retained history. */
export function listActiveSubagentSessionKeys(): string[] {
  const runIds = new Set([...listLiveAgentRunIds(), ...listSwarmRunReservationIds()]);
  const sessionKeys = new Set<string>();
  for (const runId of getSubagentSessionReadLookup(subagentRuns).selectRunIds(runIds)) {
    const entry = subagentRuns.get(runId);
    if (entry && (isSubagentRunLive(entry) || isSubagentRunQueued(entry))) {
      sessionKeys.add(entry.childSessionKey);
    }
  }
  return [...sessionKeys];
}

/** Builds the session-list index without hydrating full retained registry payloads. */
export function buildSubagentSessionListReadIndex(
  now = Date.now(),
  sessionKeys?: readonly string[],
  preparedRuns?: Map<string, SubagentRunReadRecord>,
): SubagentRunReadIndex<SubagentRunReadRecord> {
  const runs =
    preparedRuns ??
    (sessionKeys
      ? getSubagentSessionListRunsSnapshotForSessions(subagentRuns, sessionKeys)
      : getSubagentSessionListRunsSnapshotForRead(subagentRuns));
  return captureSubagentSessionListReadIndex(
    runs,
    now,
    sessionKeys ? undefined : subagentRuns.values(),
  );
}

/** Direct-child discovery needs only its controllers, without building global topology. */
export function listSubagentSessionListRunsForControllers(
  controllerSessionKeys: readonly string[],
): SubagentRunReadRecord[] {
  const runs = getSubagentSessionListRunsSnapshotForRead(subagentRuns, controllerSessionKeys);
  return controllerSessionKeys.flatMap((key) => listRunsForControllerFromRuns(runs, key));
}

export function buildLatestSubagentSessionListReadIndex(
  childSessionKeys: readonly string[],
): LatestSubagentRunReadIndex<SubagentRunReadRecord> {
  return buildLatestSubagentRunReadIndexFromRuns(
    getSubagentSessionListRunsSnapshotForChildSessions(childSessionKeys),
  );
}

/** Capacity reads retain active-first selection without hydrating child payloads. */
export function getSubagentSessionListRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunReadRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    getSubagentSessionListRunsSnapshotForChildSessions([childSessionKey]),
    childSessionKey,
    undefined,
    subagentRuns,
  );
}

export async function countPendingDescendantRuns(
  rootSessionKey: string,
  assertCurrent: () => void,
  options?: { excludeSettledDelivery?: boolean },
): Promise<number> {
  assertCurrent();
  await prepareSubagentSessionListReadCache();
  assertCurrent();
  return buildSubagentSessionListReadIndex(Date.now(), [rootSessionKey]).countPendingDescendantRuns(
    rootSessionKey,
    options,
  );
}

export async function resolveRequesterForChildSession(
  childSessionKey: string,
  childAgentId?: string,
): Promise<{
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterOrigin?: DeliveryContext;
} | null> {
  const resolved = getLatestSubagentRunForChild(
    await getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
    { childSessionKey, childAgentId },
  );
  if (!resolved) {
    return null;
  }
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterAgentId: resolved.requesterAgentId,
    requesterOrigin: normalizeDeliveryContext(resolved.requesterOrigin),
  };
}

export async function shouldIgnorePostCompletionAnnounceForSession(
  childSessionKey: string,
  childAgentId?: string,
): Promise<boolean> {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    await getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
    childSessionKey,
    childAgentId,
  );
}

/** True when the process-local registry still owns an active run for the child session. */
export function isSubagentSessionRunActive(
  childSessionKey: string,
  childAgentId?: string,
): boolean {
  // Liveness is mutation ownership, so a persisted snapshot must not outvote the raw live map.
  return isSubagentRunLive(
    getLatestLiveSubagentRunByChildSessionKey(childSessionKey, undefined, childAgentId),
  );
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: Parameters<typeof listRunsForRequesterFromRuns>[2],
): SubagentRunRecord[] {
  // Request-run lifetime scoping must observe the raw live map, including rows not persisted yet.
  const lookup = getSubagentSessionReadLookup(subagentRuns);
  return listRunsForRequesterFromRuns(
    subagentRuns,
    requesterSessionKey,
    options,
    lookup
      .selectReadScope([requesterSessionKey], lookup, false)
      .map((runId) => subagentRuns.get(runId)!),
  );
}

export async function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
  childAgentId?: string,
): Promise<SubagentRunRecord | null> {
  return (
    getLatestSubagentRunForChild(
      await getSubagentRunsSnapshotForChildSession(subagentRuns, childSessionKey, childAgentId),
      { childSessionKey, childAgentId },
    ) ?? null
  );
}

/**
 * Returns the authoritative process-local run for mutation ownership checks.
 *
 * `matches` restricts the search to a row class the caller owns; see
 * `getLatestSubagentRunByChildSessionKeyFromRuns`.
 */
export function getLatestLiveSubagentRunByChildSessionKey(
  childSessionKey: string,
  matches?: (entry: SubagentRunRecord) => boolean,
  childAgentId?: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  // The live index owns child/agent matching; retained snapshots cannot confer custody.
  return latestSubagentRun(getSubagentRunsForChildSession(key, childAgentId), matches) ?? null;
}

const qualifiedChildKey = /^agent:/i;

/** Read registry-owned buckets directly; executor and reservation authority stays live. */
export function getSubagentChildControllerSessionKey(
  childSessionKey: string,
  session: { sessionId?: string; lifecycleRevision?: string },
): string | undefined {
  const key = childSessionKey.trim();
  if (!qualifiedChildKey.test(key)) {
    return undefined;
  }
  const candidates = getSubagentChildSessionCandidates(key);
  let latest: SubagentRunRecord | undefined;
  let index = 0;
  while (index < candidates.length) {
    const candidate = candidates[index++]!;
    if (
      (isSubagentRunLive(candidate) || isSubagentRunQueued(candidate)) &&
      getRecordedSubagentChildAuthority(candidate).status !== "mismatch" &&
      matchesSubagentChildSessionIdentity(candidate, session) &&
      (!latest || compareSubagentRunGeneration(candidate, latest) > 0)
    ) {
      latest = candidate;
    }
  }
  return (
    normalizeOptionalString(latest?.controllerSessionKey) ??
    normalizeOptionalString(latest?.requesterSessionKey)
  );
}
