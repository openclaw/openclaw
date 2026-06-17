import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import { RecentTaskStore } from "../client/recent-tasks.js";

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

import { setChatMercureTopic } from "../notify/chat-topic.js";
import { PendingTaskRegistry } from "../notify/pending-store.js";
import type { NotifyConfig } from "../notify/types.js";
import type { RecentCrawlRefresh } from "./crawl-tools.js";

const {
  createCrawlRefreshCreateToolFactory,
  createCrawlRefreshStatusToolFactory,
  createCrawlRefreshListToolFactory,
} = await import("./crawl-tools.js");

const notifyOff: NotifyConfig = { enabled: false, pollIntervalMs: 30000, ttlMs: 7200000, maxPerTick: 5 };
const notifyOn: NotifyConfig = { ...notifyOff, enabled: true };
const reg = () => new PendingTaskRegistry();

const fakeApi = {
  pluginConfig: { backend: { baseUrl: "https://v2.businesstimescn.com", siteId: "legal" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);

function parse(result: unknown): Record<string, unknown> {
  const r = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (r?.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

afterEach(() => vi.clearAllMocks());

describe("gating", () => {
  it("hides tools from non-rabbitmq agents", () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    expect(createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, reg(), notifyOff)({ agentId: "slack-7" })).toBeNull();
    expect(createCrawlRefreshListToolFactory(fakeApi, resolver)({ agentId: "coding" })).toBeNull();
  });
});

describe("crawl_refresh_create", () => {
  it("requires links or feeds", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const tool = createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, reg(), notifyOff)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("c0", {})).success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("requires topicId when feeds is given", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const tool = createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, reg(), notifyOff)({ agentId: "rabbitmq-1749" })!;
    const res = parse(
      await tool.execute("c1", { feeds: [{ feedId: 5, url: "https://x.com/1" }] }),
    );
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("posts add-task with newline links + dispatch=1, hides uuid", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const tool = createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, reg(), notifyOff)({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", uuid: "UU-1", total: 2, message: "ok" });

    const res = parse(
      await tool.execute("c2", { links: ["https://a.com/1", "https://a.com/2"], name: "刷新A" }),
    );
    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/link-data-crawler/add-task");
    expect(fields).toMatchObject({ dispatch: 1, siteId: "legal", name: "刷新A" });
    expect(fields.links).toBe("https://a.com/1\nhttps://a.com/2");
    expect(fields.feeds).toBeUndefined();
    expect(res).toMatchObject({ success: true, submitted: true, name: "刷新A", linkCount: 2 });
    expect(res).not.toHaveProperty("uuid");
  });

  it("derives links from feeds[].url and sends feeds JSON + topicId", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const tool = createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, reg(), notifyOff)({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", uuid: "UU-2", total: 1 });

    await tool.execute("c3", {
      topicId: 553,
      feeds: [{ feedId: 88, url: "https://b.com/x", title: "标题", level: "Red" }],
    });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields.links).toBe("https://b.com/x");
    expect(fields.topicId).toBe(553);
    const feeds = JSON.parse(fields.feeds as string);
    expect(feeds[0]).toMatchObject({ feedId: 88, url: "https://b.com/x", title: "标题", level: "Red", offline: 0 });
  });

  it("registers a pending notify task when enabled and a sessionKey is present", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const registry = reg();
    const tool = createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, registry, notifyOn)({
      agentId: "rabbitmq-1749",
      sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:sess-1",
      deliveryContext: { channel: "telegram", to: "u1" },
    })!;
    mockPostForm.mockResolvedValue({ code: "success", uuid: "UU-N", total: 1 });

    const res = parse(await tool.execute("n1", { links: ["https://n.com/1"] }));
    expect((res.agentInstruction as string).includes("自动通知")).toBe(true);
    const pending = registry.all();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: "crawl_refresh:UU-N",
      kind: "crawl_refresh",
      uid: "1749",
      backendId: "UU-N",
      sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:sess-1",
      notified: false,
    });
  });

  it("captures the live web-chat Mercure topic (bridged from rabbitmq-consumer)", async () => {
    setChatMercureTopic("4242", "lobster/user/4242/sess-xyz");
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const registry = reg();
    const r2 = new ApiKeyResolver({ "4242": "sk_4242" }, undefined);
    const tool = createCrawlRefreshCreateToolFactory(fakeApi, r2, s, registry, notifyOn)({
      agentId: "rabbitmq-4242",
      sessionKey: "agent:rabbitmq-4242:rabbitmq:4242:sess-xyz",
    })!;
    mockPostForm.mockResolvedValue({ code: "success", uuid: "UU-T", total: 1 });
    await tool.execute("t1", { links: ["https://t.com/1"] });
    expect(registry.all()[0]).toMatchObject({ uid: "4242", mercureTopic: "lobster/user/4242/sess-xyz" });
  });

  it("does NOT register when sessionKey is absent", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const registry = reg();
    const tool = createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, registry, notifyOn)({
      agentId: "rabbitmq-1749",
    })!;
    mockPostForm.mockResolvedValue({ code: "success", uuid: "UU-X", total: 1 });
    await tool.execute("n2", { links: ["https://n.com/2"] });
    expect(registry.all()).toHaveLength(0);
  });
});

