import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function assertFeishuApiSuccess(
  response: { code?: number; msg?: string },
  errorPrefix?: string,
): void {
  if (response.code !== 0) {
    throw new Error(
      errorPrefix === undefined
        ? response.msg
        : `${errorPrefix}: ${response.msg || `code ${response.code}`}`,
      { cause: { code: response.code } },
    );
  }
}

export function isFeishuMessageAuditRejection(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!isRecord(current) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const response = isRecord(current.response) ? current.response : undefined;
    const data = isRecord(response?.data) ? response.data : undefined;
    if (current.code === 230028 || data?.code === 230028) {
      return true;
    }
    pending.push(current.cause);
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return false;
}
