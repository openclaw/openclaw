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

import type { RecentDownload } from "./opinion-task-tools.js";

const {
  createOpinionAnalyzeToolFactory,
  createOpinionExportToolFactory,
  createSheetReportToolFactory,
  createOpinionDownloadStatusToolFactory,
} = await import("./opinion-task-tools.js");
const {
  createFeedListToolFactory,
  createTopicListToolFactory,
  createFeedReanalyzeToolFactory,
  createMonthlyStatsToolFactory,
} = await import("./opinion-read-tools.js");

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
    const s = new RecentTaskStore<RecentDownload>();
    expect(createOpinionAnalyzeToolFactory(fakeApi, resolver, s)({ agentId: "telegram-1" })).toBeNull();
    expect(createFeedListToolFactory(fakeApi, resolver)({ agentId: "coding" })).toBeNull();
  });
});

describe("opinion_analyze + status", () => {
  it("submits request-download then polls fetch-downloads by slug", async () => {
    const s = new RecentTaskStore<RecentDownload>();
    const analyze = createOpinionAnalyzeToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    const status = createOpinionDownloadStatusToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;

    mockPostForm.mockResolvedValue({ code: "success", slug: "DLSLUG", message: "ok" });
    const created = parse(await analyze.execute("a1", { data: "某舆情事件 https://x.com/1", category: "RiskEvaluation" }));
    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/pub-opinion/request-download");
    expect(fields).toMatchObject({ category: "RiskEvaluation", siteId: "legal" });
    expect(created).toMatchObject({ success: true, submitted: true, category: "RiskEvaluation" });
    expect(created).not.toHaveProperty("status");
    expect(created).not.toHaveProperty("slug");

    mockGetJson.mockResolvedValue({
      code: "success",
      items: [
        { slug: "OTHER", status: "Pending" },
        { slug: "DLSLUG", status: "Done", title: "研判", fileLink: "https://oss/x.docx", content: "分析正文" },
      ],
    });
    const res = parse(await status.execute("s1", {}));
    expect(res).toMatchObject({
      success: true,
      found: true,
      status: "Done",
      done: true,
      fileLink: "https://oss/x.docx",
      content: "分析正文",
    });
  });

  it("requires data", async () => {
    const s = new RecentTaskStore<RecentDownload>();
    const analyze = createOpinionAnalyzeToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    const res = parse(await analyze.execute("a2", {}));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });
});

describe("opinion_report_export", () => {
  it("requires reportId and sends datetimerange as an array", async () => {
    const s = new RecentTaskStore<RecentDownload>();
    const tool = createOpinionExportToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("e0", {})).success).toBe(false);

    mockPostForm.mockResolvedValue({ code: "success", slug: "EXP1" });
    await tool.execute("e1", {
      reportId: 1024,
      category: "Report",
      dateType: "datetimerange",
      dateScope: "2026-06-01,2026-06-10",
    });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields).toMatchObject({ category: "Report", reportId: 1024, dateType: "datetimerange" });
    expect(fields.dateScope).toEqual(["2026-06-01", "2026-06-10"]);
  });
});

describe("sheet_report_create", () => {
  it("requires fileLink and posts submit-sheet-report-job", async () => {
    const s = new RecentTaskStore<RecentDownload>();
    const tool = createSheetReportToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("sh0", {})).success).toBe(false);

    mockPostForm.mockResolvedValue({ code: "success", slug: "SH1" });
    const res = parse(await tool.execute("sh1", { fileLink: "https://oss/20260616000000_data.xlsx" }));
    const [, path] = mockPostForm.mock.calls[0] as [unknown, string];
    expect(path).toBe("/pub-opinion/submit-sheet-report-job");
    expect(res.success).toBe(true);
  });
});

describe("feed_list", () => {
  it("requires topicId and forwards array filters", async () => {
    const tool = createFeedListToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("f0", {})).success).toBe(false);

    mockGetJson.mockResolvedValue({
      total: 1,
      list: [{ id: 5, title: "标题", platform: "微信", emotion: "Negative", level: "Red", summary: "摘要", link: "u", date: "d" }],
    });
    const res = parse(
      await tool.execute("f1", { topicId: 553, platforms: ["weixin", "weibo"], riskLevels: ["Red"] }),
    );
    const [, path, params] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/pub-opinion/fetch-feeds");
    expect(params).toMatchObject({ topicId: 553 });
    expect(params.platforms).toEqual(["weixin", "weibo"]);
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 5, level: "Red" });
  });
});

describe("topic_list", () => {
  it("maps schemes and flags dos as not-authorized", async () => {
    const tool = createTopicListToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValueOnce({ dos: 1, message: "" });
    expect(parse(await tool.execute("t0", { reportId: "SLUG" })).success).toBe(false);

    mockGetJson.mockResolvedValueOnce({
      code: "success",
      list: [{ id: 7, refId: 0, title: "主方案", master: 1, enableAnalysis: 1 }],
    });
    const res = parse(await tool.execute("t1", { reportId: 1024 }));
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({ topicId: 7, master: true, enableAnalysis: true });
  });
});

describe("feed_reanalyze", () => {
  it("validates inputs and maps ruleTypes to variant keys", async () => {
    const tool = createFeedReanalyzeToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("r0", { topicId: 553, reportId: 3965, ids: [], ruleTypes: ["PreCheck"] })).success).toBe(
      false,
    );

    mockPostForm.mockResolvedValue({ code: "success", message: "数据已提交重新分析，请等待：2条" });
    const res = parse(
      await tool.execute("r1", { topicId: 553, reportId: 3965, ids: [1, 2], ruleTypes: ["PreCheck", "DoubleCheck"], mode: "test" }),
    );
    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/pub-opinion/reanalyze-items");
    expect(fields).toMatchObject({ topicId: 553, reportId: 3965, preCheck: "test", doubleCheck: "test" });
    expect(fields.categorize).toBeUndefined();
    expect(fields.ids).toEqual([1, 2]);
    expect(res).toMatchObject({ success: true, submitted: 2 });
  });
});

describe("monthly_stats", () => {
  it("validates months and drops the article-id arrays", async () => {
    const tool = createMonthlyStatsToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    expect(parse(await tool.execute("m0", { clusterId: 1, months: ["bad"] })).success).toBe(false);

    mockPostForm.mockResolvedValue({
      code: "success",
      data: [{ time: "01", month: "202510", total: 10, Negative: 2, articles: [1, 2] }],
    });
    const res = parse(await tool.execute("m1", { clusterId: 395804, months: ["202510"] }));
    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/pub-opinion/request-monthly-date");
    expect(fields.date).toEqual(["202510"]);
    const day = (res.days as Array<Record<string, unknown>>)[0];
    expect(day).toMatchObject({ time: "01", total: 10, Negative: 2 });
    expect(day).not.toHaveProperty("articles");
  });
});
