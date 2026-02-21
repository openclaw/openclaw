import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  randomIdempotencyKey: vi.fn(() => "idem-sync"),
}));
vi.mock("../../../src/gateway/call.js", () => ({
  callGateway: gatewayMocks.callGateway,
  randomIdempotencyKey: gatewayMocks.randomIdempotencyKey,
}));
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
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.randomIdempotencyKey.mockReturnValue("idem-sync");
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

  it("parses oauth expiresAt values", () => {
    expect(__test.parseExpiresAtMs("1735689600")).toBe(1_735_689_600_000);
    expect(__test.parseExpiresAtMs("2026-03-01T00:00:00Z")).toBe(1_772_323_200_000);
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

  it("uses oauth access token when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 1, name: "OAuth Course" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          oauth: {
            clientId: "cid",
            clientSecret: "csecret",
            accessToken: "oauth-access-token",
            expiresAt: Date.now() + 10 * 60_000,
          },
        },
      }),
    );

    await tool.execute("call-oauth-1", { action: "list_courses" });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer oauth-access-token");
  });

  it("refreshes oauth token when expired", async () => {
    const tokenResponse = new Response(
      JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    const dataResponse = new Response(JSON.stringify([{ id: 1, name: "Refreshed Course" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse)
      .mockResolvedValueOnce(dataResponse);
    vi.stubGlobal("fetch", fetchMock);

    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          oauth: {
            clientId: "cid",
            clientSecret: "csecret",
            refreshToken: "old-refresh-token",
            accessToken: "old-access-token",
            expiresAt: Date.now() - 60_000,
          },
        },
      }),
    );

    await tool.execute("call-oauth-2", { action: "list_courses" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/login/oauth2/token");
    const apiHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(apiHeaders.Authorization).toBe("Bearer new-access-token");
  });

  it("enforces secure oauth token url by default", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          oauth: {
            tokenUrl: "http://canvas.example.edu/login/oauth2/token",
            clientId: "cid",
            clientSecret: "csecret",
            refreshToken: "rtok",
          },
        },
      }),
    );

    await expect(tool.execute("call-oauth-3", { action: "list_courses" })).rejects.toThrow(/https/);
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

  it("supports calendar, grades, and course files actions", async () => {
    const calendarResponse = new Response(
      JSON.stringify([
        {
          id: 501,
          title: "Prueba Parcial 1",
          start_at: "2026-03-12T10:00:00Z",
          end_at: "2026-03-12T11:30:00Z",
          all_day: false,
          html_url: "https://canvas.example.edu/calendar_events/501",
        },
      ]),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    const gradesResponse = new Response(
      JSON.stringify([
        {
          id: 9001,
          user_id: 42,
          type: "StudentEnrollment",
          grades: {
            current_grade: "A",
            current_score: 94.2,
            final_grade: "A-",
            final_score: 92.1,
          },
          current_points: 188.4,
        },
      ]),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    const filesResponse = new Response(
      JSON.stringify([
        {
          id: 777,
          display_name: "Syllabus.pdf",
          filename: "Syllabus.pdf",
          size: 245760,
          "content-type": "application/pdf",
          updated_at: "2026-02-01T15:00:00Z",
          url: "https://canvas.example.edu/files/777/download",
          locked: false,
        },
      ]),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(calendarResponse)
      .mockResolvedValueOnce(gradesResponse)
      .mockResolvedValueOnce(filesResponse);
    vi.stubGlobal("fetch", fetchMock);

    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
        },
      }),
    );

    const calendar = await tool.execute("call-6", {
      action: "list_calendar_events",
      courseId: "123",
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const calendarText = (calendar.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(calendarText).toContain("Prueba Parcial 1");

    const grades = await tool.execute("call-7", {
      action: "list_grades",
      courseId: "123",
      studentId: "self",
    });
    const gradesText = (grades.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(gradesText).toContain('"currentGrade": "A"');

    const files = await tool.execute("call-8", {
      action: "list_course_files",
      courseId: "123",
    });
    const filesText = (files.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(filesText).toContain("Syllabus.pdf");

    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls[0]).toContain("/calendar_events?");
    expect(calledUrls[1]).toContain("/courses/123/enrollments?");
    expect(calledUrls[2]).toContain("/courses/123/files?");
  });

  it("requires course id for calendar, grades, and course files", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
        },
      }),
    );

    await expect(tool.execute("call-9", { action: "list_calendar_events" })).rejects.toThrow(
      /courseId is required/,
    );
    await expect(tool.execute("call-10", { action: "list_grades" })).rejects.toThrow(
      /courseId is required/,
    );
    await expect(tool.execute("call-11", { action: "list_course_files" })).rejects.toThrow(
      /courseId is required/,
    );
  });

  it("builds digest and publishes to session when requested", async () => {
    const now = Date.now();
    const dueSoon = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const dueSoon2 = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString();
    const coursesResponse = new Response(
      JSON.stringify([{ id: 101, name: "Arquitectura de Software" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const assignmentsResponse = new Response(
      JSON.stringify([
        {
          id: 1,
          name: "Entrega 1",
          due_at: dueSoon,
          html_url: "https://canvas.example.edu/courses/101/assignments/1",
        },
        {
          id: 2,
          name: "Entrega 2",
          due_at: dueSoon2,
          html_url: "https://canvas.example.edu/courses/101/assignments/2",
        },
      ]),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(coursesResponse)
      .mockResolvedValueOnce(assignmentsResponse);
    vi.stubGlobal("fetch", fetchMock);
    gatewayMocks.callGateway.mockResolvedValue({ ok: true });

    const tool = createCanvasLmsTool(
      fakeApi({
        config: {},
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
        },
      }),
    );

    const result = await tool.execute("call-12", {
      action: "sync_academic_digest",
      digestWindow: "week",
      publish: true,
      publishSessionKey: "msteams:group:engineering",
      timeZone: "UTC",
    });

    const text = (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    expect(text).toContain("Academic sync (next 7 days)");
    expect(text).toContain("Entrega 1");
    expect(text).toContain("Entrega 2");

    expect(gatewayMocks.callGateway).toHaveBeenCalledTimes(1);
    const publishCall = gatewayMocks.callGateway.mock.calls[0]?.[0] as {
      method?: string;
      params?: { sessionKey?: string; message?: string; idempotencyKey?: string };
    };
    expect(publishCall.method).toBe("chat.send");
    expect(publishCall.params?.sessionKey).toBe("msteams:group:engineering");
    expect(publishCall.params?.idempotencyKey).toBe("idem-sync");
    expect(publishCall.params?.message).toContain("Academic sync");
  });

  it("requires publishSessionKey when publish is true for sync action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const tool = createCanvasLmsTool(
      fakeApi({
        pluginConfig: {
          baseUrl: "https://canvas.example.edu",
          token: "tkn",
        },
      }),
    );

    await expect(
      tool.execute("call-13", {
        action: "sync_academic_digest",
        publish: true,
      }),
    ).rejects.toThrow(/publishSessionKey is required/);
  });
});
