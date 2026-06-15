import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";

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

function parse(result: unknown): Record<string, unknown> {
  // jsonResult returns { content: [{ text }], details: payload }; details IS the payload.
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
    expect(createLegalCheckCreateToolFactory(fakeApi)({ agentId: "telegram-1" })).toBeNull();
    expect(createLegalCheckStatusToolFactory(fakeApi)({ agentId: undefined })).toBeNull();
  });

  it("exposes the tools to rabbitmq-<userId> agents", () => {
    expect(createLegalCheckCreateToolFactory(fakeApi)({ agentId: "rabbitmq-1749" })?.name).toBe(
      "legal_check_create",
    );
    expect(createLegalCheckStatusToolFactory(fakeApi)({ agentId: "rabbitmq-1749" })?.name).toBe(
      "legal_check_status",
    );
  });
});

describe("legal_check_create", () => {
  const tool = () => createLegalCheckCreateToolFactory(fakeApi)({ agentId: "rabbitmq-1749" })!;

  it("posts /legal/save-job with extracted link + violation defaults and returns the jobId", async () => {
    mockPostForm.mockResolvedValue({ job: { id: 6378, label: "某文章", status: "Pending" } });
    const res = parse(await tool().execute("c1", { content: "看 https://www.msn.cn/a 这条" }));

    expect(mockPostForm).toHaveBeenCalledTimes(1);
    const [, path, fields, userId] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(path).toBe("/legal/save-job");
    expect(userId).toBe("1749");
    expect(fields).toMatchObject({
      requirement: "看 https://www.msn.cn/a 这条",
      link: "https://www.msn.cn/a",
      rumor: 0,
      upload: 0,
      siteId: "legal",
    });
    expect(res).toMatchObject({
      success: true,
      jobId: 6378,
      mode: "violation",
      detailPath: "/business/content/6378",
    });
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
});

describe("legal_check_status", () => {
  const tool = () => createLegalCheckStatusToolFactory(fakeApi)({ agentId: "rabbitmq-1749" })!;

  it("summarizes a completed job", async () => {
    mockGetJson.mockResolvedValue({
      job: { id: 6378, status: "Done", label: "某文章", rumor: 0, target: "" },
      detail: { result: "存在违规：虚假宣传", tableData: [{}, {}] },
      letterMap: { Personal: {}, GovPersonal: {} },
    });
    const res = parse(await tool().execute("s1", { jobId: 6378 }));
    expect(res).toMatchObject({
      success: true,
      jobId: 6378,
      status: "Done",
      statusLabel: "已完成",
      done: true,
      result: "存在违规：虚假宣传",
      paragraphCount: 2,
      letters: ["Personal", "GovPersonal"],
    });
  });

  it("rejects a non-positive jobId without calling the backend", async () => {
    const res = parse(await tool().execute("s2", { jobId: 0 }));
    expect(res.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
  });
});
