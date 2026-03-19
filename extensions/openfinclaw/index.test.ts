/**
 * Unit tests for openfinclaw plugin: registration, config resolution, and tool execution with mocked HTTP.
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
  const details = (result as { details?: Record<string, unknown> }).details;
  if (details) return details;
  const content = (result as { content: Array<{ text: string }> }).content?.[0]?.text;
  if (!content) return {};
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function createFakeApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  tools: Map<string, Tool>;
} {
  const tools = new Map<string, Tool>();
  const api = {
    id: "openfinclaw",
    name: "OpenFinClaw",
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

describe("openfinclaw plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("has correct plugin metadata", () => {
    expect(plugin.id).toBe("openfinclaw");
    expect(plugin.name).toBe("OpenFinClaw");
  });

  it("registers all 3 tools", () => {
    const { api, tools } = createFakeApi({});
    plugin.register(api);

    expect(tools.size).toBe(7);
    expect(tools.has("skill_publish")).toBe(true);
    expect(tools.has("skill_publish_verify")).toBe(true);
    expect(tools.has("skill_validate")).toBe(true);
  });

  it("skill_publish_verify returns success when API returns 200 with submissionId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          submissionId: "sub-123",
          slug: "test-strategy",
          version: "1.0.0",
          backtestStatus: "completed",
          backtestCompleted: true,
          backtestReport: { performance: { totalReturn: 0.1, sharpe: 1.2 } },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({
      skillApiUrl: "http://skill.example",
      skillApiKey: "fch_test_key",
    });
    plugin.register(api);

    const result = parseResult(
      await tools.get("skill_publish_verify")!.execute("call-1", { submissionId: "sub-123" }),
    );

    expect(result.success).toBe(true);
    expect(result.slug).toBe("test-strategy");
    expect(result.backtestStatus).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/skill/publish/verify");
    expect(url).toContain("submissionId=sub-123");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer fch_test_key");
  });

  it("skill_publish_verify returns success when API returns 200 with backtestTaskId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          submissionId: "sub-456",
          backtestTaskId: "bt-789",
          backtestStatus: "processing",
          backtestCompleted: false,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({
      skillApiUrl: "http://skill.example",
      skillApiKey: "fch_test_key",
    });
    plugin.register(api);

    const result = parseResult(
      await tools.get("skill_publish_verify")!.execute("call-2", { backtestTaskId: "bt-789" }),
    );

    expect(result.success).toBe(true);
    expect(result.backtestStatus).toBe("processing");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("backtestTaskId=bt-789");
  });

  it("skill_publish requires filePath and apiKey", async () => {
    const { api, tools } = createFakeApi({});
    plugin.register(api);

    const result = parseResult(
      await tools.get("skill_publish")!.execute("call-3", { filePath: "" }),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("filePath is required");
  });

  it("skill_publish returns error when apiKey is not configured", async () => {
    const { api, tools } = createFakeApi({ skillApiUrl: "http://skill.example" });
    plugin.register(api);

    const result = parseResult(
      await tools.get("skill_publish")!.execute("call-4", { filePath: "/tmp/test.zip" }),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("API key not configured");
  });

  it("skill_publish sends POST with base64 content", async () => {
    vi.mocked(readFile).mockResolvedValue(Buffer.from("fake-zip-content"));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          slug: "test-skill",
          entryId: "entry-uuid",
          version: "1.0.0",
          status: "completed",
          submissionId: "sub-new",
          backtestTaskId: "bt-new",
          backtestStatus: "completed",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({
      skillApiUrl: "http://skill.example",
      skillApiKey: "fch_test_key",
    });
    plugin.register(api);

    const result = await tools.get("skill_publish")!.execute("call-5", {
      filePath: "/tmp/strategy.zip",
      visibility: "public",
    });

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.success).toBe(true);
    expect(details.slug).toBe("test-skill");
    expect(details.submissionId).toBe("sub-new");
    expect(readFile).toHaveBeenCalledWith("/tmp/strategy.zip");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/skill/publish");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe("ZmFrZS16aXAtY29udGVudA==");
    expect(body.visibility).toBe("public");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer fch_test_key");
  });

  it("returns error when submissionId and backtestTaskId both missing for verify", async () => {
    const { api, tools } = createFakeApi({ skillApiKey: "fch_test" });
    plugin.register(api);

    const result = parseResult(await tools.get("skill_publish_verify")!.execute("call-6", {}));

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("Either submissionId or backtestTaskId is required");
  });

  it("uses env SKILL_API_KEY when plugin config has no skillApiKey", async () => {
    vi.stubEnv("SKILL_API_KEY", "fch_env_key");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ submissionId: "sub-1", backtestStatus: "completed" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({ skillApiUrl: "http://skill.example" });
    plugin.register(api);

    await tools.get("skill_publish_verify")!.execute("call-7", { submissionId: "sub-1" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer fch_env_key");
  });

  describe("skill_validate", () => {
    it("returns invalid when dirPath is missing", async () => {
      const { api, tools } = createFakeApi({});
      plugin.register(api);
      const result = parseResult(await tools.get("skill_validate")!.execute("v1", { dirPath: "" }));
      expect(result.valid).toBe(false);
      expect(result.success).toBe(false);
      expect(Array.isArray(result.errors) && result.errors.length > 0).toBe(true);
    });

    it("returns invalid when fep.yaml is missing", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

      const { api, tools } = createFakeApi({});
      plugin.register(api);
      const result = parseResult(
        await tools.get("skill_validate")!.execute("v2", { dirPath: "/tmp/empty" }),
      );
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect((result.errors as string[]).some((e: string) => e.includes("fep.yaml"))).toBe(true);
    });
  });
});
