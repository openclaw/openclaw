import { asString, envelopeError } from "../client/envelope.js";
import { getJson } from "../client/http-client.js";
import type { BackendConfig } from "../client/types.js";
import type { PendingTask, PollResult } from "./types.js";

/** crawl_check_record.verdict values (set by the Python check_worker). */
const VERDICT_LABELS: Record<string, string> = {
  invalid: "失效",
  valid: "正常",
  blocked: "被拦截",
  unknown: "无法判定",
};

/**
 * Poll a 失效链接强化检测 task: GET detail for status, and when terminal, GET
 * fetch-check-results to build a short verdict summary the agent can read out.
 * Mirrors pollCrawlRefresh; the link-check engine shares the LinkDataCrawler
 * backend but keyed on the check task (status `done` when every link is judged).
 */
export async function pollLinkCheck(
  task: PendingTask,
  apiKey: string,
  config: BackendConfig,
): Promise<PollResult> {
  const uuid = task.backendId;
  const detail = await getJson(config, "/link-data-crawler/detail", { uuid }, apiKey);
  const detailErr = envelopeError(detail);
  if (detailErr) {
    throw new Error(`detail failed: ${detailErr}`);
  }
  const taskRow = (detail.task as Record<string, unknown> | undefined) ?? {};
  const status = (asString(taskRow.status) ?? "").toLowerCase();

  if (status === "failed" || status === "stop") {
    const label = status === "failed" ? "失败" : "已停止";
    return { terminal: true, summary: `失效链接检测任务「${task.title ?? "未命名"}」${label}了。` };
  }
  if (status !== "done") {
    return { terminal: false, summary: "" };
  }

  const records = await getJson(config, "/link-data-crawler/fetch-check-results", { uuid }, apiKey);
  const recordsErr = envelopeError(records);
  if (recordsErr) {
    throw new Error(`fetch-check-results failed: ${recordsErr}`);
  }
  const rows = Array.isArray(records.list) ? (records.list as Record<string, unknown>[]) : [];
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const verdict = (asString(r.verdict) ?? "unknown").toLowerCase();
    counts[verdict] = (counts[verdict] ?? 0) + 1;
  }
  // Lead with the actionable count (失效), then list the rest in a stable order.
  const order = ["invalid", "blocked", "unknown", "valid"];
  const breakdown = order
    .filter((v) => counts[v])
    .map((v) => `${VERDICT_LABELS[v] ?? v} ${counts[v]}`)
    .join("、");
  const invalidRows = rows.filter((r) => (asString(r.verdict) ?? "").toLowerCase() === "invalid");
  const invalidLines = invalidRows.slice(0, 10).map((r) => `- ${asString(r.url) ?? ""}（失效）`);
  const moreInvalid = invalidRows.length > 10 ? `\n（失效共 ${invalidRows.length} 条，仅列前 10 条）` : "";
  const detailBlock = invalidLines.length > 0 ? `\n失效链接：\n${invalidLines.join("\n")}${moreInvalid}` : "";

  const summary =
    `失效链接检测任务「${task.title ?? "未命名"}」已完成，共 ${rows.length} 条：` +
    `${breakdown || "无结果"}。${detailBlock}`;
  return { terminal: true, summary };
}
