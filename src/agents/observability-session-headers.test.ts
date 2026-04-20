import { describe, expect, it, vi } from "vitest";
import {
  resolveSessionTracingHeaders,
  wrapStreamFnWithSessionTracing,
} from "./observability-session-headers.js";
import type { DiagnosticsConfig } from "../config/types.base.js";

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
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });
    expect(result).toEqual({
      "x-session-id": "agent:main:telegram:direct:12345",
      "x-session-name": "main",
    });
  });

  it("derives session name from agent ID when not configured", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:my-agent:subagent:abc123",
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });
    expect(result).toEqual({
      "x-session-id": "agent:my-agent:subagent:abc123",
      "x-session-name": "my-agent",
    });
  });

  it("uses configured session name when provided", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:main:main",
      diagnostics: {
        sessionTracing: {
          enabled: true,
          sessionName: "Custom Agent Name",
        },
      },
    });
    expect(result).toEqual({
      "x-session-id": "agent:main:main",
      "x-session-name": "Custom Agent Name",
    });
  });

  it("uses custom header names when configured", () => {
    const result = resolveSessionTracingHeaders({
      sessionKey: "agent:main:main",
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
      "Helicone-Session-Id": "agent:main:main",
      "Helicone-Session-Name": "OpenClaw",
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
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });
    expect(wrapped).not.toBe(inner);

    await wrapped({} as never, {} as never, { headers: { existing: "header" } });

    expect(inner).toHaveBeenCalledTimes(1);
    const callOptions = inner.mock.calls[0][2];
    expect(callOptions.headers).toEqual({
      "x-session-id": "agent:test-agent:subagent:abc",
      "x-session-name": "test-agent",
      existing: "header",
    });
  });

  it("preserves caller headers over tracing headers on collision", async () => {
    const inner = vi.fn().mockResolvedValue("done");
    const wrapped = wrapStreamFnWithSessionTracing({
      streamFn: inner,
      sessionKey: "agent:main:main",
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
      diagnostics: {
        sessionTracing: { enabled: true },
      },
    });

    await wrapped({} as never, {} as never, {});

    expect(inner.mock.calls[0][2].headers).toEqual({
      "x-session-id": "agent:main:main",
      "x-session-name": "main",
    });
  });
});
