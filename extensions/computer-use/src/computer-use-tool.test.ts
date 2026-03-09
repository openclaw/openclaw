import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComputerUseTool } from "./computer-use-tool.js";

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    id: "computer-use",
    name: "computer-use",
    source: "test",
    config: {
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    },
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  };
}

describe("computer-use tool", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("starts a task with configured defaults", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ taskId: "task-1", status: "queued" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createComputerUseTool(
      fakeApi({
        pluginConfig: {
          executorBaseUrl: "http://127.0.0.1:8100/",
          defaultMaxSteps: 25,
          defaultTimeoutMs: 120000,
          defaultRequireConfirmation: true,
        },
      }) as never,
    );

    const result = await tool.execute("tool-1", { task: "Open settings" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8100/v1/tasks",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      task: "Open settings",
      sessionId: undefined,
      provider: "openai",
      model: "gpt-5.4",
      maxSteps: 25,
      timeoutMs: 120000,
      requireConfirmation: true,
      metadata: { source: "openclaw" },
    });

    expect(result).toMatchObject({
      details: {
        action: "start",
        executorBaseUrl: "http://127.0.0.1:8100",
        json: { taskId: "task-1", status: "queued" },
      },
    });
  });

  it("uses taskId for status checks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ taskId: "task-2", status: "running" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createComputerUseTool(
      fakeApi({
        pluginConfig: {
          executorBaseUrl: "http://127.0.0.1:8100",
        },
      }) as never,
    );

    const result = await tool.execute("tool-2", { action: "status", taskId: "task-2" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8100/v1/tasks/task-2",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result).toMatchObject({
      details: { action: "status", json: { taskId: "task-2", status: "running" } },
    });
  });

  it("passes confirm decisions through to the executor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ taskId: "task-3", status: "approved" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createComputerUseTool(
      fakeApi({
        pluginConfig: {
          executorBaseUrl: "http://127.0.0.1:8100",
          executorAuthToken: "secret",
        },
      }) as never,
    );

    await tool.execute("tool-3", { action: "confirm", taskId: "task-3", allow: false });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8100/v1/tasks/task-3/confirm",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String(init.body))).toEqual({ allow: false });
    expect((init.headers as Headers).get("authorization")).toBe("Bearer secret");
  });

  it("throws when executorBaseUrl is missing", async () => {
    const tool = createComputerUseTool(fakeApi() as never);
    await expect(tool.execute("tool-4", { task: "Open browser" })).rejects.toThrow(
      /executorBaseUrl/i,
    );
  });

  it("surfaces executor error payloads", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "blocked" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = createComputerUseTool(
      fakeApi({
        pluginConfig: {
          executorBaseUrl: "http://127.0.0.1:8100",
        },
      }) as never,
    );

    await expect(tool.execute("tool-5", { task: "Delete all files" })).rejects.toThrow(
      /Executor request failed \(409\)/,
    );
  });
});
