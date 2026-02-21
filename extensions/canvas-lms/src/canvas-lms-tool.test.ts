import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { __test, createCanvasLmsTool } from "./canvas-lms-tool.js";

function fakeApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: "canvas-lms",
    name: "canvas-lms",
    source: "test",
    config: {},
    pluginConfig: {},
    // oxlint-disable-next-line typescript/no-explicit-any
    runtime: { version: "test" } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHttpHandler() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerHook() {},
    registerHttpRoute() {},
    registerCommand() {},
    on() {},
    resolvePath: (p) => p,
    ...overrides,
  };
}

describe("canvas-lms-tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes base URL", () => {
    expect(__test.normalizeBaseUrl("https://canvas.example.edu/")).toBe(
      "https://canvas.example.edu",
    );
    expect(() => __test.normalizeBaseUrl("ftp://canvas.example.edu")).toThrow(/http/);
  });

  it("extracts next link from link header", () => {
    const link =
      '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next", <https://canvas.example.edu/api/v1/courses?page=7>; rel="last"';
    expect(__test.extractNextLink(link)).toContain("page=2");
  });

  it("fetches courses with plugin config", async () => {
    const response = new Response(
      JSON.stringify([{ id: 1, name: "Arquitectura de Software", course_code: "INF-501" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
        },
      }),
    );

    const result = await tool.execute("call-1", { action: "list_courses" });
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Arquitectura de Software");
  });

  it("requires course id for assignments", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
        },
      }),
    );
    await expect(
      tool.execute("call-2", {
        action: "list_assignments",
      }),
    ).rejects.toThrow(/courseId/);
  });
});
