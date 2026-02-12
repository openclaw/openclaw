const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;

export function resolveApprovalRunningNoticeMs(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function resolveApprovalTimeoutMs(valueSec?: number): number {
  if (typeof valueSec !== "number" || !Number.isFinite(valueSec) || valueSec <= 0) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  return Math.floor(valueSec) * 1000;
}
