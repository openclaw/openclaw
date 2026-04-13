import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import plugin from "./index.js";

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

type RegisteredHooks = Map<string, HookHandler>;

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function setupPlugin(config?: Record<string, unknown>): RegisteredHooks {
  const hooks = new Map<string, HookHandler>();
  const api = createTestPluginApi({
    id: "hol-guard",
    name: "HOL Guard",
    pluginConfig: config ?? {},
    on: (hookName, handler) => {
      hooks.set(hookName, handler as HookHandler);
    },
  });
  void plugin.register(api);
  return hooks;
}

describe("hol-guard plugin", () => {
  const originalGuardToken = process.env.OPENCLAW_GUARD_TOKEN;

  beforeEach(() => {
    process.env.OPENCLAW_GUARD_TOKEN = "guard-token";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalGuardToken === undefined) {
      delete process.env.OPENCLAW_GUARD_TOKEN;
    } else {
      process.env.OPENCLAW_GUARD_TOKEN = originalGuardToken;
    }
  });

  it("blocks malicious tool execution and emits receipt plus pain signal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          decision: "block",
          rationale: "Known malicious MCP launcher",
          scope: "workspace",
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ ok: true }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const hooks = setupPlugin({
      baseUrl: "https://guard.example/api/v1/consumer",
      failOpen: false,
    });
    const beforeToolCall = hooks.get("before_tool_call");

    const result = await beforeToolCall?.(
      {
        toolName: "mcp_bash_proxy",
        toolCallId: "tool-1",
        params: {
          guardArtifact: {
            artifactId: "mcp-server:openclaw:malicious-proxy",
            artifactName: "malicious proxy",
            artifactSlug: "malicious-proxy",
            artifactType: "mcp-server",
            publisher: "bad-actor",
            domain: "exfil.bad",
            launchSummary: "bash wrapper exfiltrates ~/.env over HTTPS",
          },
        },
      },
      {
        runId: "run-1",
        toolName: "mcp_bash_proxy",
        toolCallId: "tool-1",
      },
    );

    expect(result).toEqual({
      block: true,
      blockReason: "Known malicious MCP launcher",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://guard.example/api/v1/consumer/verdict/pre-execution",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://guard.example/api/v1/consumer/receipts/submit",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://guard.example/api/v1/consumer/signals/pain");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer guard-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("requires approval for review verdicts and records a receipt after allowed execution", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          decision: "review",
          rationale: "Artifact changed domains since last approval",
          scope: "workspace",
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const hooks = setupPlugin({
      baseUrl: "https://guard.example/api/v1/consumer",
      painSignalsEnabled: false,
    });
    const beforeToolCall = hooks.get("before_tool_call");
    const afterToolCall = hooks.get("after_tool_call");

    const reviewResult = (await beforeToolCall?.(
      {
        toolName: "mcp_changed_proxy",
        toolCallId: "tool-2",
        params: {
          artifactId: "mcp-server:openclaw:changed-proxy",
          artifactName: "changed proxy",
          artifactSlug: "changed-proxy",
          artifactType: "mcp-server",
          launchSummary: "changed domain from safe.example to risky.example",
        },
      },
      {
        runId: "run-2",
        toolName: "mcp_changed_proxy",
        toolCallId: "tool-2",
      },
    )) as {
      requireApproval?: {
        title: string;
        onResolution?: (decision: "allow-once" | "allow-always" | "deny") => Promise<void>;
      };
    };

    expect(reviewResult.requireApproval?.title).toContain("changed proxy");
    await reviewResult.requireApproval?.onResolution?.("allow-once");
    await afterToolCall?.(
      {
        toolName: "mcp_changed_proxy",
        toolCallId: "tool-2",
        params: {
          artifactId: "mcp-server:openclaw:changed-proxy",
          artifactName: "changed proxy",
          artifactSlug: "changed-proxy",
          artifactType: "mcp-server",
        },
        result: { ok: true },
      },
      {
        runId: "run-2",
        toolName: "mcp_changed_proxy",
        toolCallId: "tool-2",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://guard.example/api/v1/consumer/receipts/submit",
    );
  });

  it("records denial outcomes for review verdicts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          decision: "review",
          rationale: "Needs explicit review",
          scope: "workspace",
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ ok: true }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const hooks = setupPlugin({
      baseUrl: "https://guard.example/api/v1/consumer",
    });
    const beforeToolCall = hooks.get("before_tool_call");

    const reviewResult = (await beforeToolCall?.(
      {
        toolName: "mcp_reviewable",
        toolCallId: "tool-3",
        params: {
          artifactId: "mcp-server:openclaw:reviewable",
          artifactName: "reviewable",
          artifactSlug: "reviewable",
          artifactType: "mcp-server",
          launchSummary: "suspicious but not auto-blocked",
        },
      },
      {
        runId: "run-3",
        toolName: "mcp_reviewable",
        toolCallId: "tool-3",
      },
    )) as {
      requireApproval?: {
        onResolution?: (decision: "deny") => Promise<void>;
      };
    };

    await reviewResult.requireApproval?.onResolution?.("deny");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://guard.example/api/v1/consumer/receipts/submit",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://guard.example/api/v1/consumer/signals/pain");
  });

  it("fails closed when verdict lookup errors and failOpen is disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const hooks = setupPlugin({
      baseUrl: "https://guard.example/api/v1/consumer",
      failOpen: false,
    });
    const beforeToolCall = hooks.get("before_tool_call");

    const result = await beforeToolCall?.(
      {
        toolName: "mcp_unreachable",
        toolCallId: "tool-4",
        params: {
          artifactId: "mcp-server:openclaw:unreachable",
          artifactName: "unreachable",
          artifactSlug: "unreachable",
          artifactType: "mcp-server",
          launchSummary: "guard service unavailable",
        },
      },
      {
        runId: "run-4",
        toolName: "mcp_unreachable",
        toolCallId: "tool-4",
      },
    );

    expect(result).toEqual({
      block: true,
      blockReason: "HOL Guard policy lookup failed: network down",
    });
  });

  it("fails closed when the configured guard token is missing and failOpen is disabled", async () => {
    delete process.env.OPENCLAW_GUARD_TOKEN;

    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const hooks = setupPlugin({
      baseUrl: "https://guard.example/api/v1/consumer",
      failOpen: false,
    });
    const beforeToolCall = hooks.get("before_tool_call");

    const result = await beforeToolCall?.(
      {
        toolName: "mcp_missing_token",
        toolCallId: "tool-5",
        params: {
          artifactId: "mcp-server:openclaw:missing-token",
          artifactName: "missing token",
          artifactSlug: "missing-token",
          artifactType: "mcp-server",
          launchSummary: "guard token missing",
        },
      },
      {
        runId: "run-5",
        toolName: "mcp_missing_token",
        toolCallId: "tool-5",
      },
    );

    expect(result).toEqual({
      block: true,
      blockReason:
        "HOL Guard policy lookup failed: Missing HOL Guard token in OPENCLAW_GUARD_TOKEN",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a block verdict when receipt signaling fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createJsonResponse({
          decision: "block",
          rationale: "Known malicious MCP launcher",
          scope: "workspace",
        }),
      )
      .mockRejectedValueOnce(new Error("receipt endpoint unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    const hooks = setupPlugin({
      baseUrl: "https://guard.example/api/v1/consumer",
      failOpen: true,
    });
    const beforeToolCall = hooks.get("before_tool_call");

    const result = await beforeToolCall?.(
      {
        toolName: "mcp_bash_proxy",
        toolCallId: "tool-6",
        params: {
          artifactId: "mcp-server:openclaw:malicious-proxy",
          artifactName: "malicious proxy",
          artifactSlug: "malicious-proxy",
          artifactType: "mcp-server",
          launchSummary: "bash wrapper exfiltrates ~/.env over HTTPS",
        },
      },
      {
        runId: "run-6",
        toolName: "mcp_bash_proxy",
        toolCallId: "tool-6",
      },
    );

    expect(result).toEqual({
      block: true,
      blockReason: "Known malicious MCP launcher",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
