import { subagentRuns } from "./subagent-registry-memory.js";
import { persistSubagentRunsToDisk } from "./subagent-registry-state.js";
import type {
  SubagentCompletionArtifactReference,
  SubagentCompletionDedupeCounters,
  SubagentCompletionDedupeRecord,
  SubagentChildResultRetryAttemptRecord,
  SubagentChildResultRetryPolicyRecord,
  SubagentCompletionEvidenceVerifierDecision,
  SubagentCompletionNormalizedResult,
  SubagentRunRecord,
} from "./subagent-registry.types.js";

export type SubagentCompletionDedupeInput = {
  childRunId: string;
  childSessionKey: string;
  dedupeKey: string;
  activeTaskContractId: string;
  childSessionId: string;
  taskId: string;
  resultHash: string;
  backgrounded?: boolean;
  quarantine?: SubagentCompletionArtifactReference;
  rawArtifactReference?: SubagentCompletionArtifactReference;
  normalizedResult?: SubagentCompletionNormalizedResult;
  evidenceVerifierDecision?: SubagentCompletionEvidenceVerifierDecision;
  retryAttempt?: SubagentChildResultRetryAttemptRecord;
  retryPolicy?: SubagentChildResultRetryPolicyRecord;
  now?: number;
};

export type SubagentCompletionDedupeDecision = {
  duplicate: boolean;
  key: string;
  counters: SubagentCompletionDedupeCounters;
  backgrounded: boolean;
  existingKey?: string;
  reasons: string[];
};

function nowMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : Date.now();
}

function initialCounters(): SubagentCompletionDedupeCounters {
  return {
    seenCount: 0,
    deliveredCount: 0,
    duplicateCount: 0,
    suppressedCount: 0,
    backgroundedCount: 0,
  };
}

function cloneCounters(
  counters: SubagentCompletionDedupeCounters,
): SubagentCompletionDedupeCounters {
  return { ...counters };
}

