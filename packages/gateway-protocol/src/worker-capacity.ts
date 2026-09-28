import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const NODE_WORKER_CAPACITY_MAX = 1_024;

export function parseWorkerCapacity(value: unknown): { total: number; available: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const { total, available } = value;
  return keys.length === 2 &&
    keys.includes("total") &&
    keys.includes("available") &&
    typeof total === "number" &&
    typeof available === "number" &&
    Number.isSafeInteger(total) &&
    Number.isSafeInteger(available) &&
    total >= 1 &&
    total <= NODE_WORKER_CAPACITY_MAX &&
    available >= 0 &&
    available <= total
    ? { total, available }
    : null;
}
