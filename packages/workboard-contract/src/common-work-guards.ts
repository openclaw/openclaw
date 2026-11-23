import {
  advanceCommonWorkRevision,
  CommonWorkAuthorityError,
  CommonWorkConflictError,
  type CommonWorkLane,
  type CommonWorkRecord,
  type CommonWorkRoute,
} from "./common-work.js";

export type CommonWorkQueueItem = { workId: string; lane: CommonWorkLane; admittedAt: number };
export function assignCommonWorkSlots(
  pending: readonly CommonWorkQueueItem[],
  active: readonly CommonWorkQueueItem[],
  capacity = 3,
): CommonWorkQueueItem[] {
  if (new Set(active.map((item) => item.workId)).size !== active.length) {
    throw new CommonWorkConflictError("active work must be unique");
  }
  if (active.length > capacity) {
    throw new CommonWorkConflictError("active work exceeds capacity");
  }
  const ordered = pending
    .filter((item) => !active.some((current) => current.workId === item.workId))
    .toSorted((a, b) => a.admittedAt - b.admittedAt || a.workId.localeCompare(b.workId));
  const queued = ordered.filter(
    (item, index) => ordered.findIndex((candidate) => candidate.workId === item.workId) === index,
  );
  const assignments: CommonWorkQueueItem[] = [];
  const take = (predicate: (item: CommonWorkQueueItem) => boolean) => {
    const index = queued.findIndex(predicate);
    const selected = queued[index];
    if (selected) {
      queued.splice(index, 1);
      assignments.push(selected);
    }
  };
  const slots = capacity - active.length;
  const combined = () => [...active, ...assignments];
  if (
    slots > 0 &&
    queued.some((item) => item.lane === "common") &&
    !combined().some((item) => item.lane === "common")
  ) {
    take((item) => item.lane === "common");
  }
  if (
    assignments.length < slots &&
    queued.some((item) => item.lane !== "common") &&
    !combined().some((item) => item.lane !== "common")
  ) {
    take((item) => item.lane !== "common");
  }
  while (assignments.length < slots && queued.length > 0) {
    assignments.push(queued.shift()!);
  }
  return assignments;
}

export type ManagedPublishPlan = {
  prior: string;
  next: string;
  priorDigest: string;
  nextDigest: string;
  marker: string;
};
export function prepareManagedPublish(input: {
  prior: string;
  next: string;
  observedPriorDigest: string;
  digest: (value: string) => string;
  marker: string;
}): ManagedPublishPlan {
  if (!input.prior.includes(input.marker) || !input.next.includes(input.marker)) {
    throw new CommonWorkConflictError("managed marker is missing");
  }
  const priorDigest = input.digest(input.prior);
  if (priorDigest !== input.observedPriorDigest) {
    throw new CommonWorkConflictError("managed target drifted");
  }
  return {
    prior: input.prior,
    next: input.next,
    priorDigest,
    nextDigest: input.digest(input.next),
    marker: input.marker,
  };
}
export function verifyManagedPublish(
  plan: ManagedPublishPlan,
  observed: string,
  digest: (value: string) => string,
): "applied" | "rolled_back" {
  const observedDigest = digest(observed);
  if (observedDigest === plan.nextDigest) {
    return "applied";
  }
  if (observedDigest === plan.priorDigest) {
    return "rolled_back";
  }
  throw new CommonWorkConflictError("publisher read-back matches neither candidate nor rollback");
}

export function applyCommonWorkAdminPatch(
  record: CommonWorkRecord,
  input: {
    actorRole: string;
    expectedRevision: number;
    ownerAgentId?: string;
    userRoute?: CommonWorkRoute;
  },
  now: number,
): CommonWorkRecord {
  if (input.actorRole !== "to") {
    throw new CommonWorkAuthorityError("only TO may correct cross-owner common-work facts");
  }
  if (input.expectedRevision !== record.revision) {
    throw new CommonWorkConflictError("stale common-work revision");
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      ownerAgentId: input.ownerAgentId ?? record.ownerAgentId,
      userRoute: input.userRoute ?? record.userRoute,
    },
    now,
  );
}

export function assertCommonWorkFileDelivery(input: {
  path: string;
  reportedBytes: number;
  actualBytes: number;
  reportedDigest: string;
  actualDigest: string;
}): void {
  if (!input.path.includes("/outbox/") || input.path.includes("/inbox/")) {
    throw new CommonWorkConflictError("delivery path is not an approved outbox");
  }
  if (input.reportedBytes !== input.actualBytes || input.reportedDigest !== input.actualDigest) {
    throw new CommonWorkConflictError("delivery evidence does not match the artifact");
  }
}

export function assertCommonWorkBuildIdentity(input: {
  candidateBuildId: string;
  uiBuildId: string;
  httpReady: boolean;
  websocketReady: boolean;
  channelReady: boolean;
}): void {
  if (
    input.candidateBuildId !== input.uiBuildId ||
    !input.httpReady ||
    !input.websocketReady ||
    !input.channelReady
  ) {
    throw new CommonWorkConflictError("release candidate failed build or user-path verification");
  }
}

export function assertCommonWorkMutationSafety(input: {
  identityMatches: boolean;
  omissions: number;
  protectedSourceTouched: boolean;
  remainingRatio: number;
  minimumRemainingRatio: number;
}): void {
  if (
    !input.identityMatches ||
    input.omissions !== 0 ||
    input.protectedSourceTouched ||
    input.remainingRatio < input.minimumRemainingRatio
  ) {
    throw new CommonWorkConflictError("mutation safety gate failed");
  }
}

export function shouldPublishCommonWorkDecision(input: {
  status: "draft" | "accepted" | "superseded";
  implementationComplete: boolean;
}): boolean {
  return input.status === "accepted" && input.implementationComplete;
}

export type CommonWorkLedgerOutageState = {
  mode: "normal" | "bounded_read_only";
  evidence: string[];
  pendingReconciliation: string[];
};
export function recordBoundedOutageEvidence(
  state: CommonWorkLedgerOutageState,
  evidence: string,
): CommonWorkLedgerOutageState {
  return {
    mode: "bounded_read_only",
    evidence: [...new Set([...state.evidence, evidence])],
    pendingReconciliation: state.pendingReconciliation,
  };
}
export function reconcileCommonWorkLedger(
  state: CommonWorkLedgerOutageState,
  workId: string,
): CommonWorkLedgerOutageState {
  const pendingReconciliation = state.pendingReconciliation.filter((id) => id !== workId);
  return {
    mode: pendingReconciliation.length === 0 ? "normal" : "bounded_read_only",
    evidence: state.evidence,
    pendingReconciliation,
  };
}
