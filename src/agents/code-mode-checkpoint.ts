import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { cloneTranscriptEnvelope } from "../config/sessions/transcript-json.js";
import { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME } from "./code-mode-control-tools.js";
import {
  attachInternalToolResultProvenance,
  getInternalToolResultProvenance,
} from "./runtime/internal-hooks.js";

type CodeModeCheckpoint =
  | { status: "completed" | "failed"; replaySafe: boolean }
  | { status: "waiting"; replaySafe: boolean; runId: string };
type OwnedCheckpoint = { toolCallId: string; toolName: string; checkpoint: CodeModeCheckpoint };
type PendingCheckpoint = {
  toolCallId: unknown;
  toolName: string | undefined;
  checkpoint: CodeModeCheckpoint | null;
};

// Reuse the loop's private provenance identity so hooks cannot mint facts by
// returning matching text/details, and normal result copies retain the owner.
const checkpoints = new WeakMap<object, OwnedCheckpoint>();
const pendingCheckpoints = new WeakMap<object, PendingCheckpoint>();

export function markCodeModeCheckpoint<T extends object>(
  result: T,
  toolCallId: string,
  toolName: string,
  payload:
    | { status: "completed" | "failed"; replaySafe?: boolean }
    | { status: "waiting"; replaySafe?: boolean; runId: string },
): T {
  const checkpoint: CodeModeCheckpoint =
    payload.status === "waiting"
      ? { status: "waiting", replaySafe: payload.replaySafe === true, runId: payload.runId }
      : { status: payload.status, replaySafe: payload.replaySafe === true };
  const provenance = getInternalToolResultProvenance(result) ?? {};
  checkpoints.set(provenance, { toolCallId, toolName, checkpoint });
  return attachInternalToolResultProvenance(result, provenance);
}

/** Retain the original producer fact across hook serialization, without exposing it to hooks. */
export function prepareCodeModeCheckpoint<T extends object>(message: T, source: object): T {
  const record = asOptionalObjectRecord(message);
  const toolName = normalizeOptionalString(record?.toolName);
  const provenance = getInternalToolResultProvenance(source);
  const owned = provenance ? checkpoints.get(provenance) : undefined;
  pendingCheckpoints.set(message, {
    toolCallId: record?.toolCallId,
    toolName,
    checkpoint:
      record?.role === "toolResult" &&
      owned !== undefined &&
      owned.toolCallId === record.toolCallId &&
      owned.toolName === toolName
        ? owned.checkpoint
        : null,
  });
  return message;
}

/** Stamp the canonical JSON shape; hook-provided toJSON cannot replace this fact. */
export function persistCodeModeCheckpoint<T extends object>(message: T, source: object): T {
  const pending = pendingCheckpoints.get(source);
  if (!pending) {
    // Imports and branch copies keep their already-persisted facts, including legacy text-only data.
    return message;
  }
  const record = asOptionalObjectRecord(message);
  const toolName = normalizeOptionalString(record?.toolName);
  if (
    record?.role !== "toolResult" ||
    (toolName !== CODE_MODE_EXEC_TOOL_NAME && toolName !== CODE_MODE_WAIT_TOOL_NAME)
  ) {
    return message;
  }
  const checkpoint =
    pending.toolCallId === record.toolCallId && pending.toolName === toolName
      ? pending.checkpoint
      : null;
  const metadata = asOptionalObjectRecord(Reflect.get(message, "__openclaw"));
  // Explicit null distinguishes current unowned/shell results from old transcripts.
  const stamped = cloneTranscriptEnvelope(message);
  return Object.assign(stamped, { __openclaw: { ...metadata, codeModeCheckpoint: checkpoint } });
}

export function readCodeModeCheckpointFact(value: unknown): CodeModeCheckpoint | undefined {
  const record = asOptionalObjectRecord(value);
  if (!record || typeof record.replaySafe !== "boolean") {
    return undefined;
  }
  if (record.status === "completed" || record.status === "failed") {
    return { status: record.status, replaySafe: record.replaySafe };
  }
  const runId = normalizeOptionalString(record.runId);
  return record.status === "waiting" && runId
    ? { status: "waiting", replaySafe: record.replaySafe, runId }
    : undefined;
}
