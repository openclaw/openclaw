import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import { RecentTaskStore } from "../client/recent-tasks.js";
import type { PendingTaskRegistry } from "../notify/pending-store.js";
import type { NotifyConfig } from "../notify/types.js";
import type { RecentLinkBatch } from "./link-tools.js";

const NOTIFY_OFF: NotifyConfig = { enabled: false, pollIntervalMs: 5000, ttlMs: 7_200_000, maxPerTick: 5 };
const NOTIFY_ON: NotifyConfig = { enabled: true, pollIntervalMs: 5000, ttlMs: 7_200_000, maxPerTick: 5 };
const makeRegistry = () => ({ add: vi.fn() }) as unknown as PendingTaskRegistry;

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const { createLinkBatchCreateToolFactory, createLinkBatchStatusToolFactory } = await import(
  "./link-tools.js"
);

const fakeApi = {
  pluginConfig: { backend: { baseUrl: "https://v2.businesstimescn.com", siteId: "legal" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);
const store = new RecentTaskStore<RecentLinkBatch>();
const createFactory = createLinkBatchCreateToolFactory(fakeApi, resolver, store, makeRegistry(), NOTIFY_OFF);
const statusFactory = createLinkBatchStatusToolFactory(fakeApi, resolver, store);

function parse(result: unknown): Record<string, unknown> {
  const r = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (r?.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

afterEach(() => vi.clearAllMocks());

describe("factory gating", () => {
  it("hides tools from non-rabbitmq agents", () => {
    expect(createFactory({ agentId: "telegram-1" })).toBeNull();
    expect(statusFactory({ agentId: undefined })).toBeNull();
  });

  it("exposes the tools to rabbitmq-<userId> agents", () => {
    expect(createFactory({ agentId: "rabbitmq-1749" })?.name).toBe("link_batch_create");
    expect(statusFactory({ agentId: "rabbitmq-1749" })?.name).toBe("link_batch_status");
  });
});

describe("link_batch_create", () => {
  const tool = () => createFactory({ agentId: "rabbitmq-1749" })!;

  it("normalizes links and posts /link-data-crawler/add-check-task, hiding the uuid", async () => {
    mockPostForm.mockResolvedValue({ uuid: "u-abc", taskId: 30, total: 2, message: "检测任务已提交" });
    const res = parse(
      await tool().execute("c1", {
        links: ["https://a.com/1", " https://a.com/2 ", "https://a.com/1"],
        label: "测试批次",
      }),
    );
    expect(mockPostForm).toHaveBeenCalledTimes(1);
    const [, path, fields, apiKey] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(path).toBe("/link-data-crawler/add-check-task");
    expect(apiKey).toBe("sk_test1749");
    expect(fields).toMatchObject({
      name: "测试批次",
      links: "https://a.com/1\nhttps://a.com/2",
      siteId: "legal",
    });
    expect(res).toMatchObject({ success: true, submitted: true, label: "测试批次", linkCount: 2 });
    expect(res).not.toHaveProperty("status");
    expect(res).not.toHaveProperty("uuid");
  });

  it("accepts a newline-separated string and drops empty/invalid lines", async () => {
    mockPostForm.mockResolvedValue({ uuid: "u-1" });
    await tool().execute("c2", {
      links: "https://a.com/1\n\n not-a-url \n https://a.com/2 \n",
      label: "x",
    });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields.links).toBe("https://a.com/1\nhttps://a.com/2");
  });

  it("errors without backend call when links or label missing", async () => {
    expect(parse(await tool().execute("c3", { links: "", label: "x" })).success).toBe(false);
    expect(parse(await tool().execute("c4", { links: "https://a.com/1", label: "" })).success).toBe(
      false,
    );
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("surfaces a backend danger envelope as an error", async () => {
    mockPostForm.mockResolvedValue({ code: "danger", message: "请提供至少一个有效链接" });
    const res = parse(await tool().execute("c5", { links: "https://a.com/1", label: "x" }));
    expect(res).toMatchObject({ success: false, error: "请提供至少一个有效链接" });
  });

  it("errors (no backend call) when no key resolves for the account", async () => {
    const noKey = createFactory({ agentId: "rabbitmq-2005" })!;
    const res = parse(await noKey.execute("c6", { links: "https://a.com/1", label: "x" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("registers the task for completion notification when a session + notify exist", async () => {
    const registry = makeRegistry();
    const tool = createLinkBatchCreateToolFactory(
      fakeApi,
      resolver,
      new RecentTaskStore<RecentLinkBatch>(),
      registry,
      NOTIFY_ON,
    )({ agentId: "rabbitmq-1749", sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1" })!;
    mockPostForm.mockResolvedValue({ uuid: "u-xyz", total: 1 });

    await tool.execute("r1", { links: "https://a.com/1", label: "批次N" });

    expect(registry.add).toHaveBeenCalledTimes(1);
    expect((registry.add as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      id: "link_check:u-xyz",
      kind: "link_check",
      uid: "1749",
      backendId: "u-xyz",
      title: "批次N",
      sessionKey: "agent:rabbitmq-1749:rabbitmq:1749:session_1",
      notified: false,
    });
  });

  it("does not register when no session is available", async () => {
    const registry = makeRegistry();
    const tool = createLinkBatchCreateToolFactory(
      fakeApi,
      resolver,
      new RecentTaskStore<RecentLinkBatch>(),
      registry,
      NOTIFY_ON,
    )({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ uuid: "u-2", total: 1 });

    await tool.execute("r2", { links: "https://a.com/1", label: "x" });

    expect(registry.add).not.toHaveBeenCalled();
  });
});

describe("link_batch_status", () => {
  it("polls the most recent task by uuid and returns per-link verdicts when done", async () => {
    const localStore = new RecentTaskStore<RecentLinkBatch>();
    const create = createLinkBatchCreateToolFactory(fakeApi, resolver, localStore, makeRegistry(), NOTIFY_OFF)({
      agentId: "rabbitmq-1749",
    })!;
    const status = createLinkBatchStatusToolFactory(fakeApi, resolver, localStore)({
      agentId: "rabbitmq-1749",
    })!;

    mockPostForm.mockResolvedValue({ uuid: "u-7001", taskId: 7001, total: 3 });
    await create.execute("c1", { links: "https://a.com/1", label: "批次" });

    mockGetJson.mockImplementation(async (...args: unknown[]) => {
      const path = args[1] as string;
      if (path === "/link-data-crawler/detail") {
        return { task: { status: "done", total_links: 3, done_links: 3 }, code: "success" };
      }
      // /link-data-crawler/fetch-check-results
      return {
        code: "success",
        list: [
          { url: "https://a.com/1", verdict: "invalid", status_type: "NOT_FOUND", http_status: 404, reason: "HTTP 404", checked_at: "2025-10-29 18:08:08" },
          { url: "https://a.com/2", verdict: "valid", http_status: 200 },
          { url: "https://a.com/3", verdict: "blocked", status_type: "CAPTCHA" },
        ],
      };
    });
    const res = parse(await status.execute("s1", {}));

    const paths = mockGetJson.mock.calls.map((c) => (c as [unknown, string])[1]);
    expect(paths).toEqual(["/link-data-crawler/detail", "/link-data-crawler/fetch-check-results"]);
    const detailQuery = (mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>])[2];
    expect(detailQuery).toMatchObject({ uuid: "u-7001" });

    expect(res).toMatchObject({
      success: true,
      status: "done",
      statusLabel: "已完成",
      done: true,
      label: "批次",
      linksTotal: 3,
      checkedTotal: 3,
      offlineTotal: 1,
      total: 3,
    });
    const list = res.list as Array<Record<string, unknown>>;
    expect(list[0]).toMatchObject({
      url: "https://a.com/1",
      verdict: "invalid",
      verdictLabel: "失效",
      statusType: "NOT_FOUND",
      httpStatus: 404,
      reason: "HTTP 404",
    });
    expect(list[1]).toMatchObject({ verdict: "valid", verdictLabel: "正常" });
    expect(list[2]).toMatchObject({ verdict: "blocked", verdictLabel: "被拦截" });
    expect(res).not.toHaveProperty("uuid");
  });

  it("reports progress and skips the results fetch while still pending", async () => {
    const localStore = new RecentTaskStore<RecentLinkBatch>();
    localStore.remember("1749", { uuid: "u-pending", label: "排队批次" });
    const status = createLinkBatchStatusToolFactory(fakeApi, resolver, localStore)({
      agentId: "rabbitmq-1749",
    })!;

    mockGetJson.mockResolvedValue({ task: { status: "pending", total_links: 5, done_links: 0 } });
    const res = parse(await status.execute("s2", {}));

    expect(mockGetJson).toHaveBeenCalledTimes(1);
    expect((mockGetJson.mock.calls[0] as [unknown, string])[1]).toBe("/link-data-crawler/detail");
    expect(res).toMatchObject({ success: true, status: "pending", statusLabel: "排队中", total: 0 });
    expect(res.list).toEqual([]);
    expect(res).not.toHaveProperty("done");
  });

  it("errors when there is no recent task and no uuid is given", async () => {
    const status = createLinkBatchStatusToolFactory(
      fakeApi,
      resolver,
      new RecentTaskStore<RecentLinkBatch>(),
    )({ agentId: "rabbitmq-1749" })!;
    const res = parse(await status.execute("s3", {}));
    expect(res.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
