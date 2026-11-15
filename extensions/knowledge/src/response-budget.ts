import type { Static } from "typebox";
import type { Summary } from "./inspection-contract.js";

// Leave headroom beneath the host's 4096-node / 256 KiB feature JSON limits.
// Counting rows alone is insufficient: cards contain nested evidence/identity data.
export function withinBudget(value: unknown): boolean {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > 240 * 1024) {
    return false;
  }
  let nodes = 0;
  const visit = (v: unknown): boolean =>
    ++nodes <= 3800 && (v === null || typeof v !== "object" || Object.values(v).every(visit));
  return visit(JSON.parse(json));
}

export function compactSummary<T extends Static<typeof Summary>>(record: T): T {
  const result = { ...record };
  if (result.attributionConfidence) {
    const { level, basis } = result.attributionConfidence;
    result.attributionConfidence = { level, basis };
  }
  return result;
}
