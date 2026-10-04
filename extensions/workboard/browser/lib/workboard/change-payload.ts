import type { WorkboardChange } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeWorkboardChange(payload: unknown): WorkboardChange | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { epoch, revision, cardsRevision } = payload;
  const keys = Object.keys(payload);
  return keys.every((key) => key === "epoch" || key === "revision" || key === "cardsRevision") &&
    (cardsRevision === undefined ||
      (typeof cardsRevision === "number" &&
        Number.isSafeInteger(cardsRevision) &&
        cardsRevision > 0)) &&
    typeof epoch === "string" &&
    epoch.length > 0 &&
    epoch.length <= 128 &&
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? { epoch, revision, cardsRevision }
    : null;
}
