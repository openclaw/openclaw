import { randomUUID } from "node:crypto";
import { WORKBOARD_PROOF_STATUSES, type WorkboardProof } from "@openclaw/workboard-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { definedFields } from "../record-fields.js";
import type { WorkboardProofInput } from "./store-inputs.js";
import {
  normalizeBoundedString,
  normalizeEnumValue,
  normalizeTimestamp,
} from "./store-normalizer-primitives.js";

export function normalizeProof(
  record: Record<string, unknown>,
  stored?: readonly WorkboardProof[],
): WorkboardProof | null {
  const id = normalizeOptionalString(record.id);
  const createdAt = normalizeTimestamp(record.createdAt, 0);
  if (!id || !createdAt) {
    return null;
  }
  return normalizeProofInput(
    record,
    createdAt,
    id,
    stored?.find((proof) => proof.id === id),
  );
}

export function normalizeProofInput(
  input: WorkboardProofInput,
  now: number,
  id?: string,
  stored?: Pick<WorkboardProof, "note">,
): WorkboardProof {
  const label = normalizeBoundedString(input.label, undefined, 160, "proof label");
  const command = normalizeBoundedString(input.command, undefined, 1000, "proof command");
  const url = normalizeBoundedString(input.url, undefined, 2000, "proof URL");
  // Lifecycle updates must preserve stored text; only new or edited notes need validation.
  const note =
    typeof input.note === "string" && stored?.note === input.note
      ? input.note
      : normalizeBoundedString(input.note, undefined, 2000, "proof note");
  return definedFields({
    id: id ?? randomUUID(),
    status: normalizeEnumValue(input.status, WORKBOARD_PROOF_STATUSES, "unknown"),
    createdAt: now,
    label,
    command,
    url,
    note,
  });
}
