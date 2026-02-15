import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryOpenVikingConfigSchema } from "./config.js";

describe("memory-openviking config", () => {
  beforeEach(() => {
    delete process.env.OPENVIKING_BASE_URL;
    delete process.env.OPENVIKING_URL;
    delete process.env.OPENVIKING_API_KEY;
    delete process.env.MEMORY_OPENVIKING_API_KEY;
  });

  it("parses defaults", () => {
    const cfg = memoryOpenVikingConfigSchema.parse({});
    expect(cfg.baseUrl).toBe("http://127.0.0.1:1933");
    expect(cfg.targetUri).toBe("viking://");
    expect(cfg.recallLimit).toBe(6);
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.autoRecall).toBe(true);
  });

  it("supports env variable interpolation", () => {
    process.env.MEMORY_OPENVIKING_API_KEY = "secret-token";
    const cfg = memoryOpenVikingConfigSchema.parse({
      apiKey: "${MEMORY_OPENVIKING_API_KEY}",
      baseUrl: "http://localhost:2933/",
      recallLimit: "7",
      recallScoreThreshold: "0.6",
    });
    expect(cfg.apiKey).toBe("secret-token");
    expect(cfg.baseUrl).toBe("http://localhost:2933");
    expect(cfg.recallLimit).toBe(7);
    expect(cfg.recallScoreThreshold).toBe(0.6);
  });
});

