import type { WorkboardLaunchState } from "@openclaw/workboard-contract";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function text(value: unknown, maxLength: number): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

export function normalizeLaunchState(value: unknown): WorkboardLaunchState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const requestedSessionKey = text(value.requestedSessionKey, 240);
  const provisionalRunId = text(value.provisionalRunId, 160);
  const preparedAt = timestamp(value.preparedAt);
  if (!requestedSessionKey || !provisionalRunId || preparedAt === undefined) {
    return undefined;
  }
  const identity = { requestedSessionKey, provisionalRunId, preparedAt };
  if (value.phase === "prepared") {
    return { phase: "prepared", ...identity };
  }
  if (value.phase === "accepted") {
    const acceptedAt = timestamp(value.acceptedAt);
    const acceptedSessionKey = text(value.acceptedSessionKey, 240);
    const acceptedRunId = text(value.acceptedRunId, 160);
    return acceptedAt === undefined || !acceptedSessionKey
      ? undefined
      : {
          phase: "accepted",
          ...identity,
          acceptedAt,
          acceptedSessionKey,
          ...(acceptedRunId ? { acceptedRunId } : {}),
        };
  }
  if (value.phase === "failed") {
    const failedAt = timestamp(value.failedAt);
    const reason = text(value.reason, 800);
    return failedAt === undefined || !reason
      ? undefined
      : { phase: "failed", ...identity, failedAt, reason };
  }
  return undefined;
}
