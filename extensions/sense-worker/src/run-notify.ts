import type { OpenClawConfig } from "../../../src/config/config.js";
import { sendMessageSlack } from "../../slack/src/send.js";
import type { RunRecord } from "./run-types.js";

type RunNotifyResult =
  | { delivered: true; text: string }
  | { delivered: false; skipped: "missing_channel_id" };

function formatDurationSeconds(record: RunRecord): string | null {
  const startedAt = record.started_at ?? record.queued_at;
  const doneAt = record.done_at;
  if (!startedAt || !doneAt) {
    return null;
  }
  const durationMs = Date.parse(doneAt) - Date.parse(startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }
  return `${Math.round(durationMs / 1000)}秒`;
}

function buildOfficeRunUrl(runId: string): string | null {
  const baseUrl = process.env.OPENCLAW_OFFICE_URL?.trim();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl.replace(/\/+$/, "")}/runs/${encodeURIComponent(runId)}`;
}

function buildSummaryLines(record: RunRecord): string[] {
  const lines: string[] = [];
  if (record.result?.summary) {
    lines.push(`> ${record.result.summary}`);
  }
  for (const point of record.result?.key_points ?? []) {
    lines.push(`- ${point}`);
  }
  const detailUrl = buildOfficeRunUrl(record.run_id);
  if (detailUrl) {
    lines.push(`詳細: ${detailUrl}`);
  }
  return lines;
}

export function buildRunNotificationText(record: RunRecord): string {
  const duration = formatDurationSeconds(record);
  if (record.status === "done") {
    const lines = [`:white_check_mark: 完了 - ${record.run_id}`];
    lines.push(
      duration ? `タスク: ${record.kind} | 実行時間: ${duration}` : `タスク: ${record.kind}`,
    );
    lines.push(...buildSummaryLines(record));
    return lines.join("\n");
  }

  const lines = [`:x: 失敗 - ${record.run_id}`];
  const errorMessage = record.error?.message ?? record.result?.summary ?? "実行が失敗しました";
  lines.push(`エラー: ${errorMessage}`);
  if (record.result?.summary && record.result.summary !== errorMessage) {
    lines.push(`> ${record.result.summary}`);
  }
  const detailUrl = buildOfficeRunUrl(record.run_id);
  if (detailUrl) {
    lines.push(`詳細: ${detailUrl}`);
  }
  return lines.join("\n");
}

export async function notifyRunCompletion(params: {
  record: RunRecord;
  config?: OpenClawConfig;
}): Promise<RunNotifyResult> {
  if (!params.record.channel_id) {
    return { delivered: false, skipped: "missing_channel_id" };
  }
  const text = buildRunNotificationText(params.record);
  await sendMessageSlack(params.record.channel_id, text, {
    cfg: params.config,
    ...(params.record.slack_ts ? { threadTs: params.record.slack_ts } : {}),
  });
  return { delivered: true, text };
}
