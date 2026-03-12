import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import findooPlugin from "../index.js";

describe("findoo-plugin registration", () => {
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
      log: (level: string, msg: string) => logs.push({ level, msg }),
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
    expect(findooPlugin.id).toBe("findoo-plugin");
    expect(findooPlugin.name).toBe("Findoo");
    expect(findooPlugin.kind).toBe("financial");
  });

  it("registers 1 tool (async submit + heartbeat push mode)", () => {
    // Mock fetch for startup health check
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const api = createMockApi();
    findooPlugin.register(api);

    expect(api.tools.size).toBe(1);
    expect(api.tools.has("fin_analyze")).toBe(true);
    // fin_analyze_skills removed — no longer needed
    expect(api.tools.has("fin_analyze_skills")).toBe(false);

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
