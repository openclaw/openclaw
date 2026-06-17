import { asString, envelopeError } from "../client/envelope.js";
import { getJson } from "../client/http-client.js";
import type { BackendConfig } from "../client/types.js";
import type { PendingTask, PollResult } from "./types.js";

/**
 * Poll a 互动量刷新 task: GET detail for status, and when done, GET fetch-records
 * to build a short engagement summary the agent can read out to the user.
 */
export async function pollCrawlRefresh(
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
    return { terminal: true, summary: `互动量刷新任务「${task.title ?? "未命名"}」${label}了。` };
  }
  if (status !== "done") {
    return { terminal: false, summary: "" };
  }

  const records = await getJson(config, "/link-data-crawler/fetch-records", { uuid }, apiKey);
  const rows = Array.isArray(records.list) ? (records.list as Record<string, unknown>[]) : [];
  const lines = rows.slice(0, 10).map((r) => {
    const url = asString(r.url) ?? "";
    const repost = Number(r.repost_count ?? 0);
    const comment = Number(r.comment_count ?? 0);
    const like = Number(r.like_count ?? 0);
    const read = Number(r.read_count ?? 0);
    return `- ${url} → 转${repost} 评${comment} 赞${like} 阅${read}`;
  });
  const more = rows.length > 10 ? `\n（共 ${rows.length} 条，仅列前 10 条）` : "";
  const summary =
    `互动量刷新任务「${task.title ?? "未命名"}」已完成，共 ${rows.length} 条链接的最新互动量：\n` +
    `${lines.join("\n")}${more}`;
  return { terminal: true, summary };
}
