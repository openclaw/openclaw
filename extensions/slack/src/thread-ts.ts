import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const SLACK_THREAD_TS_PATTERN = /^\d+\.\d+$/;

export function normalizeSlackThreadTsCandidate(
  value?: string | number | null,
): string | undefined {
  const normalized =
    typeof value === "number"
      ? normalizeOptionalString(String(value))
      : normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return SLACK_THREAD_TS_PATTERN.test(normalized) ? normalized : undefined;
}

export function resolveSlackThreadTsValue(params: {
  replyToId?: string | number | null;
  threadId?: string | number | null;
}): string | undefined {
  return (
    normalizeSlackThreadTsCandidate(params.replyToId) ??
    (params.threadId != null ? normalizeOptionalString(String(params.threadId)) : undefined)
  );
}
