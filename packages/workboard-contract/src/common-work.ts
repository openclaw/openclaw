import type { CommonWorkDiscovery } from "./common-work-objective.js";

export const COMMON_WORK_LANES = ["common", "uni", "luke"] as const;
export type CommonWorkLane = (typeof COMMON_WORK_LANES)[number];

export type CommonWorkRoute = { channelId: string; threadId: string; version: number };
export type CommonWorkExecution = {
  executionId: string;
  generation: number;
  sessionKey: string;
  status: "running" | "done" | "failed" | "cancelled";
  terminalReceipt?: string;
};
export type CommonWorkResponsibility = "owned" | "return_pending" | "delivery_pending" | "settled";
export type CommonWorkOutcome = "pending" | "succeeded" | "failed" | "blocked";
export type CommonWorkArchiveState = "open" | "archived" | "archive_failed";
export type CommonWorkRecord = {
  workId: string;
  requestKey: string;
  requestDigest: string;
  goal: string;
  objectiveDigest: string;
  scope: string[];
  acceptanceCriteria: string[];
  reportingLeadAgentId: string;
  discoveries: CommonWorkDiscovery[];
  helperReturns: Array<{ agentId: string; receipt: string }>;
  scopeRevision: number;
  ownerAgentId: string;
  lane: CommonWorkLane;
  sourceSessionKey: string;
  callbackSessionKey: string;
  userRoute: CommonWorkRoute;
  routeFamily: string;
  routeSequence: number;
  routeOpen?: {
    idempotencyKey: string;
    title: string;
    state: "reserved" | "sent" | "unknown";
    receipt?: string;
    reconciliationRequired: boolean;
  };
  execution?: CommonWorkExecution;
  responsibility: CommonWorkResponsibility;
  outcome: CommonWorkOutcome;
  callbackReceipt?: string;
  callbackDedupeKey?: string;
  deliveryReceipt?: string;
  archiveState: CommonWorkArchiveState;
  closedAt?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  checkpointAt?: number;
  watcherGeneration: number;
  resources: string[];
  releasedResources: string[];
};

export type CommonWorkAdmission = {
  workId: string;
  requestKey: string;
  requestDigest: string;
  goal: string;
  objectiveDigest: string;
  scope: string[];
  acceptanceCriteria: string[];
  reportingLeadAgentId: string;
  ownerAgentId: string;
  lane: CommonWorkLane;
  sourceSessionKey: string;
  callbackSessionKey: string;
  userRoute: CommonWorkRoute;
  routeFamily: string;
  routeSequence: number;
  now: number;
};

export class CommonWorkConflictError extends Error {}
export class CommonWorkAuthorityError extends Error {}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CommonWorkConflictError(name + " must not be empty");
  }
  return normalized;
}

function requireNonEmptyList(values: readonly string[], name: string): string[] {
  if (values.length === 0) {
    throw new CommonWorkConflictError(name + " must not be empty");
  }
  return values.map((value) => requireNonEmpty(value, name));
}

export function advanceCommonWorkRevision(record: CommonWorkRecord, now: number): CommonWorkRecord {
  return { ...record, revision: record.revision + 1, updatedAt: now };
}

export function admitCommonWork(
  input: CommonWorkAdmission,
  existing?: CommonWorkRecord,
): { record: CommonWorkRecord; created: boolean } {
  if (existing) {
    if (
      existing.requestKey !== input.requestKey ||
      existing.requestDigest !== input.requestDigest
    ) {
      throw new CommonWorkConflictError("request key was reused with a different payload");
    }
    return { record: existing, created: false };
  }
  const goal = requireNonEmpty(input.goal, "objective");
  const objectiveDigest = requireNonEmpty(input.objectiveDigest, "objective digest");
  const scope = requireNonEmptyList(input.scope, "scope");
  const acceptanceCriteria = requireNonEmptyList(input.acceptanceCriteria, "acceptance criteria");
  const reportingLeadAgentId = requireNonEmpty(
    input.reportingLeadAgentId,
    "reporting lead agent id",
  );
  return {
    created: true,
    record: {
      workId: input.workId,
      requestKey: input.requestKey,
      requestDigest: input.requestDigest,
      goal,
      objectiveDigest,
      scope,
      acceptanceCriteria,
      reportingLeadAgentId,
      discoveries: [],
      helperReturns: [],
      scopeRevision: 1,
      ownerAgentId: input.ownerAgentId,
      lane: input.lane,
      sourceSessionKey: input.sourceSessionKey,
      callbackSessionKey: input.callbackSessionKey,
      userRoute: input.userRoute,
      routeFamily: input.routeFamily,
      routeSequence: input.routeSequence,
      responsibility: "owned",
      outcome: "pending",
      archiveState: "open",
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
      watcherGeneration: 0,
      resources: [],
      releasedResources: [],
    },
  };
}

