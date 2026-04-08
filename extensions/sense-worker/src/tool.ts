import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { callSense, checkSenseHealth, getSenseJobStatus } from "./client.js";

type SensePluginConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  token?: string;
  tokenEnv?: string;
};

function normalizeTimeout(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function summarizeNotificationDigestBody(body: unknown): string | undefined {
  const record = asRecord(body);
  const digestSummary = Array.isArray(record?.notification_digest_summary)
    ? record.notification_digest_summary
    : undefined;
  if (!digestSummary || digestSummary.length === 0) {
    return undefined;
  }

  const firstItem = asRecord(digestSummary[0]);
  if (!firstItem) {
    return undefined;
  }

  const layouts = asRecord(firstItem.digest_bucket_ui_layouts);
  const meta = asRecord(layouts?.meta);
  const summary = asRecord(meta?.summary_parts);
  const display = asRecord(summary?.display);
  const badge = asRecord(display?.badge) ?? asRecord(meta?.badge_parts);
  const leader = asRecord(display?.leader) ?? asRecord(meta?.leader_parts);
  const percent =
    typeof summary?.percent === "string"
      ? summary.percent
      : typeof meta?.percent === "string"
        ? meta.percent
        : typeof firstItem.digest_bucket_percent === "string"
          ? firstItem.digest_bucket_percent
          : "0.0%";
  const share =
    typeof summary?.share === "number"
      ? summary.share
      : typeof meta?.share === "number"
        ? meta.share
        : typeof firstItem.digest_bucket_share === "number"
          ? firstItem.digest_bucket_share
          : undefined;
  const title =
    typeof firstItem.digest_title === "string"
      ? firstItem.digest_title
      : typeof firstItem.notification_title_short === "string"
        ? firstItem.notification_title_short
        : typeof firstItem.notification_group_key === "string"
          ? firstItem.notification_group_key
          : "Digest summary";
  const badgeShort =
    typeof badge?.short === "string"
      ? badge.short
      : typeof firstItem.digest_bucket_badge_short === "string"
        ? firstItem.digest_bucket_badge_short
        : "UNK";
  const leaderCompact =
    typeof leader?.compact === "string"
      ? leader.compact
      : typeof meta?.leader_compact === "string"
        ? meta.leader_compact
        : typeof leader?.label === "string"
          ? leader.label
          : typeof meta?.leader_label === "string"
            ? meta.leader_label
            : "Follower";

  const preview = `${title} | ${badgeShort} | ${percent} | ${leaderCompact}`;
  if (typeof share !== "number") {
    return digestSummary.length > 1 ? `${preview} (+${digestSummary.length - 1} more)` : preview;
  }
  const sharePreview = `${preview} | share=${share}`;
  return digestSummary.length > 1
    ? `${sharePreview} (+${digestSummary.length - 1} more)`
    : sharePreview;
}

function summarizeBody(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const digestSummary = summarizeNotificationDigestBody(body);
    if (digestSummary) {
      return digestSummary;
    }
    if (typeof record.result === "string" && record.result.trim()) {
      return record.result.trim();
    }
    if (typeof record.status === "string" && record.status.trim()) {
      return `Sense worker status: ${record.status.trim()}`;
    }
  }
  return JSON.stringify(body, null, 2);
}

function summarizeJobDetails(details: { job?: Record<string, unknown>; body: unknown }): string {
  const job = details.job;
  if (job && typeof job.job_id === "string") {
    const parts = [`Sense worker job ${job.job_id}`];
    if (typeof job.status === "string" && job.status.trim()) {
      parts.push(`status=${job.status.trim()}`);
    }
    if (typeof job.target === "string" && job.target.trim()) {
      parts.push(`target=${job.target.trim()}`);
    }
    if (typeof job.stage === "string" && job.stage.trim()) {
      parts.push(`stage=${job.stage.trim()}`);
    }
    if (typeof job.message === "string" && job.message.trim()) {
      parts.push(`message=${job.message.trim()}`);
    }
    return parts.join(" | ");
  }
  return summarizeBody(details.body);
}

async function pollSenseJob(params: {
  jobId: string;
  baseUrl?: string;
  timeoutMs: number;
  token?: string;
  tokenEnv?: string;
  logger: OpenClawPluginApi["logger"];
  intervalMs: number;
  maxPolls: number;
}) {
  let attempts = 0;
  let latest = await getSenseJobStatus(params.jobId, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    token: params.token,
    tokenEnv: params.tokenEnv,
    logger: params.logger,
  });

  while (attempts < params.maxPolls) {
    attempts += 1;
    const status = latest.job?.status;
    if (!latest.ok || status === "done" || status === "job_not_found") {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, params.intervalMs));
    latest = await getSenseJobStatus(params.jobId, {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      token: params.token,
      tokenEnv: params.tokenEnv,
      logger: params.logger,
    });
  }

  return latest;
}

