// @ai-context: CAP-009 — Tests for MCP proxy logic (proxyToolCall).
// Covers: auth propagation, retry classification, timeout handling, HQ-down behavior.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  proxyToolCall,
  proxyReadOnlyToolCall,
  READ_ONLY_TOOLS,
  LONG_RUNNING_TOOLS,
  TOOL_TIMEOUT_MS,
  resetToolCallCounter,
  resetCallerInstanceCache,
  setCachedCallerInstanceId,
  getCachedCallerInstanceId,
  type ProxyConfig,
} from "../proxy.js";

// ── Helpers ──────────────────────────────────────────────────────────

const CONFIGURED_WORKSPACE_ID = "66666666-6666-4666-8666-666666666666";

function makeConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  return {
    hqBaseUrl: "http://localhost:3000",
    apiSecret: "test-secret",
    workspaceId: CONFIGURED_WORKSPACE_ID,
    retryDelayMs: 0,
    ...overrides,
  };
}

function getGenericCacheScope(
  workspaceId = CONFIGURED_WORKSPACE_ID,
  overrides: {
    hqBaseUrl?: string;
    apiSecret?: string;
  } = {},
) {
  const identityInput: Record<string, unknown> = {
    agent_name: process.env.AIRYA_AGENT_NAME?.trim() || "codex",
  };
  const tmuxSession = process.env.AIRYA_TMUX_SESSION?.trim();
  if (tmuxSession) {
    identityInput.tmux_session = tmuxSession;
  }
  const runtime = process.env.AIRYA_RUNTIME?.trim();
  if (runtime) {
    identityInput.runtime = runtime;
  }
  return {
    workspaceId,
    hqBaseUrl: overrides.hqBaseUrl ?? "http://localhost:3000",
    authContext: overrides.apiSecret ?? "test-secret",
    identityInput,
  };
}

function mockFetchOk(result: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result }),
  }) as unknown as typeof fetch;
}

function mockFetch4xx(status: number, error: string, code: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ ok: false, error, code }),
  }) as unknown as typeof fetch;
}

function mockFetch5xx(): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ ok: false, error: "Internal Server Error" }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  // Most tests focus on transport/classification behavior, not bootstrap.
  resetToolCallCounter();
  resetCallerInstanceCache();
  process.env.AIRYA_AGENT_NAME = "codex";
  delete process.env.AIRYA_TMUX_SESSION;
  delete process.env.AIRYA_RUNTIME;
  setCachedCallerInstanceId("inst-cached-001", getGenericCacheScope());
});

// ── Auth Propagation ─────────────────────────────────────────────────

