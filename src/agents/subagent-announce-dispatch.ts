import { buildAnnounceIdFromChildRun } from "./announce-idempotency.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDisk } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type SubagentDeliveryPath = "queued" | "steered" | "direct" | "none";

export type SubagentAnnounceQueueOutcome = "steered" | "queued" | "none" | "dropped";

export type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  error?: string;
  phases?: SubagentAnnounceDispatchPhaseResult[];
};

export type SubagentAnnounceDispatchPhase = "queue-primary" | "direct-primary" | "queue-fallback";

export type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  delivered: boolean;
  path: SubagentDeliveryPath;
  error?: string;
};

const ANNOUNCE_DELIVERY_LEASE_TTL_MS = 5 * 60_000;

type SubagentAnnounceDispatchDeps = {
  getRuns: () => Map<string, SubagentRunRecord>;
  now: () => number;
  persist: () => void;
  randomUUID: () => string;
};

const defaultSubagentAnnounceDispatchDeps: SubagentAnnounceDispatchDeps = {
  getRuns: () => subagentRuns,
  now: () => Date.now(),
  persist: () => persistSubagentRunsToDisk(subagentRuns),
  randomUUID: () => crypto.randomUUID(),
};

let subagentAnnounceDispatchDeps: SubagentAnnounceDispatchDeps =
  defaultSubagentAnnounceDispatchDeps;

type DeliveryClaimResult =
  | { status: "skipped" | "started"; token?: string }
  | { status: "already-delivered" | "in-flight"; path?: SubagentDeliveryPath };

function findSubagentRunEntryByAnnounceId(announceId?: string): SubagentRunRecord | null {
  const normalized = announceId?.trim();
  if (!normalized) {
    return null;
  }
  for (const entry of subagentAnnounceDispatchDeps.getRuns().values()) {
    if (
      buildAnnounceIdFromChildRun({
        childSessionKey: entry.childSessionKey,
        childRunId: entry.runId,
      }) === normalized
    ) {
      return entry;
    }
  }
  return null;
}

function beginPersistedAnnounceDeliveryClaim(announceId?: string): DeliveryClaimResult {
  const normalized = announceId?.trim();
  if (!normalized) {
    return { status: "skipped" };
  }
  const entry = findSubagentRunEntryByAnnounceId(normalized);
  if (!entry) {
    return { status: "skipped" };
  }
  const now = subagentAnnounceDispatchDeps.now();
  const existing = entry.deliveryClaim;
  if (typeof entry.completionAnnouncedAt === "number" || existing?.state === "delivered") {
    return {
      status: "already-delivered",
      path: existing?.path ?? "none",
    };
  }
  if (
    existing?.state === "claimed" &&
    now - (existing.updatedAt ?? existing.claimedAt ?? 0) < ANNOUNCE_DELIVERY_LEASE_TTL_MS
  ) {
    return {
      status: "in-flight",
      path: existing.path ?? "none",
    };
  }
  entry.deliveryClaim = {
    announceId: normalized,
    state: "claimed",
    token: subagentAnnounceDispatchDeps.randomUUID(),
    path: "none",
    claimedAt: now,
    updatedAt: now,
  };
  subagentAnnounceDispatchDeps.persist();
  return {
    status: "started",
    token: entry.deliveryClaim.token,
  };
}

function finalizePersistedAnnounceDeliveryClaim(
  announceId: string | undefined,
  token: string | undefined,
  result: SubagentAnnounceDeliveryResult,
) {
  const normalized = announceId?.trim();
  if (!normalized || !token) {
    return;
  }
  const entry = findSubagentRunEntryByAnnounceId(normalized);
  if (!entry?.deliveryClaim || entry.deliveryClaim.token !== token) {
    return;
  }
  if (result.delivered) {
    const now = subagentAnnounceDispatchDeps.now();
    entry.deliveryClaim = {
      ...entry.deliveryClaim,
      announceId: normalized,
      state: "delivered",
      path: result.path ?? "none",
      updatedAt: now,
    };
    if (typeof entry.completionAnnouncedAt !== "number") {
      entry.completionAnnouncedAt = now;
    }
    subagentAnnounceDispatchDeps.persist();
    return;
  }
  delete entry.deliveryClaim;
  subagentAnnounceDispatchDeps.persist();
}

export function mapQueueOutcomeToDeliveryResult(
  outcome: SubagentAnnounceQueueOutcome,
): SubagentAnnounceDeliveryResult {
  if (outcome === "steered") {
    return {
      delivered: true,
      path: "steered",
    };
  }
  if (outcome === "queued") {
    return {
      delivered: true,
      path: "queued",
    };
  }
  return {
    delivered: false,
    path: "none",
  };
}

export async function runSubagentAnnounceDispatch(params: {
  announceId?: string;
  expectsCompletionMessage: boolean;
  signal?: AbortSignal;
  queue: () => Promise<SubagentAnnounceQueueOutcome>;
  direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult> {
  const phases: SubagentAnnounceDispatchPhaseResult[] = [];
  const appendPhase = (
    phase: SubagentAnnounceDispatchPhase,
    result: SubagentAnnounceDeliveryResult,
  ) => {
    phases.push({
      phase,
      delivered: result.delivered,
      path: result.path,
      error: result.error,
    });
  };
  const withPhases = (result: SubagentAnnounceDeliveryResult): SubagentAnnounceDeliveryResult => ({
    ...result,
    phases,
  });

  const claim = beginPersistedAnnounceDeliveryClaim(params.announceId);
  if (claim.status === "already-delivered") {
    return withPhases({
      delivered: true,
      path: claim.path ?? "none",
    });
  }
  if (claim.status === "in-flight") {
    return withPhases({
      delivered: false,
      path: "none",
      error: "delivery-already-in-flight",
    });
  }

  if (params.signal?.aborted) {
    return withPhases({
      delivered: false,
      path: "none",
    });
  }

  let finalResult: SubagentAnnounceDeliveryResult = {
    delivered: false,
    path: "none",
  };

  try {
    const primaryQueueOutcome = await params.queue();
    const primaryQueue = mapQueueOutcomeToDeliveryResult(primaryQueueOutcome);
    appendPhase("queue-primary", primaryQueue);

    if (primaryQueue.delivered || primaryQueueOutcome === "dropped") {
      finalResult = primaryQueue;
      return withPhases(finalResult);
    }

    if (!params.expectsCompletionMessage) {
      const primaryDirect = await params.direct();
      appendPhase("direct-primary", primaryDirect);
      finalResult = primaryDirect;
      return withPhases(finalResult);
    }

    if (params.signal?.aborted) {
      finalResult = primaryQueue;
      return withPhases(finalResult);
    }

    const fallbackDirect = await params.direct();
    appendPhase("direct-primary", fallbackDirect);
    finalResult = fallbackDirect;
    return withPhases(finalResult);
  } finally {
    finalizePersistedAnnounceDeliveryClaim(params.announceId, claim.token, finalResult);
  }
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDispatchDeps>) {
    subagentAnnounceDispatchDeps = overrides
      ? {
          ...defaultSubagentAnnounceDispatchDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDispatchDeps;
  },
};
