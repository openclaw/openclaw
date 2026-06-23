import { normalizeFeeds, normalizeLinks } from "../../crawl/crawl-submit.js";
import { makeCrawlRefreshRunner } from "../runners/crawl-refresh-runner.js";
import type { ScheduleActionType } from "./types.js";

/**
 * 互动量刷新: re-crawl a set of links / 监测方案条目 and deliver the result through
 * the same completion-notifier + Notifier as a chat-initiated refresh. Deterministic
 * (no LLM in the loop) — pick this when you want exact tool + params on schedule.
 */
export const crawlRefreshAction: ScheduleActionType = {
  name: "crawl_refresh",
  tool: "crawl_refresh_create", // back-compat: existing persisted tasks use this tool key
  label: "互动量刷新",
  summary:
    "互动量刷新（确定性）：重新抓取一批链接或监测方案条目的互动量。" +
    "params: { links?: string[] 或换行分隔字符串(http(s) 链接), feeds?: 监测方案条目数组(配合 topicId), topicId?: number }。",
  validate(params) {
    // Reject empty/garbage params (e.g. the literal string "[]") by checking that
    // normalization actually yields crawlable links or valid feeds.
    const links = normalizeLinks(params.links);
    const feeds = normalizeFeeds(params.feeds);
    if (links.length === 0 && feeds.length === 0) {
      return { ok: false, error: "crawl_refresh 需要有效的 links(http(s) 链接) 或 feeds(监测方案条目)。" };
    }
    // Keep the original shapes; the runner's submitCrawlRefresh re-normalizes them.
    const out: Record<string, unknown> = {};
    if (params.links !== undefined) {
      out.links = params.links;
    }
    if (params.feeds !== undefined) {
      out.feeds = params.feeds;
    }
    if (params.topicId !== undefined) {
      out.topicId = params.topicId;
    }
    if (params.name !== undefined) {
      out.name = params.name;
    }
    return { ok: true, params: out };
  },
  makeRunner(deps) {
    return makeCrawlRefreshRunner(deps.config, deps.resolver, deps.registry);
  },
};