describe("auth propagation", () => {
  it("sends Authorization header when apiSecret is set", async () => {
    const fetchFn = mockFetchOk({ data: "test" });
    const config = makeConfig({ fetchFn });

    await proxyToolCall("get_workspace_health", {}, config);

    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:3000/api/airya/tool",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-secret",
          "x-agent-instance-id": "inst-cached-001",
        }),
      }),
    );
  });

  it("omits Authorization header when apiSecret is undefined", async () => {
    const fetchFn = mockFetchOk({ data: "test" });
    const config = makeConfig({ apiSecret: undefined, fetchFn });
    resetCallerInstanceCache();
    setCachedCallerInstanceId(
      "inst-cached-noauth-001",
      getGenericCacheScope(CONFIGURED_WORKSPACE_ID, { apiSecret: "__noauth__" }),
    );

    await proxyToolCall("get_workspace_health", {}, config);

    const calledHeaders = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty("Authorization");
    expect(calledHeaders["x-agent-instance-id"]).toBe("inst-cached-noauth-001");
  });

  it("sends workspace_id in request body", async () => {
    const fetchFn = mockFetchOk({});
    const config = makeConfig({ workspaceId: "88888888-8888-4888-8888-888888888888", fetchFn });

    await proxyToolCall("get_workspace_health", {}, config);

    const calledBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(calledBody.workspace_id).toBe("88888888-8888-4888-8888-888888888888");
  });

  it("sends tool name and input in request body", async () => {
    const fetchFn = mockFetchOk({});
    const config = makeConfig({ fetchFn });

    await proxyToolCall("search_workflow_catalog", { query: "test" }, config);

    const calledBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(calledBody.tool).toBe("search_workflow_catalog");
    expect(calledBody.input).toEqual({ query: "test" });
  });

  it("resolves the authoritative workspace before proxying when config still points at the legacy nil workspace", async () => {
    const authoritativeWorkspaceId = "77777777-7777-4777-8777-777777777777";
    setCachedCallerInstanceId(
      "inst-cached-authoritative-001",
      getGenericCacheScope(authoritativeWorkspaceId),
    );
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            workspace_id: authoritativeWorkspaceId,
            source: "headless_service",
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: "healthy" } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "get_workspace_health",
      {},
      makeConfig({
        workspaceId: "00000000-0000-0000-0000-000000000000",
        fetchFn,
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "http://localhost:3000/api/airya/workspace-context",
      expect.objectContaining({
        method: "GET",
      }),
    );

    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const calledBody = JSON.parse((toolCall?.[1]?.body as string) ?? "{}");
    expect(calledBody.workspace_id).toBe(authoritativeWorkspaceId);
  });

  it("accepts the authoritative Factory Floor workspace when HQ returns the legacy nil workspace", async () => {
    setCachedCallerInstanceId(
      "inst-cached-factory-floor-001",
      getGenericCacheScope("00000000-0000-0000-0000-000000000000"),
    );
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            workspace_id: "00000000-0000-0000-0000-000000000000",
            source: "default",
            authoritative: true,
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: "healthy" } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "get_workspace_health",
      {},
      makeConfig({
        workspaceId: "00000000-0000-0000-0000-000000000000",
        fetchFn,
      }),
    );

    expect(result.isError).toBeUndefined();
    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const calledBody = JSON.parse((toolCall?.[1]?.body as string) ?? "{}");
    expect(calledBody.workspace_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("prefers an explicit input workspace_id over workspace-context discovery", async () => {
    setCachedCallerInstanceId(
      "inst-explicit-ws-001",
      getGenericCacheScope("00000000-0000-0000-0000-000000000000"),
    );
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-explicit-ws-001", agent_name: "codex" },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { accepted: true } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "continuity_write",
      {
        workspace_id: "00000000-0000-0000-0000-000000000000",
        semantic_key: "thread-state",
      },
      makeConfig({
        workspaceId: "99999999-9999-4999-8999-999999999999",
        fetchFn,
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const toolCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    const calledBody = JSON.parse((toolCall?.[1]?.body as string) ?? "{}");
    expect(calledBody.workspace_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(calledBody.input.workspace_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("falls back to the legacy default workspace when the workspace-context route is unavailable but tool execution is still live", async () => {
    resetCallerInstanceCache();
    const fetchFn = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 404,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>404</body></html>",
        };
      }

      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-fallback-001", agent_name: "codex" },
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { logged: true } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "card_activity_log",
      {
        work_item_id: "c38ab336-f5eb-41c6-b8d8-76a49a905422",
        actor: "codex",
        action: "repro_attempt",
      },
      makeConfig({
        workspaceId: "00000000-0000-0000-0000-000000000000",
        fetchFn,
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const bootstrapBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(bootstrapBody.tool).toBe("register_agent_session");
    expect(bootstrapBody.workspace_id).toBe("00000000-0000-0000-0000-000000000000");

    const toolBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[2][1].body);
    expect(toolBody.tool).toBe("card_activity_log");
    expect(toolBody.workspace_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("fails closed when workspace-context returns an HTML 500 instead of silently falling back", async () => {
    resetCallerInstanceCache();
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      if (url === "http://localhost:3000/api/airya/workspace-context") {
        return {
          ok: false,
          status: 500,
          headers: { get: () => "text/html; charset=utf-8" },
          text: async () => "<!DOCTYPE html><html><body>500</body></html>",
        };
      }

      throw new Error("tool execution should not be attempted after workspace-context 500");
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "card_activity_log",
      {
        work_item_id: "c38ab336-f5eb-41c6-b8d8-76a49a905422",
        actor: "codex",
        action: "repro_attempt",
      },
      makeConfig({
        workspaceId: "00000000-0000-0000-0000-000000000000",
        fetchFn,
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: "WORKSPACE_RESOLUTION_FAILED",
      error: "Workspace context request returned a non-JSON response with status 500.",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("read-only proxy helper", () => {
  it("uses public GET discovery for hq_health without bootstrap", async () => {
    resetCallerInstanceCache();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ count: 35 }),
    }) as unknown as typeof fetch;

    const result = await proxyReadOnlyToolCall("hq_health", {}, makeConfig({ fetchFn }), {
      callerTag: "vairys-openclaw",
    });

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://localhost:3000/api/airya/tool",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer test-secret",
          "x-openclaw-caller": "vairys-openclaw",
        }),
      }),
    );
    expect(getCachedCallerInstanceId()).toBeUndefined();
  });

  it("forwards explicit caller identity for optional read-only proxy tools without bootstrap", async () => {
    resetCallerInstanceCache();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { items: [] } }),
    }) as unknown as typeof fetch;

    const result = await proxyReadOnlyToolCall(
      "list_work_items",
      { status: "todo" },
      makeConfig({ fetchFn }),
      { callerTag: "vairys-openclaw", callerInstanceId: "inst-openclaw-1" },
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-secret",
      "x-agent-instance-id": "inst-openclaw-1",
      "x-openclaw-caller": "vairys-openclaw",
    });
    expect(JSON.parse(init.body)).toMatchObject({
      tool: "list_work_items",
      input: { status: "todo" },
      workspace_id: CONFIGURED_WORKSPACE_ID,
    });
    expect(getCachedCallerInstanceId()).toBeUndefined();
  });

  it("refuses optional proxy-backed reads without callerInstanceId instead of bootstrapping", async () => {
    resetCallerInstanceCache();
    const fetchFn = vi.fn();

    const result = await proxyReadOnlyToolCall(
      "list_sessions",
      {},
      makeConfig({ fetchFn: fetchFn as unknown as typeof fetch }),
      { callerTag: "vairys-openclaw" },
    );

    const body = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(body.code).toBe("AUTH_FAILED");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(getCachedCallerInstanceId()).toBeUndefined();
  });
});

