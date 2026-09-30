import type { WorkboardHandoff } from "@openclaw/workboard-contract";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const HANDOFF_GATES = ["not-required", "pending", "approved"] as const;
const DELIVERY_STATUSES = ["not-requested", "pending", "delivered", "failed", "empty"] as const;

function bounded(value: unknown, fallback: string | undefined, max: number, field: string) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > max) {
    throw new Error(`${field} must be ${max} characters or fewer.`);
  }
  return normalized;
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback?: T) {
  return typeof value === "string"
    ? (allowed.find((candidate) => candidate === value) ?? fallback)
    : fallback;
}

export function normalizeHandoff(
  value: unknown,
  fallback?: WorkboardHandoff,
): WorkboardHandoff | undefined {
  if (!isRecord(value)) {
    return fallback;
  }
  const summary = bounded(value.summary, fallback?.summary, 2000, "handoff summary");
  const updatedAt = timestamp(value.updatedAt, fallback?.updatedAt ?? 0);
  if (!summary || !updatedAt) {
    return fallback;
  }
  const needsUser = bounded(value.needsUser, fallback?.needsUser, 1000, "handoff needs user");
  const previewUrl = bounded(value.previewUrl, fallback?.previewUrl, 2000, "handoff preview URL");
  const verifiedAt = timestamp(value.verifiedAt, fallback?.verifiedAt ?? 0) || undefined;
  const approval = enumValue(value.approval, HANDOFF_GATES, fallback?.approval);
  const uat = enumValue(value.uat, HANDOFF_GATES, fallback?.uat);
  const deliveryStatus = enumValue(
    value.deliveryStatus,
    DELIVERY_STATUSES,
    fallback?.deliveryStatus,
  );
  const deliveryReceipt = bounded(
    value.deliveryReceipt,
    fallback?.deliveryReceipt,
    500,
    "handoff delivery receipt",
  );
  return {
    summary,
    updatedAt,
    ...(needsUser ? { needsUser } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(approval ? { approval } : {}),
    ...(uat ? { uat } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(deliveryReceipt ? { deliveryReceipt } : {}),
  };
}
