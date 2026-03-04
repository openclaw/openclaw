import type { OpenClawPluginApi } from "openfinclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

type Tool = {
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

type Service = {
  start: () => void;
  stop: () => void;
};

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<
    string,
    unknown
  >;
}

function createFakeApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  tools: Map<string, Tool>;
  services: Map<string, Service>;
} {
  const tools = new Map<string, Tool>();
  const services = new Map<string, Service>();
  const api = {
    id: "fin-info-feed",
    name: "Info Feed",
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
    registerService(svc: { id: string; start: () => void; stop: () => void }) {
      services.set(svc.id, svc);
    },
    registerProvider() {},
    registerCommand() {},
    resolvePath: (p: string) => `/tmp/fin-info-feed-test-${Date.now()}/${p}`,
    on() {},
  } as unknown as OpenClawPluginApi;

  return { api, tools, services };
}

describe("fin-info-feed plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // ── Stub / Live mode (existing tests) ──────────────────────

  it("returns explicit stub output in default mode", async () => {
    const { api, tools } = createFakeApi({});
    plugin.register(api);

    const result = parseResult(
      await tools.get("fin_info_search")!.execute("call-1", { query: "fed rates" }),
    );
    expect(result.success).toBe(true);
    const details = result.results as { status?: unknown; mode?: unknown };
    expect(details.status).toBe("stub");
    expect(details.mode).toBe("stub");
  });

  it("returns config error in live mode when credentials are missing", async () => {
    const { api, tools } = createFakeApi({ mode: "live" });
    plugin.register(api);

    const result = parseResult(
      await tools.get("fin_info_search")!.execute("call-2", { query: "BTC" }),
    );
    expect(String(result.error)).toContain("API key not configured");
  });

  it("calls remote backend in live mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [{ id: "n1", title: "News" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({
      mode: "live",
      apiKey: "token",
      endpoint: "https://feed.example",
    });
    plugin.register(api);

    const result = parseResult(
      await tools.get("fin_info_search")!.execute("call-3", {
        query: "ETH ETF",
        limit: 5,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://feed.example/v1/search");
    expect(init.method).toBe("POST");
    expect(result.success).toBe(true);
    const payload = result.results as { status?: unknown; mode?: unknown; data?: unknown };
    expect(payload.status).toBe("ok");
    expect(payload.mode).toBe("live");
    expect(payload.data).toEqual({ items: [{ id: "n1", title: "News" }] });
  });

  it("reads live configuration from env vars when plugin config is empty", async () => {
    vi.stubEnv("FIN_INFO_FEED_MODE", "live");
    vi.stubEnv("FIN_INFO_FEED_API_KEY", "env-token");
    vi.stubEnv("FIN_INFO_FEED_ENDPOINT", "https://feed-env.example");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ items: [{ id: "n2", title: "Env News" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { api, tools } = createFakeApi({});
    plugin.register(api);

    const result = parseResult(
      await tools.get("fin_info_search")!.execute("call-4", { query: "env finance" }),
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://feed-env.example/v1/search");
    expect(result.success).toBe(true);
    const payload = result.results as { mode?: unknown; data?: unknown };
    expect(payload.mode).toBe("live");
    expect(payload.data).toEqual({ items: [{ id: "n2", title: "Env News" }] });
  });

  // ── Grok mode ──────────────────────────────────────────────

  describe("grok mode", () => {
    it("registers scanner service in grok mode", () => {
      const { api, services } = createFakeApi({
        mode: "grok",
        grok: { apiKey: "xai-test", defaultHandles: "elonmusk,CryptoHayes" },
      });
      plugin.register(api);

      expect(services.has("fin-info-feed-scanner")).toBe(true);
    });

    it("fin_info_search calls grok API with handles", async () => {
      const mockItems = JSON.stringify([
        { handle: "elonmusk", title: "BTC news", score: 8, category: "crypto", sentiment: "bullish", symbols: ["BTC"] },
      ]);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output: [{ type: "message", content: [{ type: "output_text", text: mockItems, annotations: [] }] }],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { api, tools } = createFakeApi({
        mode: "grok",
        grok: { apiKey: "xai-test", defaultHandles: "elonmusk" },
      });
      plugin.register(api);

      const result = parseResult(
        await tools.get("fin_info_search")!.execute("grok-1", {
          query: "crypto markets",
        }),
      );

      expect(result.success).toBe(true);
      expect(result.mode).toBe("grok");
      const results = result.results as { items: unknown[]; totalHandles: number };
      expect(results.items).toHaveLength(1);
      expect(results.totalHandles).toBe(1);
    });

    it("fin_info_search returns error when API key missing", async () => {
      const { api, tools } = createFakeApi({
        mode: "grok",
        grok: { defaultHandles: "test" },
      });
      plugin.register(api);

      const result = parseResult(
        await tools.get("fin_info_search")!.execute("grok-2", { query: "BTC" }),
      );
      expect(String(result.error)).toContain("xAI API key not configured");
    });

    it("fin_info_search returns error when no handles available", async () => {
      const { api, tools } = createFakeApi({
        mode: "grok",
        grok: { apiKey: "xai-test" },
      });
      plugin.register(api);

      const result = parseResult(
        await tools.get("fin_info_search")!.execute("grok-3", { query: "BTC" }),
      );
      expect(String(result.error)).toContain("No handles");
    });

    it("fin_info_subscribe manages subscriptions in grok mode", async () => {
      const { api, tools } = createFakeApi({
        mode: "grok",
        grok: { apiKey: "xai-test" },
      });
      plugin.register(api);

      // Add subscriptions
      const addResult = parseResult(
        await tools.get("fin_info_subscribe")!.execute("sub-1", {
          action: "add",
          handles: ["elonmusk", "CryptoHayes"],
          priority: "high",
        }),
      );
      expect(addResult.success).toBe(true);
      expect(addResult.action).toBe("add");
      const subs = addResult.subscriptions as Array<{ handle: string }>;
      expect(subs).toHaveLength(2);

      // List subscriptions
      const listResult = parseResult(
        await tools.get("fin_info_subscribe")!.execute("sub-2", { action: "list" }),
      );
      expect(listResult.success).toBe(true);
      expect((listResult.subscriptions as unknown[]).length).toBe(2);

      // Remove subscription
      const removeResult = parseResult(
        await tools.get("fin_info_subscribe")!.execute("sub-3", {
          action: "remove",
          handles: ["elonmusk"],
        }),
      );
      expect(removeResult.success).toBe(true);
      expect((removeResult.subscriptions as unknown[]).length).toBe(1);
    });

    it("fin_info_digest returns urgent items in grok mode", async () => {
      // First insert some items via search
      const mockItems = JSON.stringify([
        { handle: "whale", title: "URGENT: Market crash", score: 10, category: "breaking", sentiment: "bearish", symbols: ["SPY"] },
        { handle: "analyst", title: "Routine update", score: 5, category: "opinion", sentiment: "neutral" },
      ]);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output: [{ type: "message", content: [{ type: "output_text", text: mockItems, annotations: [] }] }],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { api, tools } = createFakeApi({
        mode: "grok",
        grok: { apiKey: "xai-test", defaultHandles: "whale,analyst", urgentThreshold: "9" },
      });
      plugin.register(api);

      // First do a search to populate the store
      await tools.get("fin_info_search")!.execute("search-1", { query: "markets" });

      // Now get urgent digest
      const result = parseResult(
        await tools.get("fin_info_digest")!.execute("digest-1", { period: "urgent" }),
      );
      expect(result.success).toBe(true);
      expect(result.mode).toBe("grok");
      expect(result.period).toBe("urgent");
      const items = result.items as Array<{ score: number }>;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.score >= 9)).toBe(true);
    });

    it("fin_info_digest returns periodic digest with stats", async () => {
      const mockItems = JSON.stringify([
        { handle: "kol1", title: "Morning insight", score: 7, category: "macro", sentiment: "bullish", symbols: ["AAPL"] },
      ]);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output: [{ type: "message", content: [{ type: "output_text", text: mockItems, annotations: [] }] }],
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const { api, tools } = createFakeApi({
        mode: "grok",
        grok: { apiKey: "xai-test", defaultHandles: "kol1" },
      });
      plugin.register(api);

      // Populate store
      await tools.get("fin_info_search")!.execute("search-2", { query: "morning" });

      // Get morning digest
      const result = parseResult(
        await tools.get("fin_info_digest")!.execute("digest-2", { period: "morning" }),
      );
      expect(result.success).toBe(true);
      expect(result.period).toBe("morning");
      expect(result.stats).toBeDefined();
    });

    it("reads grok config from env vars", async () => {
      vi.stubEnv("FIN_INFO_FEED_MODE", "grok");
      vi.stubEnv("XAI_API_KEY", "xai-env-key");
      vi.stubEnv("OPENFINCLAW_FIN_INFO_KOL_HANDLES", "handle1,handle2");

      const { api, services } = createFakeApi({});
      plugin.register(api);

      expect(services.has("fin-info-feed-scanner")).toBe(true);
    });
  });
});