// ── Identity Bootstrap ───────────────────────────────────────────────

describe("identity bootstrap", () => {
  it("lazy-bootstraps caller instance via register_agent_session when cache is empty", async () => {
    resetCallerInstanceCache();
    process.env.AIRYA_TMUX_SESSION = "codex-worker";
    process.env.AIRYA_RUNTIME = "codex";

    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-bootstrap-123", agent_name: "codex" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: "healthy" } }),
      };
    }) as unknown as typeof fetch;

    const config = makeConfig({ fetchFn });
    const result = await proxyToolCall("get_workspace_health", {}, config);

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const bootstrapBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(bootstrapBody.tool).toBe("register_agent_session");
    expect(bootstrapBody.input.tmux_session).toBe("codex-worker");
    expect(bootstrapBody.input.runtime).toBe("codex");

    const mainHeaders = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].headers;
    expect(mainHeaders["x-agent-instance-id"]).toBe("inst-bootstrap-123");
    expect(getCachedCallerInstanceId(getGenericCacheScope())).toBe("inst-bootstrap-123");
  });

  it("returns AUTH_FAILED with upstream diagnostics when bootstrap cannot register caller session", async () => {
    resetCallerInstanceCache();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error:
          "Mother slot held by active agent 'airya' (last heartbeat 2026-03-16T00:00:00.000Z). Deregister it first.",
        code: "HANDLER_ERROR",
      }),
    }) as unknown as typeof fetch;

    try {
      const result = await proxyToolCall("get_workspace_health", {}, makeConfig({ fetchFn }));
      const text = JSON.parse(result.content[0].text);

      expect(result.isError).toBe(true);
      expect(text.code).toBe("AUTH_FAILED");
      expect(text.error).toContain("Failed to bootstrap caller session");
      expect(text.error).toContain("Bootstrap failed: Mother slot held by active agent");
      expect(text.error).toContain(`workspace ${CONFIGURED_WORKSPACE_ID}`);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Bootstrap failed with upstream response"),
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("stores cached instance_id from explicit register_agent_session call when it matches this process identity", async () => {
    resetCallerInstanceCache();
    process.env.AIRYA_TMUX_SESSION = "codex-self";
    process.env.AIRYA_RUNTIME = "codex";
    const fetchFn = mockFetchOk({ instance_id: "inst-register-456", agent_name: "codex" });
    const config = makeConfig({ fetchFn });

    await proxyToolCall(
      "register_agent_session",
      { agent_name: "codex", tmux_session: "codex-self", runtime: "codex" },
      config,
    );

    const headers = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty("x-agent-instance-id");
    expect(getCachedCallerInstanceId(getGenericCacheScope())).toBe("inst-register-456");
  });

  it("forwards callerTag during bootstrap registration for proxied parity calls", async () => {
    resetCallerInstanceCache();
    process.env.AIRYA_TMUX_SESSION = "codex-openclaw";
    process.env.AIRYA_RUNTIME = "codex";
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-123", agent_name: "codex" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { accepted: true } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "continuity_write",
      { semantic_key: "thread-state" },
      makeConfig({ fetchFn }),
      { callerTag: "vairys-openclaw" },
    );

    expect(result.isError).toBeUndefined();
    const bootstrapHeaders = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(bootstrapHeaders).toMatchObject({
      Authorization: "Bearer test-secret",
      "x-openclaw-caller": "vairys-openclaw",
    });
  });

  it("does not reuse a generic cached session for a caller-scoped OpenClaw bootstrap", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-openclaw";
    process.env.AIRYA_RUNTIME = "codex";
    setCachedCallerInstanceId("inst-generic-001", getGenericCacheScope());
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-123", agent_name: "codex" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { accepted: true } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "continuity_write",
      { semantic_key: "thread-state" },
      makeConfig({ fetchFn }),
      { callerTag: "vairys-openclaw" },
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body).tool).toBe(
      "register_agent_session",
    );
    expect(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].headers["x-agent-instance-id"],
    ).toBe("inst-openclaw-123");
    expect(getCachedCallerInstanceId(getGenericCacheScope())).toBe("inst-generic-001");
  });

  it("does not reuse a caller-scoped cache entry from another workspace", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-openclaw";
    process.env.AIRYA_RUNTIME = "codex";
    setCachedCallerInstanceId("inst-foreign-workspace-001", {
      workspaceId: "77777777-7777-4777-8777-777777777777",
      callerTag: "vairys-openclaw",
      identityInput: {
        agent_name: "codex",
        tmux_session: "codex-openclaw",
        runtime: "codex",
      },
    });
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-openclaw-456", agent_name: "codex" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { accepted: true } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "continuity_write",
      { semantic_key: "thread-state" },
      makeConfig({ fetchFn }),
      { callerTag: "vairys-openclaw" },
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body).tool).toBe(
      "register_agent_session",
    );
    expect(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].headers["x-agent-instance-id"],
    ).toBe("inst-openclaw-456");
  });

  it("does not reuse a generic cache entry from another workspace", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-generic";
    process.env.AIRYA_RUNTIME = "codex";
    resetCallerInstanceCache();
    setCachedCallerInstanceId(
      "inst-foreign-generic-001",
      getGenericCacheScope("77777777-7777-4777-8777-777777777777"),
    );
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-generic-fresh-001", agent_name: "codex" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: "healthy" } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall("get_workspace_health", {}, makeConfig({ fetchFn }));

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body).tool).toBe(
      "register_agent_session",
    );
    expect(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].headers["x-agent-instance-id"],
    ).toBe("inst-generic-fresh-001");
  });

  it("does not reuse a generic cache entry across different HQ base URLs", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-generic";
    process.env.AIRYA_RUNTIME = "codex";
    resetCallerInstanceCache();
    setCachedCallerInstanceId(
      "inst-hq-a-001",
      getGenericCacheScope(CONFIGURED_WORKSPACE_ID, {
        hqBaseUrl: "http://hq-a.local:3000",
      }),
    );
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-hq-b-001", agent_name: "codex" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: "healthy" } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "get_workspace_health",
      {},
      makeConfig({
        hqBaseUrl: "http://hq-b.local:3000",
        fetchFn,
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body).tool).toBe(
      "register_agent_session",
    );
    expect(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].headers["x-agent-instance-id"],
    ).toBe("inst-hq-b-001");
  });

  it("does not reuse a generic cache entry across different auth contexts", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-generic";
    process.env.AIRYA_RUNTIME = "codex";
    resetCallerInstanceCache();
    setCachedCallerInstanceId(
      "inst-auth-a-001",
      getGenericCacheScope(CONFIGURED_WORKSPACE_ID, {
        apiSecret: "secret-a",
      }),
    );
    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-auth-b-001", agent_name: "codex" },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: "healthy" } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "get_workspace_health",
      {},
      makeConfig({
        apiSecret: "secret-b",
        fetchFn,
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body).tool).toBe(
      "register_agent_session",
    );
    expect(
      (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].headers["x-agent-instance-id"],
    ).toBe("inst-auth-b-001");
  });

  it("does not clobber cached caller identity when registering another agent", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-coordinator";
    process.env.AIRYA_RUNTIME = "codex";
    setCachedCallerInstanceId("inst-coordinator-123", getGenericCacheScope());
    const fetchFn = mockFetchOk({ instance_id: "inst-worker-456", agent_name: "codex-worker" });
    const config = makeConfig({ fetchFn });

    await proxyToolCall(
      "register_agent_session",
      { agent_name: "codex-worker", tmux_session: "codex-worker-1", runtime: "codex" },
      config,
    );

    expect(getCachedCallerInstanceId(getGenericCacheScope())).toBe("inst-coordinator-123");
  });

  it("clears cached instance_id when deregistering the same session", async () => {
    setCachedCallerInstanceId("inst-cached-001", getGenericCacheScope());
    const fetchFn = mockFetchOk({ ok: true });

    await proxyToolCall(
      "deregister_agent_session",
      { instance_id: "inst-cached-001" },
      makeConfig({ fetchFn }),
    );

    expect(getCachedCallerInstanceId(getGenericCacheScope())).toBeUndefined();
  });

  it("clears stale cached instance ids and re-bootstraps read-only calls after unknown caller AUTH_FAILED", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-worker";
    process.env.AIRYA_RUNTIME = "codex";
    setCachedCallerInstanceId("inst-stale-001", getGenericCacheScope());

    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-fresh-123", agent_name: "codex" },
          }),
        };
      }

      if (headers["x-agent-instance-id"] === "inst-stale-001") {
        return {
          ok: false,
          status: 401,
          json: async () => ({
            ok: false,
            error: "Unknown caller session instance",
            code: "AUTH_FAILED",
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { status: "healthy" } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall("get_workspace_health", {}, makeConfig({ fetchFn }));

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const bootstrapBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(bootstrapBody.tool).toBe("register_agent_session");

    const healedHeaders = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[2][1].headers;
    expect(healedHeaders["x-agent-instance-id"]).toBe("inst-fresh-123");
    expect(getCachedCallerInstanceId(getGenericCacheScope())).toBe("inst-fresh-123");
  });

  it("clears stale cached instance ids and re-bootstraps mutating calls after unknown caller AUTH_FAILED", async () => {
    process.env.AIRYA_TMUX_SESSION = "codex-worker";
    process.env.AIRYA_RUNTIME = "codex";
    setCachedCallerInstanceId("inst-stale-001", getGenericCacheScope());

    const fetchFn = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as { tool?: string };
      const headers = (init?.headers ?? {}) as Record<string, string>;

      if (body.tool === "register_agent_session") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { instance_id: "inst-fresh-789", agent_name: "codex" },
          }),
        };
      }

      if (headers["x-agent-instance-id"] === "inst-stale-001") {
        return {
          ok: false,
          status: 401,
          json: async () => ({
            ok: false,
            error: "Unknown caller session instance",
            code: "AUTH_FAILED",
          }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { workflow_id: "wf-draft-1" } }),
      };
    }) as unknown as typeof fetch;

    const result = await proxyToolCall(
      "create_workflow_draft",
      {
        name: "test-flow",
        description: "test",
        steps: [],
      },
      makeConfig({ fetchFn }),
    );

    expect(result.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(3);

    const bootstrapBody = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(bootstrapBody.tool).toBe("register_agent_session");

    const healedHeaders = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[2][1].headers;
    expect(healedHeaders["x-agent-instance-id"]).toBe("inst-fresh-789");
    expect(getCachedCallerInstanceId(getGenericCacheScope())).toBe("inst-fresh-789");
  });
});

