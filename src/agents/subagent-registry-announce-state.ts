import { normalizeOptionalString } from "../shared/string-coerce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { getLatestSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { persistSubagentRunsToDisk } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentAnnounceStateDeps = {
  resumeSubagentRun: (runId: string) => void;
};

const defaultSubagentAnnounceStateDeps: SubagentAnnounceStateDeps = {
  resumeSubagentRun: () => {},
};

let subagentAnnounceStateDeps: SubagentAnnounceStateDeps = defaultSubagentAnnounceStateDeps;

function resolveSubagentAnnounceStateEntry(params: {
  sourceRunId?: string;
  sourceSessionKey?: string;
}): SubagentRunRecord | null {
  const sourceRunId = normalizeOptionalString(params.sourceRunId);
  if (sourceRunId) {
    const entry = subagentRuns.get(sourceRunId);
    if (entry) {
      return entry;
    }
  }

  const sourceSessionKey = normalizeOptionalString(params.sourceSessionKey);
  if (!sourceSessionKey) {
    return null;
  }

  return getLatestSubagentRunByChildSessionKey(sourceSessionKey) ?? null;
}

export function configureSubagentAnnounceState(overrides?: Partial<SubagentAnnounceStateDeps>) {
  subagentAnnounceStateDeps = overrides
    ? {
        ...defaultSubagentAnnounceStateDeps,
        ...overrides,
      }
    : defaultSubagentAnnounceStateDeps;
}

export function markSubagentAnnouncePending(params: {
  announceId?: string;
  sourceRunId?: string;
  sourceSessionKey?: string;
}) {
  const announceId = normalizeOptionalString(params.announceId);
  if (!announceId) {
    return;
  }

  const entry = resolveSubagentAnnounceStateEntry(params);
  if (!entry) {
    return;
  }
  if (entry.lastAnnounceDeliveredId === announceId) {
    return;
  }

  entry.pendingAnnounceId = announceId;
  entry.pendingAnnounceAt = Date.now();
  persistSubagentRunsToDisk(subagentRuns);
}

export function markSubagentAnnounceDelivered(params: {
  announceId?: string;
  sourceRunId?: string;
  sourceSessionKey?: string;
}) {
  const announceId = normalizeOptionalString(params.announceId);
  if (!announceId) {
    return;
  }

  const entry = resolveSubagentAnnounceStateEntry(params);
  if (!entry) {
    return;
  }
  if (entry.lastAnnounceDeliveredId === announceId && typeof entry.lastAnnounceDeliveredAt === "number") {
    return;
  }

  entry.lastAnnounceDeliveredId = announceId;
  entry.lastAnnounceDeliveredAt = Date.now();
  const wasPending = entry.pendingAnnounceId === announceId;
  if (wasPending) {
    entry.pendingAnnounceId = undefined;
    entry.pendingAnnounceAt = undefined;
  }
  persistSubagentRunsToDisk(subagentRuns);
  if (wasPending && entry.runId) {
    setTimeout(() => {
      subagentAnnounceStateDeps.resumeSubagentRun(entry.runId);
    }, 0).unref?.();
  }
}

export function clearStaleSubagentAnnouncePendingState(): boolean {
  let mutated = false;
  for (const entry of subagentRuns.values()) {
    if (!entry.pendingAnnounceId) {
      continue;
    }
    entry.pendingAnnounceId = undefined;
    entry.pendingAnnounceAt = undefined;
    mutated = true;
  }

  if (mutated) {
    persistSubagentRunsToDisk(subagentRuns);
  }

  return mutated;
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceStateDeps>) {
    configureSubagentAnnounceState(overrides);
  },
};
