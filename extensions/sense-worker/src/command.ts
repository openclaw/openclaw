import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getSenseJobStatus } from "./client.js";
import { readLatestNemoClawDigestCache } from "./latest-digest-cache.js";
import { formatSlackDigestNotification } from "./slack-digest.js";

function normalizeArgs(value: string | undefined): string {
  return value?.trim().toLowerCase() || "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveSenseWorkerConfig(config: OpenClawConfig | undefined) {
  const plugins = asRecord(config?.plugins);
  const entries = asRecord(plugins?.entries);
  const senseWorker = asRecord(entries?.["sense-worker"]);
  const pluginConfig = asRecord(senseWorker?.config);
  return {
    baseUrl: typeof pluginConfig?.baseUrl === "string" ? pluginConfig.baseUrl : undefined,
    timeoutMs: typeof pluginConfig?.timeoutMs === "number" ? pluginConfig.timeoutMs : undefined,
    token: typeof pluginConfig?.token === "string" ? pluginConfig.token : undefined,
    tokenEnv: typeof pluginConfig?.tokenEnv === "string" ? pluginConfig.tokenEnv : undefined,
  };
}

function formatJobSummary(params: { jobId: string; body: unknown }): string {
  const record = asRecord(params.body);
  if (record?.error === "job_not_found") {
    return `job ${params.jobId}\nstatus=job_not_found`;
  }
  const status = typeof record?.status === "string" ? record.status : "unknown";
  const result = asRecord(record?.result);
  const lines = [`job ${params.jobId}`, `status=${status}`];
  if (typeof result?.exit_code === "number") {
    lines.push(`exit_code=${result.exit_code}`);
  }
  if (typeof result?.error === "string" && result.error.trim()) {
    lines.push(`error=${result.error.trim()}`);
  }
  if (typeof result?.summary === "string" && result.summary.trim()) {
    lines.push(`summary=${result.summary.trim()}`);
  }
  return lines.join("\n");
}

export async function handleNemoClawCommand(
  args: string | undefined,
  config?: OpenClawConfig,
): Promise<{ text: string }> {
  const normalized = normalizeArgs(args);
  if (!normalized || normalized === "digest") {
    const latest = await readLatestNemoClawDigestCache();
    const text = formatSlackDigestNotification(latest ?? undefined);
    if (text) {
      return { text };
    }
    return { text: "No notification_digest_summary available." };
  }
  if (normalized === "job") {
    return { text: "Usage: /nemoclaw job <id>" };
  }
  if (normalized.startsWith("job ")) {
    const jobId = args?.trim().slice(4).trim() || "";
    if (!jobId) {
      return { text: "Usage: /nemoclaw job <id>" };
    }
    const result = await getSenseJobStatus(jobId, resolveSenseWorkerConfig(config));
    const digestText = formatSlackDigestNotification(result.body);
    if (digestText) {
      return { text: digestText };
    }
    return { text: formatJobSummary({ jobId, body: result.body }) };
  }
  return { text: "Usage: /nemoclaw digest\nUsage: /nemoclaw job <id>" };
}
