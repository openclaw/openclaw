import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import findooPlugin from "../index.js";

describe("findoo-alpha-plugin registration", () => {
  function createMockApi(): OpenClawPluginApi & {
    tools: Map<string, unknown>;
    services: Map<string, unknown>;
    logs: Array<{ level: string; msg: string }>;
  } {
    const tools = new Map<string, unknown>();
    const services = new Map<string, unknown>();
    const logs: Array<{ level: string; msg: string }> = [];

    return {
      tools,
      services,
      logs,
      pluginConfig: { apiKey: "test-license-key" },
      resolvePath: (p: string) => `/tmp/test/${p}`,
      logger: {
        info: (msg: string) => logs.push({ level: "info", msg }),
        warn: (msg: string) => logs.push({ level: "warn", msg }),
        error: (msg: string) => logs.push({ level: "error", msg }),
        debug: (msg: string) => logs.push({ level: "debug", msg }),
      },
      registerTool: (tool: { name: string }) => {
        tools.set(tool.name, tool);
      },
      runtime: { services },
    } as unknown as OpenClawPluginApi & {
      tools: Map<string, unknown>;
      services: Map<string, unknown>;
      logs: Array<{ level: string; msg: string }>;
    };
  }

  it("has correct metadata", () => {
    expect(findooPlugin.id).toBe("findoo-alpha-plugin");
    expect(findooPlugin.name).toBe("Findoo Alpha");
    expect(findooPlugin.kind).toBe("financial");
  });

  it("registers 1 tool (fin_analyze)", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const api = createMockApi();
    findooPlugin.register(api);

    expect(api.tools.size).toBe(1);
    expect(api.tools.has("fin_analyze")).toBe(true);

    vi.restoreAllMocks();
  });

  it("registers fin-strategy-agent service", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const api = createMockApi();
    findooPlugin.register(api);

    expect(api.services.has("fin-strategy-agent")).toBe(true);
    const svc = api.services.get("fin-strategy-agent") as { getConfig: () => unknown };
    const cfg = svc.getConfig() as { url: string; assistantId: string };
    expect(cfg.url).toBe("http://43.128.100.43:5085");
    expect(cfg.assistantId).toBe("d2310a07-b552-453c-a8bb-7b9b86de6b23");

    vi.restoreAllMocks();
  });

  it("skips registration without license key", () => {
    const api = createMockApi();
    (api as unknown as { pluginConfig: Record<string, unknown> }).pluginConfig = {};
    findooPlugin.register(api);

    expect(api.tools.size).toBe(0);
    expect(api.services.size).toBe(0);
    expect(api.logs.some((l) => l.msg.includes("license key not configured"))).toBe(true);
  });

  it("logs webhook mode when webhookUrl configured", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const api = createMockApi();
    (api as unknown as { pluginConfig: Record<string, unknown> }).pluginConfig = {
      apiKey: "test-key",
      webhookUrl: "http://gateway:18789/hooks/wake",
      hooksToken: "test-token",
    };
    findooPlugin.register(api);

    expect(api.logs.some((l) => l.msg.includes("webhook mode"))).toBe(true);

    vi.restoreAllMocks();
  });

  it("logs sync fallback mode when no webhookUrl", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const api = createMockApi();
    findooPlugin.register(api);

    expect(api.logs.some((l) => l.msg.includes("sync fallback mode"))).toBe(true);

    vi.restoreAllMocks();
  });

  it("logs startup info", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const api = createMockApi();
    findooPlugin.register(api);

    expect(api.logs.some((l) => l.msg.includes("43.128.100.43:5085"))).toBe(true);
    expect(api.logs.some((l) => l.msg.includes("d2310a07"))).toBe(true);

    vi.restoreAllMocks();
  });
});
