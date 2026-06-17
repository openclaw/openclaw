import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";
import { RecentTaskStore } from "../client/recent-tasks.js";
import type { RecentReport } from "./report-tools.js";

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const {
  createReportCreateToolFactory,
  createOpinionContentToolFactory,
  createReportStatusToolFactory,
  createReportStopToolFactory,
} = await import("./report-tools.js");

const fakeApi = {
  pluginConfig: { backend: { baseUrl: "https://v2.businesstimescn.com", siteId: "legal" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);

function store() {
  return new RecentTaskStore<RecentReport>();
}

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
  const s = store();
  it("hides tools from non-rabbitmq agents and exposes to chat agents", () => {
    expect(createReportCreateToolFactory(fakeApi, resolver, s)({ agentId: "telegram-1" })).toBeNull();
    expect(createReportCreateToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })?.name).toBe(
      "report_create",
    );
    expect(
      createOpinionContentToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })?.name,
    ).toBe("opinion_content_create");
    expect(createReportStopToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })?.name).toBe(
      "report_stop",
    );
  });
});

describe("report_create", () => {
  it("defaults category to Event, posts save-requirement, hides the slug", async () => {
    const s = store();
    const tool = createReportCreateToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", reportId: "SLUG123", message: "ok" });
    const res = parse(await tool.execute("c1", { content: "分析某事件", industry: "某公司" }));

    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/industry-report/save-requirement");
    expect(fields).toMatchObject({ category: "Event", content: "分析某事件", industry: "某公司", siteId: "legal" });
    expect(res).toMatchObject({ success: true, submitted: true, category: "Event" });
    expect(res).not.toHaveProperty("status");
    expect(res).not.toHaveProperty("reportId");
    expect(res).not.toHaveProperty("slug");
  });

  it("requires content for non-Proofreading categories", async () => {
    const tool = createReportCreateToolFactory(fakeApi, resolver, store())({ agentId: "rabbitmq-1749" })!;
    const res = parse(await tool.execute("c2", { category: "Industry" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("allows Proofreading with only data", async () => {
    const tool = createReportCreateToolFactory(fakeApi, resolver, store())({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", reportId: "S2" });
    const res = parse(await tool.execute("c3", { category: "Proofreading", data: "待核实内容" }));
    expect(res.success).toBe(true);
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields).toMatchObject({ category: "Proofreading", data: "待核实内容" });
  });

  it("surfaces a quota danger envelope as an error", async () => {
    const tool = createReportCreateToolFactory(fakeApi, resolver, store())({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "danger", message: "可用研报篇数已用完" });
    const res = parse(await tool.execute("c4", { content: "x" }));
    expect(res).toMatchObject({ success: false, error: "可用研报篇数已用完" });
  });
});

describe("opinion_content_create", () => {
  it("requires target+instruction for Respond mode", async () => {
    const tool = createOpinionContentToolFactory(fakeApi, resolver, store())({ agentId: "rabbitmq-1749" })!;
    const res = parse(await tool.execute("o1", { category: "Respond", content: "事件", data: "正面" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("posts save-public-opinion for a Comment/Article and stores the slug", async () => {
    const s = store();
    const tool = createOpinionContentToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", reportId: "OPS1" });
    const res = parse(
      await tool.execute("o2", {
        category: "Comment",
        generateType: "Article",
        content: "舆情简报",
        data: "正面阐述",
      }),
    );
    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/industry-report/save-public-opinion");
    expect(fields).toMatchObject({ category: "Comment", generateType: "Article", content: "舆情简报", data: "正面阐述" });
    expect(res).toMatchObject({ success: true, mode: "Article" });
    expect(s.latest("1749")?.slug).toBe("OPS1");
  });
});

describe("report_status", () => {
  it("polls fetch-list by stored slug and category", async () => {
    const s = store();
    const create = createReportCreateToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    const status = createReportStatusToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", reportId: "SLUGX" });
    await create.execute("c1", { category: "Industry", content: "研报需求" });

    mockGetJson.mockResolvedValue({
      code: "success",
      list: [
        { id: 11, slug: "OTHER", status: "Running" },
        { id: 12, slug: "SLUGX", status: "Done", title: "研报", category: "Industry", date: "2026-06-16 10:00:00" },
      ],
    });
    const res = parse(await status.execute("s1", {}));
    const [, path, query] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/industry-report/fetch-list");
    expect(query).toMatchObject({ category: "Industry" });
    expect(res).toMatchObject({ success: true, found: true, status: "Done", statusLabel: "已完成", done: true });
  });

  it("reports not-found gracefully when the slug is not in the list yet", async () => {
    const s = store();
    const create = createReportCreateToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    const status = createReportStatusToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", reportId: "MISSING" });
    await create.execute("c1", { content: "x" });
    mockGetJson.mockResolvedValue({ code: "success", list: [] });
    const res = parse(await status.execute("s2", {}));
    expect(res).toMatchObject({ success: true, found: false });
  });

  it("errors when there is no recent report", async () => {
    const status = createReportStatusToolFactory(fakeApi, resolver, store())({ agentId: "rabbitmq-1749" })!;
    const res = parse(await status.execute("s3", {}));
    expect(res.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});

describe("report_stop", () => {
  it("resolves the numeric id via fetch-list then calls stop-report", async () => {
    const s = store();
    const create = createReportCreateToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    const stop = createReportStopToolFactory(fakeApi, resolver, s)({ agentId: "rabbitmq-1749" })!;
    mockPostForm.mockResolvedValue({ code: "success", reportId: "STOPME" });
    await create.execute("c1", { category: "Event", content: "事件" });

    mockGetJson
      .mockResolvedValueOnce({ code: "success", list: [{ id: 99, slug: "STOPME", status: "Running" }] })
      .mockResolvedValueOnce({ code: "success" });
    const res = parse(await stop.execute("st1"));

    const secondCall = mockGetJson.mock.calls[1] as [unknown, string, Record<string, unknown>];
    expect(secondCall[1]).toBe("/industry-report/stop-report");
    expect(secondCall[2]).toMatchObject({ id: 99 });
    expect(res.success).toBe(true);
  });
});
