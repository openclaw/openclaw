import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { getRecentSenseJobRefs, getSenseJobStatus } from "./client.js";
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

function shortenText(value: string | undefined, maxLength = 96): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}...` : trimmed;
}

function formatRecentDigestLine(body: unknown): string | undefined {
  const digestText = formatSlackDigestNotification(body);
  if (!digestText) {
    return undefined;
  }
  return shortenText(digestText.split(/\r?\n/).join(" | "), 120);
}

function formatRecentFallbackLine(body: unknown): string | undefined {
  const record = asRecord(body);
  const result = asRecord(record?.result);
  const errorText = typeof result?.error === "string" ? shortenText(result.error, 120) : undefined;
  if (errorText) {
    return `error=${errorText}`;
  }
  const summaryText =
    typeof result?.summary === "string" ? shortenText(result.summary, 120) : undefined;
  if (summaryText) {
    return summaryText;
  }
  return undefined;
}

function formatRecentHeader(params: { index: number; jobId: string; body: unknown }): string {
  const record = asRecord(params.body);
  const result = asRecord(record?.result);
  const status = typeof record?.status === "string" ? record.status : "unknown";
  const exitCode = typeof result?.exit_code === "number" ? ` exit=${String(result.exit_code)}` : "";
  const shortJobId = params.jobId.length > 8 ? `${params.jobId.slice(0, 8)}...` : params.jobId;
  return `${params.index}) ${shortJobId} ${status}${exitCode}`;
}

async function formatRecentJobs(config: OpenClawConfig | undefined): Promise<string> {
  const refs = await getRecentSenseJobRefs(3);
  if (!refs.length) {
    return "No recent jobs.";
  }
  const lines = ["recent jobs"];
  let index = 1;
  for (const ref of refs) {
    const result = await getSenseJobStatus(ref.jobId, resolveSenseWorkerConfig(config));
    lines.push(formatRecentHeader({ index, jobId: ref.jobId, body: result.body }));
    lines.push(
      `   ${formatRecentDigestLine(result.body) ?? formatRecentFallbackLine(result.body) ?? "status only"}`,
    );
    lines.push("");
    index += 1;
  }
  return lines.join("\n").trimEnd();
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
  if (normalized === "recent") {
    return { text: await formatRecentJobs(config) };
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
  return { text: "Usage: /nemoclaw digest\nUsage: /nemoclaw recent\nUsage: /nemoclaw job <id>" };
}
