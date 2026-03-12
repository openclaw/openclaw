import { describe, expect, it, vi, beforeEach } from "vitest";
import { A2AClient } from "../src/a2a-client.js";

describe("A2AClient", () => {
  let client: A2AClient;

  beforeEach(() => {
    client = new A2AClient("http://localhost:5085", "test-assistant-id");
  });

  it("constructs correct A2A message/send request", async () => {
    const mockResponse = {
      jsonrpc: "2.0",
      id: "req-1",
      result: { taskId: "task-123", status: "completed" },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const resp = await client.sendMessage("分析茅台");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:5085/a2a/test-assistant-id");
    expect(opts?.method).toBe("POST");

    const body = JSON.parse(opts?.body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("message/send");
    expect(body.params.message.role).toBe("user");
    expect(body.params.message.parts).toEqual([{ kind: "text", text: "分析茅台" }]);

    expect(resp.result).toEqual({ taskId: "task-123", status: "completed" });

    fetchSpy.mockRestore();
  });

  it("includes data part when context provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await client.sendMessage("分析个股", {
      data: { symbol: "600519.SS", market: "cn" },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.params.message.parts).toHaveLength(2);
    expect(body.params.message.parts[1]).toEqual({
      kind: "data",
      data: { symbol: "600519.SS", market: "cn" },
    });

    fetchSpy.mockRestore();
  });

  it("includes threadId when provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await client.sendMessage("继续分析", { threadId: "thread-abc" });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.params.thread).toEqual({ threadId: "thread-abc" });

    fetchSpy.mockRestore();
  });

  it("throws on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404, statusText: "Not Found" }),
    );

    await expect(client.sendMessage("test")).rejects.toThrow("A2A request failed: 404");

    vi.restoreAllMocks();
  });

  it("sends tasks/get request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          result: { taskId: "t-1", status: "completed", artifacts: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const resp = await client.getTask("t-1");

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.method).toBe("tasks/get");
    expect(body.params.taskId).toBe("t-1");
    expect(resp.result?.status).toBe("completed");

    fetchSpy.mockRestore();
  });
});