function findRunForCompletion(
  params: Pick<SubagentCompletionDedupeInput, "childRunId" | "childSessionKey">,
): SubagentRunRecord | undefined {
  const byRunId = subagentRuns.get(params.childRunId);
  if (byRunId) {
    return byRunId;
  }
  let latest: SubagentRunRecord | undefined;
  for (const entry of subagentRuns.values()) {
    if (entry.childSessionKey !== params.childSessionKey) {
      continue;
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }
  return latest;
}

function buildRecord(
  params: SubagentCompletionDedupeInput,
  seenAt: number,
): SubagentCompletionDedupeRecord {
  return {
    key: params.dedupeKey,
    activeTaskContractId: params.activeTaskContractId,
    childRunId: params.childRunId,
    childSessionId: params.childSessionId,
    taskId: params.taskId,
    resultHash: params.resultHash,
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    counters: initialCounters(),
    ...(params.quarantine ? { lastQuarantine: params.quarantine } : {}),
    ...(params.rawArtifactReference
      ? { lastRawArtifactReference: params.rawArtifactReference }
      : {}),
    ...(params.normalizedResult ? { lastNormalizedResult: params.normalizedResult } : {}),
    ...(params.evidenceVerifierDecision
      ? { lastEvidenceVerifierDecision: params.evidenceVerifierDecision }
      : {}),
    ...(params.retryAttempt ? { lastChildResultRetryAttempt: params.retryAttempt } : {}),
    ...(params.retryPolicy ? { lastChildResultRetryPolicy: params.retryPolicy } : {}),
  };
}

function ensureCompletionDedupeRecords(
  entry: SubagentRunRecord,
): Record<string, SubagentCompletionDedupeRecord> {
  const records = entry.completionDedupeRecords ?? {};
  if (entry.completionDedupe?.key && !records[entry.completionDedupe.key]) {
    records[entry.completionDedupe.key] = entry.completionDedupe;
  }
  entry.completionDedupeRecords = records;
  return records;
}

function getRecord(
  entry: SubagentRunRecord,
  dedupeKey: string,
): SubagentCompletionDedupeRecord | undefined {
  return ensureCompletionDedupeRecords(entry)[dedupeKey];
}

function storeRecord(entry: SubagentRunRecord, record: SubagentCompletionDedupeRecord): void {
  ensureCompletionDedupeRecords(entry)[record.key] = record;
  entry.completionDedupe = record;
}

function ensureRecord(
  entry: SubagentRunRecord,
  params: SubagentCompletionDedupeInput,
  seenAt: number,
): SubagentCompletionDedupeRecord {
  const existing = getRecord(entry, params.dedupeKey);
  if (!existing) {
    const record = buildRecord(params, seenAt);
    if (params.retryAttempt) {
      entry.childResultRetryAttempt = params.retryAttempt;
    }
    storeRecord(entry, record);
    return record;
  }
  existing.lastSeenAt = seenAt;
  existing.activeTaskContractId = params.activeTaskContractId;
  existing.childRunId = params.childRunId;
  existing.childSessionId = params.childSessionId;
  existing.taskId = params.taskId;
  existing.resultHash = params.resultHash;
  if (params.quarantine) {
    existing.lastQuarantine = params.quarantine;
  }
  if (params.rawArtifactReference) {
    existing.lastRawArtifactReference = params.rawArtifactReference;
  }
  if (params.normalizedResult) {
    existing.lastNormalizedResult = params.normalizedResult;
  }
  if (params.evidenceVerifierDecision) {
    existing.lastEvidenceVerifierDecision = params.evidenceVerifierDecision;
  }
  if (params.retryAttempt) {
    existing.lastChildResultRetryAttempt = params.retryAttempt;
    entry.childResultRetryAttempt = params.retryAttempt;
  }
  if (params.retryPolicy) {
    existing.lastChildResultRetryPolicy = params.retryPolicy;
  }
  storeRecord(entry, existing);
  return existing;
}

function decision(params: {
  duplicate: boolean;
  key: string;
  counters: SubagentCompletionDedupeCounters;
  backgrounded: boolean;
  existingKey?: string;
  reasons: string[];
}): SubagentCompletionDedupeDecision {
  return {
    duplicate: params.duplicate,
    key: params.key,
    counters: cloneCounters(params.counters),
    backgrounded: params.backgrounded,
    ...(params.existingKey ? { existingKey: params.existingKey } : {}),
    reasons: params.reasons,
  };
}

export function beginSubagentCompletionDedupe(
  params: SubagentCompletionDedupeInput,
): SubagentCompletionDedupeDecision {
  const entry = findRunForCompletion(params);
  const backgrounded = params.backgrounded === true;
  if (!entry) {
    const counters = initialCounters();
    counters.seenCount = 1;
    if (backgrounded) {
      counters.backgroundedCount = 1;
    }
    return decision({
      duplicate: false,
      key: params.dedupeKey,
      counters,
      backgrounded,
      reasons: ["SUBAGENT_RUN_RECORD_MISSING"],
    });
  }

  const seenAt = nowMs(params.now);
  const previousLatestKey = entry.completionDedupe?.key;
  const exactExistingRecord = getRecord(entry, params.dedupeKey);
  const entryCompletionAlreadyMarked =
    typeof entry.completionAnnouncedAt === "number" ||
    typeof entry.completionDeliveredAt === "number";
  const alreadyDeliveredCompletion = Boolean(
    exactExistingRecord?.deliveredAt || entryCompletionAlreadyMarked,
  );
  const record = ensureRecord(entry, params, seenAt);
  record.counters.seenCount += 1;
  if (backgrounded) {
    record.counters.backgroundedCount += 1;
    record.lastBackgroundedAt = seenAt;
  }
  const duplicate = alreadyDeliveredCompletion;
  const reasons: string[] = [];
  if (duplicate) {
    record.counters.duplicateCount += 1;
    record.counters.suppressedCount += 1;
    record.lastSuppressedAt = seenAt;
    entry.lastAnnounceDropReason = "dedupe";
    reasons.push("DUPLICATE_COMPLETION");
  } else if (previousLatestKey && previousLatestKey !== params.dedupeKey) {
    reasons.push("COMPLETION_DEDUPE_KEY_NEW");
  }
  persistSubagentRunsToDisk(subagentRuns);

  return decision({
    duplicate,
    key: params.dedupeKey,
    counters: record.counters,
    backgrounded,
    existingKey: exactExistingRecord?.key ?? previousLatestKey,
    reasons,
  });
}

export function markSubagentCompletionDedupeDelivered(
  params: SubagentCompletionDedupeInput,
): SubagentCompletionDedupeDecision {
  const entry = findRunForCompletion(params);
  const backgrounded = params.backgrounded === true;
  if (!entry) {
    const counters = initialCounters();
    counters.seenCount = 1;
    counters.deliveredCount = 1;
    if (backgrounded) {
      counters.backgroundedCount = 1;
    }
    return decision({
      duplicate: false,
      key: params.dedupeKey,
      counters,
      backgrounded,
      reasons: ["SUBAGENT_RUN_RECORD_MISSING"],
    });
  }

  const deliveredAt = nowMs(params.now);
  const record = ensureRecord(entry, params, deliveredAt);
  if (record.counters.seenCount < 1) {
    record.counters.seenCount = 1;
  }
  if (!record.deliveredAt) {
    record.counters.deliveredCount += 1;
  }
  record.deliveredAt = deliveredAt;
  record.lastSeenAt = deliveredAt;
  if (backgrounded) {
    record.counters.backgroundedCount += 1;
    record.lastBackgroundedAt = deliveredAt;
  }
  storeRecord(entry, record);
  persistSubagentRunsToDisk(subagentRuns);

  return decision({
    duplicate: false,
    key: params.dedupeKey,
    counters: record.counters,
    backgrounded,
    reasons: [],
  });
}
