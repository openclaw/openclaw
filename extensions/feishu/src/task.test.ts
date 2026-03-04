import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuTaskTools } from "./task.js";

const httpRequestMock = vi.hoisted(() => vi.fn());
const formatPayloadMock = vi.hoisted(() =>
  vi.fn(async () => ({ headers: { Authorization: "Bearer test_token" }, data: {}, params: {} })),
);
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    domain: "https://open.feishu.cn",
    formatPayload: formatPayloadMock,
    httpInstance: { request: httpRequestMock },
  })),
);

const getUserAccessTokenMock = vi.hoisted(() =>
  vi.fn(
    async (_client: unknown, _accountId: string, _userId: string): Promise<string | null> =>
      "user_test_token",
  ),
);
const buildToolAuthUrlMock = vi.hoisted(() =>
  vi.fn(() => "https://open.feishu.cn/open-apis/authen/v1/authorize?mock"),
);

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./user-auth.js", () => ({
  getUserAccessToken: getUserAccessTokenMock,
  buildToolAuthUrl: buildToolAuthUrlMock,
}));

function createConfig(opts: { task?: boolean; hasAccount?: boolean }) {
  const tools = opts.task === false ? { task: false } : { task: true };
  const base = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_test",
        appSecret: "secret",
        tools: opts.hasAccount === false ? undefined : tools,
      },
    },
  };
  if (opts.hasAccount === false) {
    (base.channels as { feishu: Record<string, unknown> }).feishu.appId = undefined;
    (base.channels as { feishu: Record<string, unknown> }).feishu.appSecret = undefined;
  }
  return base;
}

function registerTool() {
  const fn = vi.fn();
  registerFeishuTaskTools({
    config: createConfig({ task: true }) as never,
    logger: { debug: vi.fn(), info: vi.fn() } as never,
    registerTool: fn,
  } as never);
  expect(fn).toHaveBeenCalledTimes(1);
  const factory = fn.mock.calls[0]?.[0];
  return factory({ agentAccountId: undefined, requesterSenderId: "ou_test_user" });
}