describe("memory-openviking plugin search behavior", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("uses hybrid search endpoint defaults and plugin-side postprocess for recall", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      requests.push({ url, body });

      if (url.endsWith("/api/v1/search/search")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            result: {
              total: 4,
              memories: [
                {
                  uri: "viking://user/memories/preferences/mem_black_1.md",
                  category: "preferences",
                  is_leaf: true,
                  abstract: "Color preference: Black",
                  score: 0.02,
                },
                {
                  uri: "viking://user/memories/preferences/mem_black_2.md",
                  category: "preferences",
                  is_leaf: true,
                  abstract: "Color preference: Black",
                  score: 0.019,
                },
                {
                  uri: "viking://user/memories/preferences/mem_red_1.md",
                  category: "preferences",
                  is_leaf: true,
                  abstract: "Flower preference: Likes red flowers",
                  score: 0.015,
                },
                {
                  uri: "viking://user/memories/preferences/mem_low_score.md",
                  category: "preferences",
                  is_leaf: true,
                  abstract: "Flower preference: Likes red flowers",
                  score: 0.001,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredTools: any[] = [];
    const mockApi = {
      id: "memory-openviking",
      name: "Memory (OpenViking)",
      source: "test",
      config: {},
      pluginConfig: {
        baseUrl: "http://127.0.0.1:1933",
        apiKey: "test-key",
        targetUri: "viking://user/memories",
        autoCapture: false,
        autoRecall: false,
      },
      runtime: {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerTool: (tool: any, opts: any) => {
        registeredTools.push({ tool, opts });
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: () => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      registerCli: () => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      on: () => {},
      resolvePath: (p: string) => p,
    };

    // oxlint-disable-next-line typescript/no-explicit-any
    memoryPlugin.register(mockApi as any);

    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    expect(recallTool).toBeDefined();

    const recallResult = await recallTool.execute("recall-test", {
      query: "我买花时偏好什么颜色",
      limit: 3,
      scoreThreshold: 0.01,
    });

    expect(recallResult.details?.count).toBe(2);
    expect(recallResult.details?.memories?.map((m: { uri: string }) => m.uri)).toEqual([
      "viking://user/memories/preferences/mem_black_1.md",
      "viking://user/memories/preferences/mem_red_1.md",
    ]);

    const searchRequest = requests.find((req) => req.url.endsWith("/api/v1/search/search"));
    expect(searchRequest).toBeTruthy();
    expect(searchRequest?.body?.search_mode).toBeUndefined();
    expect(searchRequest?.body?.score_threshold).toBe(0);
    expect(searchRequest?.body?.limit).toBe(12);
  });

  it("auto-capture stores only user messages", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
      requests.push({ url, method, body });

      if (url.endsWith("/api/v1/sessions") && method === "POST") {
        return new Response(
          JSON.stringify({ status: "ok", result: { session_id: "session-test" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.endsWith("/extract") && method === "POST") {
        return new Response(JSON.stringify({ status: "ok", result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ status: "ok", result: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const listeners = new Map<string, any>();
    const mockApi = {
      id: "memory-openviking",
      name: "Memory (OpenViking)",
      source: "test",
      config: {},
      pluginConfig: {
        baseUrl: "http://127.0.0.1:1933",
        apiKey: "test-key",
        targetUri: "viking://user/memories",
        autoCapture: true,
        autoRecall: false,
      },
      runtime: {},
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerTool: () => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: () => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      registerCli: () => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      on: (eventName: string, handler: any) => {
        listeners.set(eventName, handler);
      },
      resolvePath: (p: string) => p,
    };

    // oxlint-disable-next-line typescript/no-explicit-any
    memoryPlugin.register(mockApi as any);

    const agentEnd = listeners.get("agent_end");
    expect(agentEnd).toBeDefined();

    await agentEnd({
      success: true,
      messages: [
        { role: "assistant", content: "记住：助手消息不应入库" },
        { role: "user", content: "记住：我喜欢红色花朵，买花时优先红色。" },
        { role: "assistant", content: [{ type: "text", text: "偏好黑色" }] },
      ],
    });

    const messageCalls = requests.filter(
      (req) => req.url.endsWith("/api/v1/sessions/session-test/messages") && req.method === "POST",
    );
    expect(messageCalls).toHaveLength(1);
    expect(messageCalls[0]?.body?.content).toBe("记住：我喜欢红色花朵，买花时优先红色。");
  });
});

const liveEnabled =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  Boolean(process.env.OPENVIKING_LIVE_BASE_URL) &&
  Boolean(process.env.OPENVIKING_LIVE_API_KEY);
const describeLive = liveEnabled ? describe : describe.skip;

describeLive("memory-openviking live integration", () => {
  it("executes store/recall/forget tools against live OpenViking", async () => {
    const { default: memoryPlugin } = await import("./index.js");

    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredTools: any[] = [];
    // oxlint-disable-next-line typescript/no-explicit-any
    const registeredServices: any[] = [];

    const mockApi = {
      id: "memory-openviking",
      name: "Memory (OpenViking)",
      source: "test",
      config: {},
      pluginConfig: {
        baseUrl: process.env.OPENVIKING_LIVE_BASE_URL,
        apiKey: process.env.OPENVIKING_LIVE_API_KEY,
        targetUri: "viking://user/memories",
        timeoutMs: 30000,
        autoCapture: false,
        autoRecall: false,
      },
      runtime: {},
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerTool: (tool: any, opts: any) => {
        registeredTools.push({ tool, opts });
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerService: (service: any) => {
        registeredServices.push(service);
      },
      // oxlint-disable-next-line typescript/no-explicit-any
      registerCli: () => {},
      // oxlint-disable-next-line typescript/no-explicit-any
      on: () => {},
      resolvePath: (p: string) => p,
    };

    // oxlint-disable-next-line typescript/no-explicit-any
    memoryPlugin.register(mockApi as any);

    expect(registeredTools.length).toBe(3);
    expect(registeredServices.length).toBe(1);
    await registeredServices[0].start?.();

    const storeTool = registeredTools.find((t) => t.opts?.name === "memory_store")?.tool;
    const recallTool = registeredTools.find((t) => t.opts?.name === "memory_recall")?.tool;
    const forgetTool = registeredTools.find((t) => t.opts?.name === "memory_forget")?.tool;

    expect(storeTool).toBeDefined();
    expect(recallTool).toBeDefined();
    expect(forgetTool).toBeDefined();

    const storeResult = await storeTool.execute("live-store", {
      text: "请记住：我偏好中文且简洁的技术回答。",
      role: "user",
    });
    expect(storeResult.details?.action).toBe("stored");
    expect(typeof storeResult.details?.extractedCount).toBe("number");

    const recallResult = await recallTool.execute("live-recall", {
      query: "用户偏好 中文 简洁",
      limit: 5,
      targetUri: "viking://user/memories",
    });
    expect(typeof recallResult.details?.count).toBe("number");

    const forgetResult = await forgetTool.execute("live-forget", {
      query: "用户偏好 中文 简洁",
      targetUri: "viking://user/memories",
      limit: 5,
    });
    expect(["none", "candidates", "deleted"]).toContain(forgetResult.details?.action);
  }, 120000);
});
