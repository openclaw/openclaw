import type { WorkboardChange } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function isOptionalRevision(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  );
}

export function normalizeWorkboardChange(payload: unknown): WorkboardChange | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { epoch, revision, cardsRevision, sessionsRevision } = payload;
  const keys = Object.keys(payload);
  return keys.every((key) =>
    ["epoch", "revision", "cardsRevision", "sessionsRevision"].includes(key),
  ) &&
    isOptionalRevision(cardsRevision) &&
    isOptionalRevision(sessionsRevision) &&
    typeof epoch === "string" &&
    epoch.length > 0 &&
    epoch.length <= 128 &&
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? { epoch, revision, cardsRevision, sessionsRevision }
    : null;
}