// ── Retry Classification ─────────────────────────────────────────────

describe("retry classification", () => {
  it("retries read-only tools on 5xx (maxAttempts=2)", async () => {
    const fetchFn = mockFetch5xx();
    const config = makeConfig({ fetchFn });

    await proxyToolCall("get_workspace_health", {}, config);

    // Read-only tool should be called twice (1 initial + 1 retry)
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry mutating tools on 5xx (maxAttempts=1)", async () => {
    const fetchFn = mockFetch5xx();
    const config = makeConfig({ fetchFn });

    await proxyToolCall("create_workflow_draft", {}, config);

    // Mutating tool should be called once (no retry)
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry route_to_child on 5xx because routing mutates control state", async () => {
    const fetchFn = mockFetch5xx();
    const config = makeConfig({ fetchFn });

    await proxyToolCall("route_to_child", { task: "review this lane" }, config);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry check_messages on 5xx because inbox reads mutate read state", async () => {
    const fetchFn = mockFetch5xx();
    const config = makeConfig({ fetchFn });

    await proxyToolCall("check_messages", {}, config);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 4xx even for read-only tools", async () => {
    const fetchFn = mockFetch4xx(400, "Bad request", "VALIDATION_ERROR");
    const config = makeConfig({ fetchFn });

    await proxyToolCall("get_workspace_health", {}, config);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns isError:true with error details on 4xx", async () => {
    const fetchFn = mockFetch4xx(400, "Missing field: tool", "VALIDATION_ERROR");
    const config = makeConfig({ fetchFn });

    const result = await proxyToolCall("get_workspace_health", {}, config);

    expect(result.isError).toBe(true);
    const text = JSON.parse(result.content[0].text);
    expect(text.error).toBe("Missing field: tool");
    expect(text.code).toBe("VALIDATION_ERROR");
  });

  it("classifies agents_status as read-only and agents_spawn as mutating", () => {
    expect(READ_ONLY_TOOLS.has("agents_status")).toBe(true);
    expect(READ_ONLY_TOOLS.has("agents_spawn")).toBe(false);
    expect(READ_ONLY_TOOLS.has("route_to_child")).toBe(false);
    expect(READ_ONLY_TOOLS.has("check_messages")).toBe(false);
  });

  it("classifies parity observability and continuity reads as read-only", () => {
    expect(READ_ONLY_TOOLS.has("continuity_receipt_read")).toBe(true);
    expect(READ_ONLY_TOOLS.has("continuity_linkage_read")).toBe(true);
    expect(READ_ONLY_TOOLS.has("workstream_check_in")).toBe(true);
    expect(READ_ONLY_TOOLS.has("linked_session_observe")).toBe(true);
  });

  it("retries parity continuity reads on 5xx through the proxy transport", async () => {
    const fetchFn = mockFetch5xx();
    const config = makeConfig({ fetchFn });

    await proxyToolCall("continuity_receipt_read", { receipt_id: "receipt-123" }, config);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("LONG_RUNNING_TOOLS has exactly 6 entries", () => {
    expect(LONG_RUNNING_TOOLS.size).toBe(6);
  });
});

// ── Timeout Handling ─────────────────────────────────────────────────

describe("timeout handling", () => {
  it("uses standard timeout for normal tools", async () => {
    const fetchFn = mockFetchOk({});
    const config = makeConfig({ fetchFn });

    await proxyToolCall("get_workspace_health", {}, config);

    const signal = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].signal;
    expect(signal).toBeDefined();
    // AbortSignal.timeout creates a signal — we verify it was passed
  });

  it("uses LONG_TOOL_TIMEOUT_MS for long-running tools", async () => {
    // We verify by checking that the correct tools are classified as long-running
    for (const tool of [
      "exec",
      "spawn_session",
      "spawn_child",
      "tmux_wait",
      "web_fetch",
      "web_search",
    ]) {
      expect(LONG_RUNNING_TOOLS.has(tool), `${tool} should be long-running`).toBe(true);
    }
  });

  it("returns timeout error message on TimeoutError", async () => {
    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    const fetchFn = vi.fn().mockRejectedValue(timeoutErr) as unknown as typeof fetch;
    const config = makeConfig({ fetchFn });

    const result = await proxyToolCall("get_workspace_health", {}, config);

    expect(result.isError).toBe(true);
    const text = JSON.parse(result.content[0].text);
    expect(text.code).toBe("TIMEOUT");
    expect(text.error).toContain("timed out");
    expect(text.error).toContain(`${TOOL_TIMEOUT_MS / 1000}s`);
  });

  it("does not retry after timeout", async () => {
    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    const fetchFn = vi.fn().mockRejectedValue(timeoutErr) as unknown as typeof fetch;
    const config = makeConfig({ fetchFn });

    // Even for a read-only tool that normally retries
    await proxyToolCall("get_workspace_health", {}, config);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ── HQ-Down Behavior ─────────────────────────────────────────────────

describe("HQ-down behavior", () => {
  it("returns helpful ECONNREFUSED message with HQ URL", async () => {
    const connErr = new Error("connect ECONNREFUSED 127.0.0.1:3000");
    const fetchFn = vi.fn().mockRejectedValue(connErr) as unknown as typeof fetch;
    const config = makeConfig({ fetchFn });

    const result = await proxyToolCall("get_workspace_health", {}, config);

    expect(result.isError).toBe(true);
    const text = JSON.parse(result.content[0].text);
    expect(text.code).toBe("HQ_UNREACHABLE");
    expect(text.error).toContain("AiRYA HQ not running");
    expect(text.error).toContain("http://localhost:3000");
    expect(text.error).toContain("pnpm dev");
  });

  it("returns generic proxy error for other fetch errors", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error("DNS resolution failed")) as unknown as typeof fetch;
    const config = makeConfig({ fetchFn });

    const result = await proxyToolCall("get_workspace_health", {}, config);

    expect(result.isError).toBe(true);
    const text = JSON.parse(result.content[0].text);
    expect(text.code).toBe("PROXY_ERROR");
    expect(text.error).toContain("Proxy error");
    expect(text.error).toContain("DNS resolution failed");
  });

  it("retries read-only tools on connection error", async () => {
    const connErr = new Error("connect ECONNREFUSED 127.0.0.1:3000");
    const fetchFn = vi.fn().mockRejectedValue(connErr) as unknown as typeof fetch;
    const config = makeConfig({ fetchFn });

    await proxyToolCall("get_workspace_health", {}, config);

    // Read-only: 2 attempts
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ── Success Path ─────────────────────────────────────────────────────

describe("success path", () => {
  it("returns formatted result on ok:true response", async () => {
    const fetchFn = mockFetchOk({ workflows: [{ name: "test" }], count: 1 });
    const config = makeConfig({ fetchFn });

    const result = await proxyToolCall("search_workflow_catalog", { query: "test" }, config);

    expect(result.isError).toBeUndefined();
    const text = JSON.parse(result.content[0].text);
    expect(text.workflows).toHaveLength(1);
    expect(text.count).toBe(1);
  });
});
