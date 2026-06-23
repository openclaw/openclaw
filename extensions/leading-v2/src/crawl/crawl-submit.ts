import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, postForm } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import type { BackendConfig } from "../client/types.js";
import { debugLog } from "../notify/debug.js";
import type { PendingTaskRegistry } from "../notify/pending-store.js";
import type { DeliveryTarget } from "../notify/types.js";

export interface CrawlRefreshParams {
  links?: string[] | string;
  feeds?: Array<Record<string, unknown>>;
  topicId?: number;
  name?: string;
}

/** Where a completion notification should later be delivered. */
export interface CrawlNotifyTarget {
  sessionKey: string;
  mercureTopic: string;
  delivery?: DeliveryTarget;
  ttlMs: number;
}

export type CrawlSubmitResult =
  | { ok: true; uuid: string; name: string | null; linkCount: number; message: string }
  | { ok: false; error: string };

export function normalizeLinks(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter((u) => /^https?:\/\//i.test(u));
  }
  if (typeof raw === "string") {
    return raw
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((u) => /^https?:\/\//i.test(u));
  }
  return [];
}

/** Build the backend `feeds` snapshot array, keeping only fields insertFeeds reads. */
export function normalizeFeeds(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((f) => f as Record<string, unknown>)
    .filter((f) => Number.isInteger(Number(f.feedId)) && Number(f.feedId) > 0)
    .map((f) => ({
      feedId: Number(f.feedId),
      url: asString(f.url) ?? "",
      title: asString(f.title) ?? "",
      contentType: asString(f.contentType) ?? "",
      level: asString(f.level) ?? "",
      offline: f.offline ? 1 : 0,
      platform: asString(f.platform) ?? "",
      author: asString(f.author) ?? "",
    }));
}

/**
 * Submit a 互动量刷新 task to the backend and (optionally) register it for
 * completion notification. Shared by the chat tool and the scheduler so both
 * paths behave identically. Returns a plain result; the caller formats output.
 */
export async function submitCrawlRefresh(args: {
  config: BackendConfig;
  resolver: ApiKeyResolver;
  registry: PendingTaskRegistry;
  userId: string;
  params: CrawlRefreshParams;
  notify?: CrawlNotifyTarget; // omit to skip notification registration
}): Promise<CrawlSubmitResult> {
  const { config, resolver, registry, userId, params, notify } = args;

  let apiKey: string;
  try {
    apiKey = await resolver.getApiKey(userId);
  } catch {
    return { ok: false, error: "Could not resolve an API key for this account." };
  }

  const feeds = normalizeFeeds(params.feeds);
  const explicitLinks = normalizeLinks(params.links);
  const links = explicitLinks.length > 0 ? explicitLinks : feeds.map((f) => String(f.url)).filter(Boolean);
  const uniqueLinks = [...new Set(links)];

  if (uniqueLinks.length === 0 && feeds.length === 0) {
    return { ok: false, error: "Provide links (URLs) or feeds (监测方案条目) to refresh." };
  }
  if (uniqueLinks.length > 5000) {
    return { ok: false, error: "Too many links (max 5000 per task)." };
  }
  if (feeds.length > 1000) {
    return { ok: false, error: "Too many feeds (max 1000 per task)." };
  }
  const topicId = Number(params.topicId);
  if (feeds.length > 0 && (!Number.isInteger(topicId) || topicId <= 0)) {
    return { ok: false, error: "topicId is required when refreshing 监测方案条目 (feeds)." };
  }
  if (uniqueLinks.length === 0) {
    return { ok: false, error: "No crawlable URL found; each feed needs a url, or pass links directly." };
  }

  const name = asString(params.name)?.slice(0, 255);
  const fields: Record<string, FieldValue> = {
    name: name ?? "",
    links: uniqueLinks.join("\n"),
    feeds: feeds.length > 0 ? JSON.stringify(feeds) : undefined,
    topicId: feeds.length > 0 ? topicId : undefined,
    dispatch: 1,
    siteId: config.siteId,
  };

  let res: Record<string, unknown>;
  try {
    res = await postForm(config, "/link-data-crawler/add-task", fields, apiKey);
  } catch (error) {
    return { ok: false, error: `Backend request failed: ${String(error)}` };
  }
  const envErr = envelopeError(res);
  if (envErr) {
    return { ok: false, error: envErr };
  }
  const uuid = asString(res.uuid);
  if (!uuid) {
    return { ok: false, error: "Backend did not return a task id." };
  }

  if (notify) {
    const now = Date.now();
    registry.add({
      id: `crawl_refresh:${uuid}`,
      kind: "crawl_refresh",
      uid: userId,
      backendId: uuid,
      sessionKey: notify.sessionKey,
      mercureTopic: notify.mercureTopic,
      delivery: notify.delivery ?? {},
      title: name ?? null,
      createdAt: now,
      attempts: 0,
      notified: false,
      expiresAt: now + notify.ttlMs,
    });
    debugLog(`submitCrawlRefresh uuid=${uuid} registered notify mercureTopic=${notify.mercureTopic}`);
  }

  return {
    ok: true,
    uuid,
    name: name ?? null,
    linkCount: Number(res.total ?? uniqueLinks.length),
    message: asString(res.message) ?? "任务已提交",
  };
}
