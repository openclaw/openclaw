import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const {
  createJobListToolFactory,
  createJobStopToolFactory,
  createLetterGenerateToolFactory,
  createLetterFetchToolFactory,
} = await import("./ai-tools.js");

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
    expect(createJobListToolFactory(fakeApi, resolver)({ agentId: "telegram-1" })).toBeNull();
    expect(createLetterGenerateToolFactory(fakeApi, resolver)({ agentId: undefined })).toBeNull();
  });
});

describe("job_list", () => {
  it("lists pr-workspace jobs with status labels", async () => {
    const tool = createJobListToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({
      code: "success",
      total: 1,
      jobs: [{ id: 1, label: "某检测", status: "Done", rate: 4.5, completion: 100, date: "d" }],
    });
    const res = parse(await tool.execute("j1", {}));
    const [, path, params] = mockGetJson.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/ai/fetch-jobs");
    expect(params).toMatchObject({ workspace: "pr" });
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({
      label: "某检测",
      status: "Done",
      statusLabel: "已完成",
    });
  });
});

describe("letter_generate", () => {
  const tool = () => createLetterGenerateToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;

  it("rejects short errors without any backend call", async () => {
    const res = parse(await tool().execute("g0", { errors: "太短" }));
    expect(res.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("resolves the latest jobId then posts generate-letter", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6032 }] });
    mockPostForm.mockResolvedValue({ code: "success", message: "正在生成，请稍等！" });
    const res = parse(
      await tool().execute("g1", { errors: "这是一段足够长的违规内容描述，包含虚假事实与法规引用。", all: true }),
    );
    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/ai/generate-letter");
    expect(fields).toMatchObject({ jobId: 6032, siteId: "legal", all: 1 });
    expect(res).toMatchObject({ success: true, submitted: true });
    expect(res).not.toHaveProperty("status");
  });

  it("surfaces the backend 'too minor' error", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6032 }] });
    mockPostForm.mockResolvedValue({ code: "error", message: "文章违规程度较低，无法生成撤稿函" });
    const res = parse(
      await tool().execute("g2", { errors: "这是一段足够长的违规内容描述，包含虚假事实与法规引用。" }),
    );
    expect(res).toMatchObject({ success: false, error: "文章违规程度较低，无法生成撤稿函" });
  });

  it("errors when there is no recent job", async () => {
    mockGetJson.mockResolvedValue({ jobs: [] });
    const res = parse(
      await tool().execute("g3", { errors: "这是一段足够长的违规内容描述，包含虚假事实与法规引用。" }),
    );
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });
});

describe("letter_fetch", () => {
  it("maps letterMap to a list with category labels", async () => {
    const tool = createLetterFetchToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6052 }] });
    mockPostForm.mockResolvedValue({
      code: "success",
      letterMap: {
        Retraction: { id: 1, category: "Retraction", content: "撤稿函正文" },
        Report: { id: 2, category: "Report", content: "举报信正文" },
      },
      size: 2,
    });
    const res = parse(await tool.execute("lf1"));
    const [, path, fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(path).toBe("/ai/fetch-letters");
    expect(fields).toMatchObject({ jobId: 6052 });
    expect(res.count).toBe(2);
    expect((res.letters as Array<Record<string, unknown>>)[0]).toMatchObject({
      category: "Retraction",
      categoryLabel: "撤稿函",
      content: "撤稿函正文",
    });
  });

  it("treats an empty letterMap array as zero letters", async () => {
    const tool = createLetterFetchToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6052 }] });
    mockPostForm.mockResolvedValue({ code: "success", letterMap: [], size: 0 });
    const res = parse(await tool.execute("lf2"));
    expect(res).toMatchObject({ success: true, count: 0 });
  });
});

describe("job_stop", () => {
  it("resolves latest job and posts stop-job/{id}", async () => {
    const tool = createJobStopToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6058 }] });
    mockPostForm.mockResolvedValue({ code: "success", job: { id: 6058, label: "某检测", status: "stop" } });
    const res = parse(await tool.execute("st1"));
    const [, path] = mockPostForm.mock.calls[0] as [unknown, string];
    expect(path).toBe("/ai/stop-job/6058");
    expect(res).toMatchObject({ success: true, label: "某检测" });
  });
});