export function createSenseWorkerTool(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as SensePluginConfig;
  const baseUrl = pluginConfig.baseUrl?.trim() || undefined;
  const timeoutMs = normalizeTimeout(pluginConfig.timeoutMs, 5_000);
  const token = pluginConfig.token?.trim() || undefined;
  const tokenEnv = pluginConfig.tokenEnv?.trim() || undefined;

  return {
    name: "sense-worker",
    label: "Sense Worker",
    description:
      "Call the Sense worker node over LAN. For liveness checks, use action=health and do not invent execute tasks like healthcheck. Use action=execute only for real remote tasks such as summarize, generate_draft, or heavy async NemoClaw jobs.",
    parameters: Type.Object({
      action: Type.Unsafe<"health" | "execute" | "job_status" | "job_poll">({
        type: "string",
        enum: ["health", "execute", "job_status", "job_poll"],
        description:
          "Choose health for worker liveness, execute for remote tasks, and job_status/job_poll for async NemoClaw jobs.",
      }),
      task: Type.Optional(
        Type.String({
          description:
            "Remote task name for execute only, e.g. summarize or generate_draft. Do not use task=healthcheck; use action=health instead.",
        }),
      ),
      jobId: Type.Optional(
        Type.String({
          description: "Sense async job id for job_status or job_poll.",
        }),
      ),
      input: Type.Optional(Type.String({ description: "Task input text for the Sense worker." })),
      params: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "JSON object forwarded to the Sense worker as params.",
        }),
      ),
      intervalMs: Type.Optional(
        Type.Number({ description: "Polling interval for job_poll in milliseconds." }),
      ),
      maxPolls: Type.Optional(
        Type.Number({
          description: "Maximum polls for job_poll before returning the latest status.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Per-request timeout override in milliseconds." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action : "";
      const requestTimeoutMs = normalizeTimeout(params.timeoutMs, timeoutMs);
      if (action === "health") {
        const result = await checkSenseHealth({
          baseUrl,
          timeoutMs: requestTimeoutMs,
          token,
          tokenEnv,
          logger: api.logger,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
          details: result,
        };
      }
      if (action === "job_status" || action === "job_poll") {
        const jobId = typeof params.jobId === "string" ? params.jobId.trim() : "";
        if (!jobId) {
          throw new Error("jobId required for job_status or job_poll");
        }
        const intervalMs = normalizeTimeout(params.intervalMs, 1_000);
        const maxPolls = normalizeTimeout(params.maxPolls, 30);
        const result =
          action === "job_poll"
            ? await pollSenseJob({
                jobId,
                baseUrl,
                timeoutMs: requestTimeoutMs,
                token,
                tokenEnv,
                logger: api.logger,
                intervalMs,
                maxPolls,
              })
            : await getSenseJobStatus(jobId, {
                baseUrl,
                timeoutMs: requestTimeoutMs,
                token,
                tokenEnv,
                logger: api.logger,
              });
        return {
          content: [{ type: "text", text: summarizeJobDetails(result) }],
          details: result,
        };
      }
      if (action !== "execute") {
        throw new Error("action must be health, execute, job_status, or job_poll");
      }
      const task = typeof params.task === "string" ? params.task.trim() : "";
      const input = typeof params.input === "string" ? params.input : "";
      if ((task === "health" || task === "healthcheck") && !input.trim()) {
        const result = await checkSenseHealth({
          baseUrl,
          timeoutMs: requestTimeoutMs,
          token,
          tokenEnv,
          logger: api.logger,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
          details: result,
        };
      }
      const forwardParams =
        params.params && typeof params.params === "object" && !Array.isArray(params.params)
          ? (params.params as Record<string, unknown>)
          : {};
      const result = await callSense(task, input, forwardParams, {
        baseUrl,
        timeoutMs: requestTimeoutMs,
        token,
        tokenEnv,
        logger: api.logger,
      });
      return {
        content: [{ type: "text", text: summarizeJobDetails(result) }],
        details: result,
      };
    },
  };
}

export function createSenseWorkerHealthTool(api: OpenClawPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as SensePluginConfig;
  const baseUrl = pluginConfig.baseUrl?.trim() || undefined;
  const timeoutMs = normalizeTimeout(pluginConfig.timeoutMs, 5_000);
  const token = pluginConfig.token?.trim() || undefined;
  const tokenEnv = pluginConfig.tokenEnv?.trim() || undefined;

  return {
    name: "sense-worker-health",
    label: "Sense Worker Health",
    description:
      "Check Sense worker liveness over LAN. Use this tool for health checks instead of sense-worker action=health.",
    parameters: Type.Object({}),
    async execute() {
      const result = await checkSenseHealth({
        baseUrl,
        timeoutMs,
        token,
        tokenEnv,
        logger: api.logger,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.body, null, 2) }],
        details: result,
      };
    },
  };
}