export function commonWorkRootTitle(record: CommonWorkRecord, date: string): string {
  return date + " · " + record.routeFamily + " · #" + record.routeSequence;
}

export function reserveCommonWorkRoute(
  record: CommonWorkRecord,
  idempotencyKey: string,
  title: string,
  now: number,
): CommonWorkRecord {
  if (record.routeOpen) {
    if (record.routeOpen.idempotencyKey !== idempotencyKey || record.routeOpen.title !== title) {
      throw new CommonWorkConflictError("route family already has an opener");
    }
    return record;
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      routeOpen: { idempotencyKey, title, state: "reserved", reconciliationRequired: false },
    },
    now,
  );
}

export function recordCommonWorkRootSend(
  record: CommonWorkRecord,
  result: { state: "sent"; receipt: string } | { state: "unknown" },
  now: number,
): CommonWorkRecord {
  if (!record.routeOpen) {
    throw new CommonWorkConflictError("route was not reserved");
  }
  if (record.routeOpen.state === "sent") {
    if (result.state !== "sent" || result.receipt !== record.routeOpen.receipt) {
      throw new CommonWorkConflictError("canonical route receipt cannot be replaced");
    }
    return record;
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      routeOpen:
        result.state === "sent"
          ? {
              ...record.routeOpen,
              state: "sent",
              receipt: result.receipt,
              reconciliationRequired: false,
            }
          : { ...record.routeOpen, state: "unknown", reconciliationRequired: true },
    },
    now,
  );
}

export function updateCommonWorkRoute(
  record: CommonWorkRecord,
  route: CommonWorkRoute,
  now: number,
): CommonWorkRecord {
  if (route.version <= record.userRoute.version) {
    throw new CommonWorkConflictError("canonical route version must increase");
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      userRoute: route,
      deliveryReceipt: undefined,
      responsibility:
        record.responsibility === "settled" ? "delivery_pending" : record.responsibility,
    },
    now,
  );
}

export function attachCommonWorkExecution(
  record: CommonWorkRecord,
  input: Omit<CommonWorkExecution, "status">,
  now: number,
): CommonWorkRecord {
  const current = record.execution;
  if (current?.status === "running") {
    if (
      current.executionId === input.executionId &&
      current.generation === input.generation &&
      current.sessionKey === input.sessionKey
    ) {
      return record;
    }
    throw new CommonWorkConflictError("work already has an active execution");
  }
  if (current && input.generation <= current.generation) {
    throw new CommonWorkConflictError("execution generation must increase");
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      execution: { ...input, status: "running" },
      responsibility: "owned",
      outcome: "pending",
    },
    now,
  );
}

export function settleCommonWorkExecution(
  record: CommonWorkRecord,
  input: {
    executionId: string;
    generation: number;
    status: "done" | "failed" | "cancelled";
    terminalReceipt: string;
  },
  now: number,
): { record: CommonWorkRecord; accepted: boolean } {
  const current = record.execution;
  if (
    !current ||
    current.executionId !== input.executionId ||
    current.generation !== input.generation
  ) {
    return { record, accepted: false };
  }
  if (current.status !== "running") {
    if (current.terminalReceipt !== input.terminalReceipt || current.status !== input.status) {
      throw new CommonWorkConflictError("terminal execution was replayed with conflicting facts");
    }
    return { record, accepted: false };
  }
  return {
    accepted: true,
    record: advanceCommonWorkRevision(
      {
        ...record,
        execution: { ...current, status: input.status, terminalReceipt: input.terminalReceipt },
        outcome:
          input.status === "done" ? "succeeded" : input.status === "failed" ? "failed" : "blocked",
        responsibility: "return_pending",
      },
      now,
    ),
  };
}

