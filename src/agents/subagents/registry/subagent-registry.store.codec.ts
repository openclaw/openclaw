import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionStateNotice } from "../../../sessions/session-state-events.kernel.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type {
  SubagentRegistryWrite,
  SubagentRegistryWriteReceipt,
} from "./subagent-registry.store.kernel.js";
import { subagentRunRowVersion, type SubagentRunSqliteRow } from "./subagent-registry.store.row.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type CanonicalSubagentRunRecord = SubagentRunRecord &
  Required<Pick<SubagentRunRecord, "completion" | "delivery">>;
const EXECUTION_STATUSES = new Set("queued running interrupted terminal".split(" "));
const DELIVERY_STATUSES = new Set(
  "not_required pending in_progress delivered failed suspended discarded".split(" "),
);

function hasStateStatus(
  value: unknown,
  statuses: ReadonlySet<string>,
): value is Record<string, unknown> {
  return isRecord(value) && typeof value.status === "string" && statuses.has(value.status);
}

export function isCanonicalSubagentRunRecord(value: unknown): value is CanonicalSubagentRunRecord {
  return (
    isRecord(value) &&
    hasStateStatus(value.execution, EXECUTION_STATUSES) &&
    isRecord(value.completion) &&
    typeof value.completion.required === "boolean" &&
    hasStateStatus(value.delivery, DELIVERY_STATUSES) &&
    !(
      "handoffLeaseId" in value.delivery ||
      "handoffLeasedAt" in value.delivery ||
      "handoffInjectedAt" in value.delivery
    )
  );
}

/** Rehydrates one sqlite row into the normalized subagent run record shape. */
export function rowToSubagentRunRecord(row: SubagentRunSqliteRow): SubagentRunRecord | null {
  const stored = row.payload_json ? safeParseJson(row.payload_json) : undefined;
  const payload =
    isRecord(stored) &&
    isRecord(stored.parentCompletion) &&
    stored.parentCompletion.completionTarget === "parent"
      ? stored.parentCompletion
      : stored;
  if (!isCanonicalSubagentRunRecord(payload)) {
    return null;
  }
  // Writers commit indexed columns with this complete payload atomically;
  // rehydrating both created competing state.
  payload.runId = row.run_id;
  payload.childSessionKey = row.child_session_key;
  payload.requesterSessionKey = row.requester_session_key;
  payload.requesterStorePath = row.requester_store_path ?? undefined;
  payload.controllerStorePath = row.controller_store_path ?? undefined;
  const controllerSessionKey = row.controller_session_key?.trim();
  if (controllerSessionKey) {
    payload.controllerSessionKey = controllerSessionKey;
  } else {
    delete payload.controllerSessionKey;
  }
  if (payload.requesterOrigin) {
    payload.requesterOrigin = normalizeDeliveryContext(payload.requesterOrigin);
  }
  if (payload.expectsCompletionMessage === false) {
    payload.delivery.status = "not_required";
  }
  const record = normalizeSubagentRunState(payload);
  if (!record.runId || !record.childSessionKey || !record.requesterSessionKey) {
    return null;
  }
  rememberSubagentRunVersion(record, subagentRunRowVersion(row)!);
  return record;
}

/** Canonically serializes a run before an outer transaction acquires the write lock. */
export function bindSubagentRunRecord(entry: SubagentRunRecord): SubagentRunSqliteRow {
  const normalized = normalizeSubagentRunState(structuredClone(entry));
  if (!isCanonicalSubagentRunRecord(normalized)) {
    throw new Error("subagent run is missing canonical nested state");
  }
  return {
    run_id: normalized.runId,
    child_session_key: normalized.childSessionKey,
    controller_session_key: normalized.controllerSessionKey?.trim() || null,
    requester_session_key: normalized.requesterSessionKey,
    requester_store_path: normalized.requesterStorePath ?? null,
    controller_store_path: normalized.controllerStorePath ?? null,
    created_at: normalized.createdAt,
    // Released readers require root execution/completion/delivery state. Hiding
    // the whole private record also excludes it from legacy mixed/nested summaries.
    // Downgrades may discard these rows, but cannot reinterpret them as public.
    payload_json: JSON.stringify(
      normalized.completionTarget === "parent" ? { parentCompletion: normalized } : normalized,
    ),
  };
}

const recordVersions = new WeakMap<SubagentRunRecord, string>();

export function rememberSubagentRunVersion(entry: SubagentRunRecord, version: string): void {
  recordVersions.set(entry, version);
}

export function subagentRunRecordVersion(entry: SubagentRunRecord | undefined): string | null {
  return entry
    ? (recordVersions.get(entry) ?? subagentRunRowVersion(bindSubagentRunRecord(entry)))
    : null;
}

export function parseSubagentRegistryWriteReceipt(
  value: unknown,
  write: SubagentRegistryWrite,
): SubagentRegistryWriteReceipt {
  if (!isRecord(value) || value.writeId !== write.writeId) {
    throw new Error("Registry acknowledgement identifies another write");
  }
  if (
    Array.isArray(value.conflictRunIds) &&
    value.conflictRunIds.every((id) => typeof id === "string")
  ) {
    return { writeId: write.writeId, conflictRunIds: value.conflictRunIds };
  }
  if (!(value.versions instanceof Map) || !Array.isArray(value.notices)) {
    throw new Error("Registry acknowledgement is missing commit facts");
  }
  const versions = new Map<string, string | null>();
  for (const [id, version] of value.versions) {
    if (typeof id !== "string" || (version !== null && typeof version !== "string")) {
      throw new Error("Registry acknowledgement has an invalid row version");
    }
    versions.set(id, version);
  }
  const ids = [...write.values.map((row) => row.run_id), ...write.deleteRunIds];
  if (versions.size !== ids.length || ids.some((id) => !versions.has(id))) {
    throw new Error("Registry acknowledgement does not cover its written rows");
  }
  const notices = value.notices.map((notice): SessionStateNotice => {
    if (
      !isRecord(notice) ||
      typeof notice.watcherSessionKey !== "string" ||
      (notice.watcherStorePath !== null && typeof notice.watcherStorePath !== "string") ||
      typeof notice.targetSessionKey !== "string" ||
      typeof notice.lastSeenSequence !== "number" ||
      typeof notice.queueOnly !== "boolean"
    ) {
      throw new Error("Registry acknowledgement has an invalid terminal notice");
    }
    return {
      watcherSessionKey: notice.watcherSessionKey,
      watcherStorePath: notice.watcherStorePath,
      targetSessionKey: notice.targetSessionKey,
      lastSeenSequence: notice.lastSeenSequence,
      queueOnly: notice.queueOnly,
    };
  });
  return { writeId: write.writeId, versions, notices };
}
