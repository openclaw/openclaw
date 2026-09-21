import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { BoundSubagentRunRecord } from "./subagent-registry.store.kernel.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type SubagentRunsTable = OpenClawStateKyselyDatabase["subagent_runs"];
export type SubagentRunSqliteRow = Selectable<SubagentRunsTable>;
type CanonicalSubagentRunRecord = SubagentRunRecord &
  Required<Pick<SubagentRunRecord, "completion" | "delivery">>;
const EXECUTION_STATUSES = new Set("queued running interrupted terminal".split(" "));
export const DELIVERY_STATUSES = new Set(
  "not_required pending in_progress delivered failed suspended discarded".split(" "),
);

function hasStateStatus(
  value: unknown,
  statuses: ReadonlySet<string>,
): value is Record<string, unknown> {
  return isRecord(value) && typeof value.status === "string" && statuses.has(value.status);
}

function isCanonicalSubagentRunRecord(value: unknown): value is CanonicalSubagentRunRecord {
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

function parseJson(raw: string | null): unknown {
  return raw ? safeParseJson(raw) : undefined;
}

/** Rehydrates one sqlite row into the normalized subagent run record shape. */
export function rowToSubagentRunRecord(row: SubagentRunSqliteRow): SubagentRunRecord | null {
  const stored = parseJson(row.payload_json);
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
  return record.runId && record.childSessionKey && record.requesterSessionKey ? record : null;
}

/** Canonically serializes a run before an outer transaction acquires the write lock. */
export function bindSubagentRunRecord(entry: SubagentRunRecord): BoundSubagentRunRecord {
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