describe("registerFeishuTaskTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    httpRequestMock.mockResolvedValue({
      code: 0,
      data: { task: { guid: "task_abc", summary: "Test task" } },
    });
  });

  // ---- create ----

  it("creates a task with summary only", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "create", summary: "My task" });
    expect(result.details).toEqual(
      expect.objectContaining({ task_id: "task_abc", summary: "Test task" }),
    );
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks",
      data: { summary: "My task" },
    });
  });

  it("creates a task with due, description and members", async () => {
    const tool = registerTool();
    await tool.execute("tc_1", {
      action: "create",
      summary: "Full task",
      description: "desc",
      due: "1675742789470",
      members: [{ id: "ou_1", role: "assignee" }],
    });
    expect(httpRequestMock.mock.calls[0]?.[0].data).toEqual({
      summary: "Full task",
      description: "desc",
      due: { timestamp: "1675742789470", is_all_day: false },
      members: [{ id: "ou_1", type: "user", role: "assignee" }],
    });
  });

  it("returns error when create is called without summary", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "create" });
    expect(result.details).toEqual({ error: "summary is required for create action" });
  });

  // ---- get ----

  it("gets a task by ID", async () => {
    httpRequestMock.mockResolvedValueOnce({
      code: 0,
      data: { task: { guid: "task_abc", summary: "Got it", description: "details" } },
    });
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "get", task_id: "task_abc" });
    expect(result.details).toEqual(
      expect.objectContaining({ guid: "task_abc", summary: "Got it" }),
    );
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks/task_abc",
    });
  });

  it("returns error when get is called without task_id", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "get" });
    expect(result.details).toEqual({ error: "task_id is required for get action" });
  });

  // ---- list ----

  it("lists tasks with pagination (user token)", async () => {
    httpRequestMock.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [{ guid: "t1" }, { guid: "t2" }],
        has_more: true,
        page_token: "next_page",
      },
    });
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "list", page_size: 10 });
    expect(result.details).toEqual({
      items: [{ guid: "t1" }, { guid: "t2" }],
      has_more: true,
      page_token: "next_page",
    });
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks",
      headers: expect.objectContaining({ Authorization: "Bearer user_test_token" }),
      params: expect.objectContaining({ page_size: "10" }),
    });
  });

  it("returns auth error with auth_url when no user token available for list", async () => {
    getUserAccessTokenMock.mockResolvedValueOnce(null);
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "list" });
    expect(result.details).toEqual(expect.objectContaining({ error: "NOT_AUTHORIZED" }));
    expect(result.details.auth_url).toBe(
      "https://open.feishu.cn/open-apis/authen/v1/authorize?mock",
    );
    expect(result.details.message).toContain("click this link");
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  // ---- update ----

  it("updates a task", async () => {
    httpRequestMock.mockResolvedValueOnce({
      code: 0,
      data: { task: { guid: "task_abc", summary: "Updated" } },
    });
    const tool = registerTool();
    const result = await tool.execute("tc_1", {
      action: "update",
      task_id: "task_abc",
      summary: "Updated",
    });
    expect(result.details).toEqual(expect.objectContaining({ summary: "Updated" }));
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "PATCH",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks/task_abc",
      data: { task: { summary: "Updated" }, update_fields: ["summary"] },
    });
  });

  it("returns error when update is called without task_id", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "update", summary: "x" });
    expect(result.details).toEqual({ error: "task_id is required for update action" });
  });

  // ---- complete ----

  it("completes a task", async () => {
    httpRequestMock.mockResolvedValueOnce({ code: 0, data: {} });
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "complete", task_id: "task_abc" });
    expect(result.details).toEqual({ task_id: "task_abc", completed: true });
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks/task_abc/complete",
    });
  });

  it("returns error when complete is called without task_id", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "complete" });
    expect(result.details).toEqual({ error: "task_id is required for complete action" });
  });

  // ---- delete ----

  it("deletes a task", async () => {
    httpRequestMock.mockResolvedValueOnce({ code: 0, data: {} });
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "delete", task_id: "task_abc" });
    expect(result.details).toEqual({ task_id: "task_abc", deleted: true });
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "DELETE",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks/task_abc",
    });
  });

  it("returns error when delete is called without task_id", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "delete" });
    expect(result.details).toEqual({ error: "task_id is required for delete action" });
  });

  // ---- add_members ----

  it("adds members to a task", async () => {
    httpRequestMock.mockResolvedValueOnce({
      code: 0,
      data: { task: { guid: "task_abc" } },
    });
    const tool = registerTool();
    const result = await tool.execute("tc_1", {
      action: "add_members",
      task_id: "task_abc",
      members: [{ id: "ou_1", role: "assignee" }],
    });
    expect(result.details).toEqual(expect.objectContaining({ guid: "task_abc" }));
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks/task_abc/add_members",
      data: { members: [{ id: "ou_1", role: "assignee" }] },
    });
  });

  it("returns error when add_members is called without task_id", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", {
      action: "add_members",
      members: [{ id: "ou_1" }],
    });
    expect(result.details).toEqual({ error: "task_id is required for add_members action" });
  });

  it("returns error when add_members is called without members", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", {
      action: "add_members",
      task_id: "task_abc",
    });
    expect(result.details).toEqual({ error: "members is required for add_members action" });
  });

  // ---- add_comment ----

  it("adds a comment to a task", async () => {
    httpRequestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment: { id: "comment_1", content: "Hello" } },
    });
    const tool = registerTool();
    const result = await tool.execute("tc_1", {
      action: "add_comment",
      task_id: "task_abc",
      comment: "Hello",
    });
    expect(result.details).toEqual(expect.objectContaining({ id: "comment_1", content: "Hello" }));
    expect(httpRequestMock.mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      url: "https://open.feishu.cn/open-apis/task/v2/tasks/task_abc/comments",
      data: { content: "Hello" },
    });
  });

  it("returns error when add_comment is called without task_id", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "add_comment", comment: "x" });
    expect(result.details).toEqual({ error: "task_id is required for add_comment action" });
  });

  it("returns error when add_comment is called without comment", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_1", {
      action: "add_comment",
      task_id: "task_abc",
    });
    expect(result.details).toEqual({ error: "comment is required for add_comment action" });
  });

  // ---- API error ----

  it("returns error in details when API returns code !== 0", async () => {
    httpRequestMock.mockResolvedValueOnce({
      code: 1470416,
      msg: "title and rich_summary are empty",
    });
    const tool = registerTool();
    const result = await tool.execute("tc_1", { action: "create", summary: "x" });
    expect(result.details).toEqual(
      expect.objectContaining({ error: expect.stringContaining("title and rich_summary") }),
    );
  });

  // ---- registration guards ----

  it("skips registration when tools.task is false", () => {
    const fn = vi.fn();
    registerFeishuTaskTools({
      config: createConfig({ task: false }) as never,
      logger: { debug: vi.fn(), info: vi.fn() } as never,
      registerTool: fn,
    } as never);
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips registration when no config", () => {
    const fn = vi.fn();
    registerFeishuTaskTools({
      config: undefined,
      logger: { debug: vi.fn(), info: vi.fn() } as never,
      registerTool: fn,
    } as never);
    expect(fn).not.toHaveBeenCalled();
  });

  it("skips registration when no enabled Feishu account", () => {
    const fn = vi.fn();
    registerFeishuTaskTools({
      config: createConfig({ hasAccount: false }) as never,
      logger: { debug: vi.fn(), info: vi.fn() } as never,
      registerTool: fn,
    } as never);
    expect(fn).not.toHaveBeenCalled();
  });
});
