import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

describe("reportD0ToolLifecycle", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts TG tool lifecycle to backend when Donut runtime env is configured", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubEnv("D0_BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-token");

    const { reportD0ToolLifecycle } = await import("./d0-tool-analytics-reporter.js");

    const ok = await reportD0ToolLifecycle(
      {
        toolName: "read",
        runId: "run-tool-1",
        toolCallId: "tool-call-1",
        toolDetail: "show /tmp/file.txt",
        durationMs: 250,
        resultChars: 13,
        status: "success",
      },
      {
        sessionKey: "agent:main:telegram:direct:12345",
        sessionId: "ephemeral-session-1",
      },
    );

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://backend.internal/v1/backend/d0/tool-analytics",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer gateway-token",
          "content-type": "application/json",
        }),
      }),
    );
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        toolName: "read",
        status: "success",
        runId: "run-tool-1",
        toolCallId: "tool-call-1",
        sessionKey: "agent:main:telegram:direct:12345",
        sessionId: "ephemeral-session-1",
        toolDetail: "show /tmp/file.txt",
        durationMs: 250,
        resultChars: 13,
      }),
    );
  });

  it("posts main D0 tool lifecycle to backend when runtime env is configured", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubEnv("D0_BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-token");

    const { reportD0ToolLifecycle } = await import("./d0-tool-analytics-reporter.js");

    const ok = await reportD0ToolLifecycle(
      {
        toolName: "exec",
        runId: "run-tool-2",
        toolCallId: "tool-call-2",
        toolDetail: "git status",
        resultChars: 2,
        status: "success",
      },
      {
        sessionKey: "agent:main:main",
        sessionId: "ephemeral-session-2",
      },
    );

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        toolName: "exec",
        status: "success",
        runId: "run-tool-2",
        toolCallId: "tool-call-2",
        sessionKey: "agent:main:main",
        sessionId: "ephemeral-session-2",
        toolDetail: "git status",
        resultChars: 2,
      }),
    );
  });

  it("posts tracked main thread sessions to backend when runtime env is configured", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubEnv("D0_BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-token");

    const { reportD0ToolLifecycle } = await import("./d0-tool-analytics-reporter.js");

    const ok = await reportD0ToolLifecycle(
      {
        toolName: "read",
        runId: "run-tool-3",
        toolCallId: "tool-call-3",
        toolDetail: "read /tmp/thread.txt",
        resultChars: 7,
        status: "success",
      },
      {
        sessionKey: "agent:main:main:thread:9999",
        sessionId: "ephemeral-session-3",
      },
    );

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual(
      expect.objectContaining({
        toolName: "read",
        status: "success",
        runId: "run-tool-3",
        toolCallId: "tool-call-3",
        sessionKey: "agent:main:main:thread:9999",
        sessionId: "ephemeral-session-3",
        toolDetail: "read /tmp/thread.txt",
        resultChars: 7,
      }),
    );
  });

  it("skips non-telegram sessions", async () => {
    vi.stubEnv("D0_BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-token");

    const { reportD0ToolLifecycle } = await import("./d0-tool-analytics-reporter.js");

    const ok = await reportD0ToolLifecycle(
      {
        toolName: "read",
        runId: "run-tool-1",
        status: "success",
      },
      {
        sessionKey: "agent:main:webchat:direct:12345",
      },
    );

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when runtime env is missing", async () => {
    const { reportD0ToolLifecycle } = await import("./d0-tool-analytics-reporter.js");

    const ok = await reportD0ToolLifecycle(
      {
        toolName: "read",
        runId: "run-tool-1",
        status: "success",
      },
      {
        sessionKey: "agent:main:telegram:direct:12345",
      },
    );

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows backend request failures", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    vi.stubEnv("D0_BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "gateway-token");

    const { reportD0ToolLifecycle } = await import("./d0-tool-analytics-reporter.js");

    const ok = await reportD0ToolLifecycle(
      {
        toolName: "read",
        runId: "run-tool-1",
        status: "error",
        error: "tool failed",
      },
      {
        sessionKey: "agent:main:telegram:direct:12345",
      },
    );

    expect(ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
