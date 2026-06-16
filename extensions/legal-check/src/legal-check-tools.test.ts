import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { ApiKeyResolver } from "./key-resolver.js";
import { RecentJobStore } from "./recent-jobs.js";

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("./http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const { createLegalCheckCreateToolFactory, createLegalCheckStatusToolFactory } =
  await import("./legal-check-tools.js");

const fakeApi = {
  pluginConfig: { legalApi: { baseUrl: "https://v2.businesstimescn.com" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

// Resolver with an explicit override for 1749 and no db: 1749 resolves to the
// override; any other uid throws (no override, no db to provision from).
const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);

const store = new RecentJobStore();
const createFactory = createLegalCheckCreateToolFactory(fakeApi, resolver, store);
const statusFactory = createLegalCheckStatusToolFactory(fakeApi, resolver, store);

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
  it("hides both tools from non-rabbitmq agents", () => {
    expect(createFactory({ agentId: "telegram-1" })).toBeNull();
    expect(statusFactory({ agentId: undefined })).toBeNull();
  });

  it("exposes the tools to rabbitmq-<userId> agents", () => {
    expect(createFactory({ agentId: "rabbitmq-1749" })?.name).toBe("legal_check_create");
    expect(statusFactory({ agentId: "rabbitmq-1749" })?.name).toBe("legal_check_status");
  });
});

describe("legal_check_create", () => {
  const tool = () => createFactory({ agentId: "rabbitmq-1749" })!;

  it("posts /legal/save-job with extracted link + violation defaults, hiding the jobId", async () => {
    mockPostForm.mockResolvedValue({ job: { id: 6378, label: "某文章", status: "Pending" } });
    const res = parse(await tool().execute("c1", { content: "看 https://www.msn.cn/a 这条" }));

    expect(mockPostForm).toHaveBeenCalledTimes(1);
    const [, path, fields, apiKey] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(path).toBe("/legal/save-job");
    expect(apiKey).toBe("sk_test1749");
    expect(fields).toMatchObject({
      requirement: "看 https://www.msn.cn/a 这条",
      link: "https://www.msn.cn/a",
      rumor: 0,
      upload: 0,
      siteId: "legal",
    });
    // The raw id is not handed back to the model — only the user-facing link keeps it.
    expect(res).toMatchObject({
      success: true,
      mode: "violation",
      detailPath: "/business/content/6378",
    });
    expect(res).not.toHaveProperty("jobId");
  });

  it("requires truth + verifiedBy for rumor mode (no backend call)", async () => {
    const res = parse(await tool().execute("c2", { content: "某说法", mode: "rumor" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("sends rumor fields when provided", async () => {
    mockPostForm.mockResolvedValue({ job: { id: 9 } });
    await tool().execute("c3", {
      content: "某说法",
      mode: "rumor",
      truth: "实际情况是X",
      verifiedBy: "市监局",
    });
    const [, , fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(fields).toMatchObject({ rumor: 1, data: "实际情况是X", officialUnit: "市监局" });
  });

  it("surfaces a backend danger envelope as an error", async () => {
    mockPostForm.mockResolvedValue({ code: "danger", message: "额度不足" });
    const res = parse(await tool().execute("c4", { content: "https://a.com/x" }));
    expect(res).toMatchObject({ success: false, error: "额度不足" });
  });

  it("errors (no backend call) when no key can be resolved for the account", async () => {
    const noKeyTool = createFactory({ agentId: "rabbitmq-2005" })!;
    const res = parse(await noKeyTool.execute("c5", { content: "https://a.com/x" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });
});

describe("legal_check_status", () => {
  const tool = () => statusFactory({ agentId: "rabbitmq-1749" })!;

  it("summarizes a completed job without leaking the jobId", async () => {
    mockGetJson.mockResolvedValue({
      job: { id: 6378, status: "Done", label: "某文章", rumor: 0, target: "" },
      detail: { result: "存在违规：虚假宣传", tableData: [{}, {}] },
      letterMap: { Personal: {}, GovPersonal: {} },
    });
    const res = parse(await tool().execute("s1", { jobId: 6378 }));
    expect(res).toMatchObject({
      success: true,
      status: "Done",
      statusLabel: "已完成",
      done: true,
      result: "存在违规：虚假宣传",
      paragraphCount: 2,
      letters: ["Personal", "GovPersonal"],
      detailPath: "/business/content/6378",
    });
    expect(res).not.toHaveProperty("jobId");
  });

  it("polls the most recent job for the account when called with no arguments", async () => {
    const localStore = new RecentJobStore();
    const create = createLegalCheckCreateToolFactory(
      fakeApi,
      resolver,
      localStore,
    )({
      agentId: "rabbitmq-1749",
    })!;
    const status = createLegalCheckStatusToolFactory(
      fakeApi,
      resolver,
      localStore,
    )({
      agentId: "rabbitmq-1749",
    })!;

    mockPostForm.mockResolvedValue({ job: { id: 7001, label: "新文章", status: "Pending" } });
    await create.execute("c1", { content: "https://a.com/x" });

    mockGetJson.mockResolvedValue({ job: { id: 7001, status: "Running", rumor: 0 } });
    const res = parse(await status.execute("s2", {}));

    const [, , query] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(query).toMatchObject({ id: 7001 });
    expect(res).toMatchObject({
      success: true,
      status: "Running",
      detailPath: "/business/content/7001",
    });
  });

  it("errors when there is no recent job and no id is given", async () => {
    const status = createLegalCheckStatusToolFactory(
      fakeApi,
      resolver,
      new RecentJobStore(),
    )({
      agentId: "rabbitmq-1749",
    })!;
    const res = parse(await status.execute("s3", {}));
    expect(res.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