describe("crawl_refresh_status", () => {
  it("polls detail then records when done, mapping engagement columns", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const create = createCrawlRefreshCreateToolFactory(fakeApi, resolver, s, reg(), notifyOff)({ agentId: "rabbitmq-1749" })!;
    const status = createCrawlRefreshStatusToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;

    mockPostForm.mockResolvedValue({ code: "success", uuid: "UU-3", total: 1 });
    await create.execute("c4", { links: ["https://c.com/1"] });

    mockGetJson.mockResolvedValueOnce({ code: "success", task: { status: "done" } });
    mockGetJson.mockResolvedValueOnce({
      code: "success",
      list: [
        {
          url: "https://c.com/1",
          platform: "微博",
          status: "success",
          repost_count: 10,
          comment_count: 5,
          like_count: 100,
          read_count: 9999,
          collect_count: 3,
          share_count: 2,
          follower_count: 50000,
          scraped_at: "2026-06-17 10:00:00",
        },
      ],
    });

    const res = parse(await status.execute("s1", {}));
    const [, detailPath] = mockGetJson.mock.calls[0] as [unknown, string];
    const [, recordsPath] = mockGetJson.mock.calls[1] as [unknown, string];
    expect(detailPath).toBe("/link-data-crawler/detail");
    expect(recordsPath).toBe("/link-data-crawler/fetch-records");
    expect(res).toMatchObject({ success: true, status: "done", done: true, total: 1 });
    const row = (res.list as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({
      url: "https://c.com/1",
      platform: "微博",
      转发: 10,
      评论: 5,
      点赞: 100,
      阅读: 9999,
      收藏: 3,
      分享: 2,
      粉丝: 50000,
    });
  });

  it("reports progress without fetching records while still running", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    s.remember("1749", { uuid: "UU-4", name: null });
    const status = createCrawlRefreshStatusToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValueOnce({ code: "success", task: { status: "pending" } });

    const res = parse(await status.execute("s2", {}));
    expect(res).toMatchObject({ success: true, status: "pending", total: 0 });
    expect(res).not.toHaveProperty("done");
    expect(mockGetJson).toHaveBeenCalledTimes(1); // records NOT fetched
  });

  it("errors when no recent task", async () => {
    const s = new RecentTaskStore<RecentCrawlRefresh>();
    const status = createCrawlRefreshStatusToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await status.execute("s3", {})).success).toBe(false);
  });
});

describe("crawl_refresh_list", () => {
  it("maps task rows", async () => {
    const tool = createCrawlRefreshListToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({
      code: "success",
      total: 1,
      list: [{ name: "刷新A", status: "done", total_links: 12, created_at: "2026-06-17 09:00:00" }],
    });
    const res = parse(await tool.execute("l1", { status: "done" }));
    const [, path, params] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/link-data-crawler/list");
    expect(params).toMatchObject({ status: "done", page: 1, size: 20 });
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "刷新A",
      statusLabel: "已完成",
      total: 12,
    });
  });
});
