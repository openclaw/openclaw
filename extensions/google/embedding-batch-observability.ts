import { createHash } from "node:crypto";

export type GeminiBatchStats = {
  requestCount?: number | string;
  successfulRequestCount?: number | string;
  failedRequestCount?: number | string;
  pendingRequestCount?: number | string;
};

export type GeminiBatchOperation = {
  name?: string;
  done?: boolean;
  state?: string;
  createTime?: string;
  updateTime?: string;
  endTime?: string;
  batchStats?: GeminiBatchStats;
  output?: {
    responsesFile?: string;
  };
  metadata?: {
    state?: string;
    createTime?: string;
    updateTime?: string;
    endTime?: string;
    batchStats?: GeminiBatchStats;
    output?: {
      responsesFile?: string;
    };
  };
  response?: { responsesFile?: string };
  error?: { code?: number; message?: string };
};

export type GeminiBatchState =
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export type GeminiBatchLifecycleContext = {
  batchName: string;
  group: number;
  groups: number;
  submittedRequests: number;
  startedAtMs: number;
};

function readGeminiBatchCount(value: number | string | undefined): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readGeminiBatchTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatGeminiBatchNameForLog(batchName: string): string {
  return /^batches\/[A-Za-z0-9._~-]{1,200}$/.test(batchName)
    ? batchName
    : `sha256:${createHash("sha256").update(batchName).digest("hex").slice(0, 16)}`;
}

function getGeminiBatchLifecycleFields(operation: GeminiBatchOperation): Record<string, unknown> {
  const metadata = operation.metadata;
  const createTime = readGeminiBatchTimestamp(operation.createTime ?? metadata?.createTime);
  const updateTime = readGeminiBatchTimestamp(operation.updateTime ?? metadata?.updateTime);
  const endTime = readGeminiBatchTimestamp(operation.endTime ?? metadata?.endTime);
  const stats = operation.batchStats ?? metadata?.batchStats;
  const requestCount = readGeminiBatchCount(stats?.requestCount);
  const successfulRequestCount = readGeminiBatchCount(stats?.successfulRequestCount);
  const failedRequestCount = readGeminiBatchCount(stats?.failedRequestCount);
  const pendingRequestCount = readGeminiBatchCount(stats?.pendingRequestCount);
  return {
    ...(createTime !== undefined ? { providerCreateTime: new Date(createTime).toISOString() } : {}),
    ...(updateTime !== undefined ? { providerUpdateTime: new Date(updateTime).toISOString() } : {}),
    ...(endTime !== undefined ? { providerEndTime: new Date(endTime).toISOString() } : {}),
    ...(requestCount !== undefined ? { providerRequestCount: requestCount } : {}),
    ...(successfulRequestCount !== undefined
      ? { providerSuccessfulRequests: successfulRequestCount }
      : {}),
    ...(failedRequestCount !== undefined ? { providerFailedRequests: failedRequestCount } : {}),
    ...(pendingRequestCount !== undefined ? { providerPendingRequests: pendingRequestCount } : {}),
  };
}

function getGeminiBatchTimingFields(
  operation: GeminiBatchOperation,
  startedAtMs: number,
): Record<string, number> {
  const createTime = readGeminiBatchTimestamp(
    operation.createTime ?? operation.metadata?.createTime,
  );
  const endTime = readGeminiBatchTimestamp(operation.endTime ?? operation.metadata?.endTime);
  return {
    observedElapsedMs: Math.max(0, Date.now() - startedAtMs),
    ...(createTime !== undefined && endTime !== undefined && endTime >= createTime
      ? { providerElapsedMs: endTime - createTime }
      : {}),
  };
}

export function getGeminiBatchOutputFailureFields(error: unknown): Record<string, unknown> {
  if (error && typeof error === "object") {
    // SAFETY: the object guard above permits bounded inspection of optional error fields.
    const candidate = error as { status?: unknown; statusCode?: unknown; name?: unknown };
    const status = candidate.status ?? candidate.statusCode;
    if (typeof status === "number" && Number.isInteger(status)) {
      return { failureKind: "http", providerStatus: status };
    }
    if (candidate.name === "AbortError") {
      return { failureKind: "aborted" };
    }
    if (candidate.name === "TimeoutError" || candidate.name === "RequestTimeoutError") {
      return { failureKind: "timeout" };
    }
  }
  return { failureKind: "transport-or-parse" };
}

export function getGeminiBatchState(operation: GeminiBatchOperation): GeminiBatchState {
  // REST discovery uses BATCH_STATE_* while the public guide and SDK expose
  // JOB_STATE_* for the same operation metadata.
  const rawState = (operation.state ?? operation.metadata?.state)?.replace(
    /^(?:BATCH|JOB)_STATE_/,
    "",
  );
  if (rawState === "FAILED") {
    return "failed";
  }
  if (rawState === "CANCELLED" || rawState === "CANCELED") {
    return "cancelled";
  }
  if (rawState === "EXPIRED") {
    return "expired";
  }
  if (operation.error) {
    return "failed";
  }
  if (operation.done === false) {
    return "pending";
  }
  if (operation.done === true) {
    return "succeeded";
  }
  if (rawState === "SUCCEEDED") {
    return "succeeded";
  }
  if (rawState === "PENDING" || rawState === "RUNNING") {
    return "pending";
  }
  return "unknown";
}

export function buildGeminiBatchLifecycleLog(
  context: GeminiBatchLifecycleContext,
  operation: GeminiBatchOperation,
  state = getGeminiBatchState(operation),
): Record<string, unknown> {
  return {
    batchName: formatGeminiBatchNameForLog(context.batchName),
    state,
    group: context.group,
    groups: context.groups,
    submittedRequests: context.submittedRequests,
    ...getGeminiBatchLifecycleFields(operation),
    ...getGeminiBatchTimingFields(operation, context.startedAtMs),
  };
}
