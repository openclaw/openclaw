import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BacktestClient } from "./backtest-client.js";

const BASE_URL = "http://localhost:8000";
const API_KEY = "test-key";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("BacktestClient", () => {
  let client: BacktestClient;

  beforeEach(() => {
    client = new BacktestClient(BASE_URL, API_KEY, 30_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submit() posts to /backtests", async () => {
    const task = { task_id: "t1", status: "queued", engine: "script" };
    vi.stubGlobal("fetch", mockFetch(200, task));

    const result = await client.submit({
      strategy_dir: "strats/momentum",
      engine: "script",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });

    expect(result.task_id).toBe("t1");
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/backtests`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("getTask() fetches /backtests/:id", async () => {
    const task = { task_id: "t1", status: "running" };
    vi.stubGlobal("fetch", mockFetch(200, task));

    const result = await client.getTask("t1");
    expect(result.status).toBe("running");
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/backtests/t1`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("getReport() fetches /backtests/:id/report", async () => {
    const report = {
      task_id: "t1",
      result_summary: { total_return: 0.15 },
      trades: [],
      equity_curve: [],
    };
    vi.stubGlobal("fetch", mockFetch(200, report));

    const result = await client.getReport("t1");
    expect(result.task_id).toBe("t1");
    expect(result.result_summary.total_return).toBe(0.15);
  });

  it("listTasks() uses limit/offset params", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { tasks: [], total: 0, limit: 10, offset: 5 }));

    const result = await client.listTasks(10, 5);
    expect(result.total).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/backtests?limit=10&offset=5`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("cancelTask() posts to /backtests/:id/cancel", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { success: true }));

    const result = await client.cancelTask("t1");
    expect(result.success).toBe(true);
  });

  it("uploadStrategy() posts multipart to /backtests/upload", async () => {
    const uploadResp = { task_id: "t1", status: "submitted", message: "ok" };
    vi.stubGlobal("fetch", mockFetch(200, uploadResp));

    const buf = Buffer.from("fake-tar-gz");
    const result = await client.uploadStrategy(buf, "test.tar.gz");

    expect(result.task_id).toBe("t1");
    expect(result.status).toBe("submitted");
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/backtests/upload`,
      expect.objectContaining({ method: "POST" }),
    );
    // Should NOT have Content-Type: application/json (multipart auto-set)
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers["Content-Type"]).toBeUndefined();
  });

  it("uploadStrategy() appends optional params as form fields", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { task_id: "t2", status: "queued", message: "ok" }));

    const buf = Buffer.from("fake");
    await client.uploadStrategy(buf, "test.tar.gz", {
      symbol: "BTC-USD",
      engine: "script",
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1].body as FormData;
    expect(body.get("symbol")).toBe("BTC-USD");
    expect(body.get("engine")).toBe("script");
  });

  it("health() fetches /health", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { status: "ok", engines: ["script", "agent"] }));

    const result = await client.health();
    expect(result.status).toBe("ok");
  });

  it("throws on non-OK response", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { detail: "Internal server error" }));

    await expect(client.getTask("t1")).rejects.toThrow("Backtest API error (500)");
  });

  it("throws on non-JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "not json",
      } as Response),
    );

    await expect(client.getTask("t1")).rejects.toThrow("non-JSON");
  });

  it("includes X-API-Key header when apiKey set", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { status: "ok" }));

    await client.health();
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers["X-API-Key"]).toBe("test-key");
  });

  it("omits X-API-Key header when apiKey empty", async () => {
    const noKeyClient = new BacktestClient(BASE_URL, "", 30_000);
    vi.stubGlobal("fetch", mockFetch(200, { status: "ok" }));

    await noKeyClient.health();
    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].headers["X-API-Key"]).toBeUndefined();
  });
});
