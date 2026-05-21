import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export const SLACK_QA_TRACE_PREFIX = "openclaw:slack-qa-trace ";

type SlackQaTraceFields = Record<string, boolean | number | string | undefined>;

function isSlackQaTraceEnabled(): boolean {
  const normalized = process.env.OPENCLAW_QA_SLACK_RTT_TRACE?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function sanitizeSlackQaTraceFields(fields: SlackQaTraceFields | undefined): SlackQaTraceFields {
  const out: SlackQaTraceFields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function recordSlackQaTrace(phase: string, fields?: SlackQaTraceFields): void {
  if (!isSlackQaTraceEnabled()) {
    return;
  }
  const payload = {
    at: new Date().toISOString(),
    phase,
    ...sanitizeSlackQaTraceFields(fields),
  };
  process.stderr.write(`${SLACK_QA_TRACE_PREFIX}${JSON.stringify(payload)}\n`);
}

export async function traceSlackQaPhase<T>(
  phase: string,
  fn: () => Promise<T>,
  fields?: SlackQaTraceFields,
): Promise<T> {
  if (!isSlackQaTraceEnabled()) {
    return await fn();
  }
  const startedAt = Date.now();
  recordSlackQaTrace(`${phase}.start`, fields);
  try {
    const result = await fn();
    recordSlackQaTrace(`${phase}.end`, {
      ...fields,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    recordSlackQaTrace(`${phase}.error`, {
      ...fields,
      durationMs: Date.now() - startedAt,
      error: formatErrorMessage(error),
    });
    throw error;
  }
}