export function recordCommonWorkCallback(
  record: CommonWorkRecord,
  input: { dedupeKey: string; receipt: string; targetSessionKey: string },
  now: number,
): CommonWorkRecord {
  if (input.targetSessionKey !== record.callbackSessionKey) {
    throw new CommonWorkConflictError("callback target does not match the admitted endpoint");
  }
  if (!record.execution || record.execution.status === "running") {
    throw new CommonWorkConflictError("execution must be terminal before callback");
  }
  if (record.callbackReceipt) {
    if (record.callbackDedupeKey !== input.dedupeKey || record.callbackReceipt !== input.receipt) {
      throw new CommonWorkConflictError("callback was already recorded");
    }
    return record;
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      callbackDedupeKey: input.dedupeKey,
      callbackReceipt: input.receipt,
      responsibility: "delivery_pending",
    },
    now,
  );
}

export function recordCommonWorkDelivery(
  record: CommonWorkRecord,
  input: { route: CommonWorkRoute; receipt: string },
  now: number,
): CommonWorkRecord {
  const route = record.userRoute;
  if (
    input.route.channelId !== route.channelId ||
    input.route.threadId !== route.threadId ||
    input.route.version !== route.version
  ) {
    throw new CommonWorkConflictError("delivery receipt is not for the latest canonical route");
  }
  if (!record.callbackReceipt) {
    throw new CommonWorkConflictError("internal callback must precede user delivery");
  }
  if (record.deliveryReceipt) {
    if (record.deliveryReceipt !== input.receipt) {
      throw new CommonWorkConflictError("delivery was already recorded");
    }
    return record;
  }
  return advanceCommonWorkRevision(
    { ...record, deliveryReceipt: input.receipt, responsibility: "settled" },
    now,
  );
}

export function closeCommonWork(record: CommonWorkRecord, now: number): CommonWorkRecord {
  if (record.closedAt !== undefined) {
    return record;
  }
  if (record.outcome === "pending" || record.responsibility !== "settled") {
    throw new CommonWorkConflictError("work outcome and delivery responsibility are not complete");
  }
  return advanceCommonWorkRevision({ ...record, closedAt: now }, now);
}

export function archiveCommonWork(
  record: CommonWorkRecord,
  input: { live: boolean; protectedSession: boolean; ownedByCaller: boolean; succeeded: boolean },
  now: number,
): CommonWorkRecord {
  if (input.live || input.protectedSession || !input.ownedByCaller) {
    throw new CommonWorkAuthorityError("live, protected, or foreign work cannot be archived");
  }
  return advanceCommonWorkRevision(
    { ...record, archiveState: input.succeeded ? "archived" : "archive_failed" },
    now,
  );
}

export function checkpointCommonWork(
  record: CommonWorkRecord,
  input: { at: number; generation: number },
): CommonWorkRecord {
  if (input.generation < record.watcherGeneration) {
    return record;
  }
  if (input.generation === record.watcherGeneration && input.at <= (record.checkpointAt ?? 0)) {
    return record;
  }
  return advanceCommonWorkRevision(
    { ...record, checkpointAt: input.at, watcherGeneration: input.generation },
    input.at,
  );
}

export function addCommonWorkResources(
  record: CommonWorkRecord,
  resources: readonly string[],
  now: number,
): CommonWorkRecord {
  const nextResources = [...new Set([...record.resources, ...resources])];
  return nextResources.length === record.resources.length
    ? record
    : advanceCommonWorkRevision({ ...record, resources: nextResources }, now);
}

export function releaseCommonWorkResources(
  record: CommonWorkRecord,
  now: number,
): CommonWorkRecord {
  if (record.resources.length === 0) {
    return record;
  }
  return advanceCommonWorkRevision(
    {
      ...record,
      resources: [],
      releasedResources: [...new Set([...record.releasedResources, ...record.resources])],
      watcherGeneration: record.watcherGeneration + 1,
    },
    now,
  );
}
