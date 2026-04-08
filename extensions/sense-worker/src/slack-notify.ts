import { formatSlackDigestNotification } from "./slack-digest.js";

export type NemoClawSlackEvent = "job_done" | "job_failed" | "digest_ready";

type SenseWorkerSlackConfig = {
  slackNotifyTo?: string;
  slackNotifyAccountId?: string;
  slackNotifyEvents?: unknown;
};

type NotificationParams = {
  cfg: Record<string, unknown>;
  event: NemoClawSlackEvent;
  jobId?: string;
  payload: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSenseWorkerSlackConfig(cfg: Record<string, unknown>): SenseWorkerSlackConfig {
  const plugins = asRecord(cfg.plugins);
  const entries = asRecord(plugins?.entries);
  const senseWorker = asRecord(entries?.["sense-worker"]);
  const config = asRecord(senseWorker?.config);
  return {
    slackNotifyTo:
      typeof config?.slackNotifyTo === "string" ? config.slackNotifyTo.trim() : undefined,
    slackNotifyAccountId:
      typeof config?.slackNotifyAccountId === "string"
        ? config.slackNotifyAccountId.trim()
        : undefined,
    slackNotifyEvents: config?.slackNotifyEvents,
  };
}

function resolveEnabledEvents(value: unknown): Set<NemoClawSlackEvent> {
  const defaults: NemoClawSlackEvent[] = ["job_done", "job_failed", "digest_ready"];
  if (!Array.isArray(value)) {
    return new Set(defaults);
  }
  const filtered = value.filter(
    (entry): entry is NemoClawSlackEvent =>
      entry === "job_done" || entry === "job_failed" || entry === "digest_ready",
  );
  return new Set(filtered.length > 0 ? filtered : defaults);
}

function extractDigestSource(payload: unknown): unknown {
  const record = asRecord(payload);
  if (Array.isArray(record?.notification_digest_summary)) {
    return payload;
  }
  if (record?.result && Array.isArray(asRecord(record.result)?.notification_digest_summary)) {
    return record.result;
  }
  if (
    record?.completion &&
    Array.isArray(asRecord(record.completion)?.notification_digest_summary)
  ) {
    return record.completion;
  }
  return undefined;
}

function extractErrorCode(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const result = asRecord(record?.result);
  const completion = asRecord(record?.completion);
  if (typeof result?.error_code === "string" && result.error_code.trim()) {
    return result.error_code.trim();
  }
  if (typeof completion?.error_code === "string" && completion.error_code.trim()) {
    return completion.error_code.trim();
  }
  if (typeof result?.error === "string" && result.error.trim()) {
    return result.error.trim();
  }
  if (typeof completion?.error === "string" && completion.error.trim()) {
    return completion.error.trim();
  }
  return undefined;
}

function extractSummary(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const result = asRecord(record?.result);
  const completion = asRecord(record?.completion);
  if (typeof result?.summary === "string" && result.summary.trim()) {
    return result.summary.trim();
  }
  if (typeof completion?.summary === "string" && completion.summary.trim()) {
    return completion.summary.trim();
  }
  if (typeof result?.message === "string" && result.message.trim()) {
    return result.message.trim();
  }
  if (typeof completion?.message === "string" && completion.message.trim()) {
    return completion.message.trim();
  }
  return undefined;
}

export function buildNemoClawSlackText(params: {
  event: NemoClawSlackEvent;
  jobId?: string;
  payload: unknown;
}): string {
  const jobSuffix = params.jobId?.trim() ? ` (${params.jobId.trim()})` : "";
  const digestText = formatSlackDigestNotification(extractDigestSource(params.payload));
  const summary = extractSummary(params.payload);
  const errorCode = extractErrorCode(params.payload);

  if (params.event === "digest_ready") {
    if (digestText) {
      return `digest ready${jobSuffix}\n${digestText}`;
    }
    return `digest ready${jobSuffix}`;
  }

  if (params.event === "job_failed") {
    const parts = [`job failed${jobSuffix}`];
    if (errorCode) {
      parts.push(`error=${errorCode}`);
    }
    if (digestText) {
      parts.push(digestText);
      return parts.join("\n");
    }
    if (summary) {
      parts.push(summary);
    }
    return parts.join("\n");
  }

  if (digestText) {
    return `job done${jobSuffix}\n${digestText}`;
  }
  if (summary) {
    return `job done${jobSuffix}\n${summary}`;
  }
  return `job done${jobSuffix}`;
}

export async function sendNemoClawSlackNotification(params: NotificationParams): Promise<{
  delivered: boolean;
  skipped?: string;
  text?: string;
}> {
  const config = readSenseWorkerSlackConfig(params.cfg);
  const target = config.slackNotifyTo?.trim();
  if (!target) {
    return { delivered: false, skipped: "missing_target" };
  }
  const enabledEvents = resolveEnabledEvents(config.slackNotifyEvents);
  if (!enabledEvents.has(params.event)) {
    return { delivered: false, skipped: "event_disabled" };
  }
  const text = buildNemoClawSlackText({
    event: params.event,
    jobId: params.jobId,
    payload: params.payload,
  });
  const { sendMessageSlack } = await import("../../slack/src/send.js");
  await sendMessageSlack(target, text, {
    cfg: params.cfg,
    ...(config.slackNotifyAccountId ? { accountId: config.slackNotifyAccountId } : {}),
  });
  return { delivered: true, text };
}
