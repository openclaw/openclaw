import { describe, expect, it, vi } from "vitest";
import {
  resolveSessionTracingHeaders,
  wrapStreamFnWithSessionTracing,
} from "./observability-session-headers.js";

describe("resolveSessionTracingHeaders", () => {
  it("returns undefined when sessionTracing is disabled", () => {
    expect(
      resolveSessionTracingHeaders({
        sessionKey: "agent:main:main",
        diagnostics: { sessionTracing: { enabled: false } },
      }),
    ).toBeUndefined();
  });

  it("returns undefined when sessionTracing config is missing", () => {
    expect(
      resolveSessionTracingHeaders({
        sessionKey: "agent:main:main",
        diagnostics: {},
      }),
    ).toBeUndefined();
  });

  it("returns undefined when sessionKey is missing", () => {
    expect(
      resolveSessionTracingHeaders({
        sessionKey: undefined,
        diagnostics: {
          sessionTracing: { enabled: true },
        },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for unparseable sessionKey", () => {
    expect(
      resolveSessionTracingHeaders({
        sessionKey: "not-a-valid-key",
        diagnostics: {
          sessionTracing: { enabled: true },
        },
      }),
    ).toBeUndefined();
  });

  it("uses default header names x-session-id and x-session-name", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:main:telegram:direct:12345",
      runId: "run-abc-123",
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });
    expect(result).toEqual({
      "x-session-id": "run-abc-123",
      "x-session-name": "agent:main:telegram:direct:12345",
    });
  });

  it("uses sessionKey as session name when not configured", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:my-agent:subagent:abc123",
      runId: "run-def-456",
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });
    expect(result).toEqual({
      "x-session-id": "run-def-456",
      "x-session-name": "agent:my-agent:subagent:abc123",
    });
  });

  it("uses configured session name when provided", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:main:main",
      runId: "run-ghi-789",
      diagnostics: {
        sessionTracing: {
          enabled: true,
          sessionName: "Custom Agent Name",
        },
      },
    });
    expect(result).toEqual({
      "x-session-id": "run-ghi-789",
      "x-session-name": "Custom Agent Name",
    });
  });

  it("uses custom header names when configured", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:main:main",
      runId: "run-jkl-012",
      diagnostics: {
        sessionTracing: {
          enabled: true,
          headers: {
            sessionId: "Helicone-Session-Id",
            sessionName: "Helicone-Session-Name",
          },
          sessionName: "OpenClaw",
        },
      },
    });
    expect(result).toEqual({
      "Helicone-Session-Id": "run-jkl-012",
      "Helicone-Session-Name": "OpenClaw",
    });
  });

  it("falls back to sessionKey when runId is not provided", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:main:main",
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });
    expect(result).toEqual({
      "x-session-id": "agent:main:main",
      "x-session-name": "agent:main:main",
    });
  });
});

describe("wrapStreamFnWithSessionTracing", () => {
  it("returns original streamFn when tracing is disabled", () => {
    const inner = vi.fn();
    const result = wrapStreamFnWithSessionTracing({
      streamFn: inner,
      sessionKey: "agent:main:main",
      diagnostics: { sessionTracing: { enabled: false } },
    });
    expect(result).toBe(inner);
  });

  it("wraps streamFn and merges headers into options", async () => {
    const inner = vi.fn().mockResolvedValue("done");
    const wrapped = wrapStreamFnWithSessionTracing({
      streamFn: inner,
      sessionKey: "agent:test-agent:subagent:abc",
      runId: "run-xyz-789",
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });
    expect(wrapped).not.toBe(inner);

    await wrapped({} as never, {} as never, { headers: { existing: "header" } });

    expect(inner).toHaveBeenCalledTimes(1);
    const callOptions = inner.mock.calls[0][2];
    expect(callOptions.headers).toEqual({
      "x-session-id": "run-xyz-789",
      "x-session-name": "agent:test-agent:subagent:abc",
      existing: "header",
    });
  });

  it("preserves caller headers over tracing headers on collision", async () => {
    const inner = vi.fn().mockResolvedValue("done");
    const wrapped = wrapStreamFnWithSessionTracing({
      streamFn: inner,
      sessionKey: "agent:main:main",
      runId: "run-collision-001",
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });

    await wrapped({} as never, {} as never, {
      headers: { "x-session-id": "override-value" },
    });

    expect(inner.mock.calls[0][2].headers["x-session-id"]).toBe("override-value");
  });

  it("passes headers when options had none", async () => {
    const inner = vi.fn().mockResolvedValue("done");
    const wrapped = wrapStreamFnWithSessionTracing({
      streamFn: inner,
      sessionKey: "agent:main:main",
      runId: "run-none-002",
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });

    await wrapped({} as never, {} as never, {});

    expect(inner.mock.calls[0][2].headers).toEqual({
      "x-session-id": "run-none-002",
      "x-session-name": "agent:main:main",
    });
  });
});
