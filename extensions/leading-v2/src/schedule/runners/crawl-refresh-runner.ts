import type { ApiKeyResolver } from "../../client/key-resolver.js";
import type { BackendConfig } from "../../client/types.js";
import { type CrawlRefreshParams, submitCrawlRefresh } from "../../crawl/crawl-submit.js";
import type { PendingTaskRegistry } from "../../notify/pending-store.js";
import type { ActionRunner, ScheduledTask } from "../types.js";

const NOTIFY_TTL_MS = 7_200_000; // 2h, matches the completion notifier default

/**
 * Scheduler runner for `crawl_refresh_create`: submit a 互动量刷新 task with the
 * task's stored notification addressing, so the result is delivered (Mercure /
 * history / email) exactly like a chat-initiated refresh.
 */
export function makeCrawlRefreshRunner(
  config: BackendConfig,
  resolver: ApiKeyResolver,
  registry: PendingTaskRegistry,
): ActionRunner {
  return async (task: ScheduledTask) => {
    const result = await submitCrawlRefresh({
      config,
      resolver,
      registry,
      userId: task.uid,
      params: task.action.params as CrawlRefreshParams,
      notify: {
        sessionKey: task.sessionKey,
        mercureTopic: task.mercureTopic,
        delivery: task.delivery,
        ttlMs: NOTIFY_TTL_MS,
      },
    });
    return result.ok ? { ok: true, note: result.uuid } : { ok: false, note: result.error };
  };
}
