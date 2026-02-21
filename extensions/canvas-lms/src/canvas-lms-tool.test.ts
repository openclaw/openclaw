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
    expect(() => __test.normalizeBaseUrl("http://canvas.example.edu")).toThrow(/https/);
    expect(__test.normalizeBaseUrl("http://canvas.example.edu", { allowInsecureHttp: true })).toBe(
      "http://canvas.example.edu",
    );
    expect(() => __test.normalizeBaseUrl("ftp://canvas.example.edu")).toThrow(/https/);
  });

  it("extracts next link from link header", () => {
    const link =
      '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next", <https://canvas.example.edu/api/v1/courses?page=7>; rel="last"';
    expect(__test.extractNextLink(link)).toContain("page=2");
  });

  it("parses retry-after header", () => {
    expect(__test.computeRetryAfterMs("2")).toBe(2000);
    expect(__test.computeRetryAfterMs("invalid")).toBeUndefined();
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

  it("retries transient 429 errors", async () => {
    const rateLimited = new Response(JSON.stringify([]), {
      status: 429,
      headers: { "retry-after": "0", "content-type": "application/json" },
    });
    const success = new Response(JSON.stringify([{ id: 10, name: "Retry OK" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(rateLimited).mockResolvedValueOnce(success);
    vi.stubGlobal("fetch", fetchMock);

    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
          maxRetries: 2,
          requestTimeoutMs: 10_000,
        },
      }),
    );

    const result = await tool.execute("call-1", { action: "list_courses" });
    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Retry OK");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("blocks inline token by default", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "configured-token",
        },
      }),
    );
    await expect(
      tool.execute("call-3", {
        action: "list_courses",
        token: "inline-token",
      }),
    ).rejects.toThrow(/Inline token is disabled/);
  });

  it("supports modules and submissions actions", async () => {
    const responses = [
      new Response(JSON.stringify([{ id: 7, name: "Semana 1", items: [{ id: 1 }, { id: 2 }] }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(
        JSON.stringify([
          {
            assignment_id: 99,
            user_id: 42,
            submitted_at: "2026-02-20T00:00:00Z",
            score: 95,
            grade: "A",
            workflow_state: "graded",
            late: false,
            missing: false,
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetchMock);

    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
        },
      }),
    );

    const modules = await tool.execute("call-4", {
      action: "list_modules",
      courseId: "123",
    });
    const modulesText = (modules.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(modulesText).toContain("Semana 1");

    const submissions = await tool.execute("call-5", {
      action: "list_submissions",
      courseId: "123",
      assignmentId: "99",
    });
    const submissionsText = (submissions.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(submissionsText).toContain('"assignmentId": 99');
  });
});
