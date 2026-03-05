/**
 * Unit tests for fin-backtest-remote plugin: registration, config resolution, and tool execution with mocked HTTP.
 */
import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));
const { readFile } = await import("node:fs/promises");

type Tool = {
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function parseResult(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content?.[0]?.text;
  if (!content) return {};
  return JSON.parse(content) as Record<string, unknown>;
}

function createFakeApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  tools: Map<string, Tool>;
} {
  const tools = new Map<string, Tool>();
  const api = {
    id: "fin-backtest-remote",
    name: "Backtest Remote",
    source: "test",
    config: {},
    pluginConfig,
    runtime: { version: "test", services: new Map() },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool(tool: { name: string; execute: Tool["execute"] }) {
      tools.set(tool.name, tool);
    },
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath: (p: string) => p,
    on() {},
  } as unknown as OpenClawPluginApi;

  return { api, tools };
}

describe("fin-backtest-remote plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("has correct plugin metadata", () => {
    expect(plugin.id).toBe("fin-backtest-remote");
    expect(plugin.name).toBe("Backtest Remote");
  });

  it("registers all 6 tools (including validate)", () => {
    const { api, tools } = createFakeApi({});
    plugin.register(api);

    expect(tools.size).toBe(6);
    expect(tools.has("backtest_remote_submit")).toBe(true);
    expect(tools.has("backtest_remote_status")).toBe(true);
    expect(tools.has("backtest_remote_report")).toBe(true);
    expect(tools.has("backtest_remote_list")).toBe(true);
    expect(tools.has("backtest_remote_cancel")).toBe(true);
    expect(tools.has("backtest_remote_validate")).toBe(true);
  });

  it("backtest_remote_status returns success when API returns 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          task_id: "bt-test-123",
          status: "completed",
          result_summary: { totalReturn: 0.1, sharpeRatio: 1.2 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({
      baseUrl: "http://backtest.example",
      apiKey: "test-key",
    });
    plugin.register(api);

    const result = parseResult(
      await tools.get("backtest_remote_status")!.execute("call-1", { task_id: "bt-test-123" }),
    );

    expect(result.success).toBe(true);
    expect(result.task_id).toBe("bt-test-123");
    expect(result.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/backtests/bt-test-123");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("test-key");
  });

  it("backtest_remote_report returns success when API returns 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          task_id: "bt-test-123",
          metadata: { name: "Test Strategy" },
          performance: { totalReturn: -0.1 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({ baseUrl: "http://backtest.example" });
    plugin.register(api);

    const result = parseResult(
      await tools.get("backtest_remote_report")!.execute("call-2", { task_id: "bt-test-123" }),
    );

    expect(result.success).toBe(true);
    expect(result.task_id).toBe("bt-test-123");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/backtests/bt-test-123/report"),
      expect.any(Object),
    );
  });

  it("backtest_remote_list returns success with query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ task_id: "bt-1", status: "completed" }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({ baseUrl: "http://backtest.example" });
    plugin.register(api);

    const result = parseResult(
      await tools.get("backtest_remote_list")!.execute("call-3", { limit: 5, offset: 0 }),
    );

    expect(result.success).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/api/v1/backtests");
    expect(url).toContain("limit=5");
    expect(url).toContain("offset=0");
  });

  it("backtest_remote_cancel returns success when API returns 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: "bt-queued-1", status: "cancelled" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({ baseUrl: "http://backtest.example" });
    plugin.register(api);

    const result = parseResult(
      await tools.get("backtest_remote_cancel")!.execute("call-4", { task_id: "bt-queued-1" }),
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("cancelled");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/backtests/bt-queued-1");
    expect(init.method).toBe("DELETE");
  });

  it("backtest_remote_submit requires filePath and calls POST with FormData", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("fake-zip-content"));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ task_id: "bt-new-1", status: "submitted", message: "Task submitted" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({
      baseUrl: "http://backtest.example",
      apiKey: "key",
    });
    plugin.register(api);

    const result = parseResult(
      await tools.get("backtest_remote_submit")!.execute("call-5", {
        filePath: "/tmp/strategy.zip",
        symbol: "BTC-USD",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.task_id).toBe("bt-new-1");
    expect(result.status).toBe("submitted");
    expect(readFile).toHaveBeenCalledWith("/tmp/strategy.zip");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/backtests");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("returns error when filePath is missing for submit", async () => {
    const { api, tools } = createFakeApi({});
    plugin.register(api);

    const result = parseResult(
      await tools.get("backtest_remote_submit")!.execute("call-6", { filePath: "" }),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("filePath is required");
  });

  it("returns error when task_id is missing for status", async () => {
    const { api, tools } = createFakeApi({});
    plugin.register(api);

    const result = parseResult(
      await tools.get("backtest_remote_status")!.execute("call-7", { task_id: "" }),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("task_id is required");
  });

  it("uses env BACKTEST_API_KEY when plugin config has no apiKey", async () => {
    vi.stubEnv("BACKTEST_API_KEY", "env-key");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ task_id: "bt-1", status: "completed" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({ baseUrl: "http://backtest.example" });
    plugin.register(api);

    await tools.get("backtest_remote_status")!.execute("call-8", { task_id: "bt-1" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("env-key");
  });

  describe("backtest_remote_validate", () => {
    it("returns invalid when dirPath is missing", async () => {
      const { api, tools } = createFakeApi({});
      plugin.register(api);
      const result = parseResult(
        await tools.get("backtest_remote_validate")!.execute("v1", { dirPath: "" }),
      );
      expect(result.valid).toBe(false);
      expect(result.success).toBe(false);
      expect(Array.isArray(result.errors) && result.errors.length > 0).toBe(true);
    });

    it("returns invalid when fep.yaml is missing", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      const { api, tools } = createFakeApi({});
      plugin.register(api);
      const result = parseResult(
        await tools.get("backtest_remote_validate")!.execute("v2", { dirPath: "/tmp/empty" }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect((result.errors as string[]).some((e: string) => e.includes("fep.yaml"))).toBe(true);
    });
  });
});
