import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  buildConsentDeniedResult,
  detectMcpConsentEnvelope,
  scrubModelSuppliedConfirmationToken,
} from "./pi-bundle-mcp-consent.js";
import {
  callMcpToolWithConsent,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-materialize.js";
import type { McpCatalogTool, SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

function consentEnvelopeResult(
  actionId = "act-123",
  summary = "create note 'milk'",
): CallToolResult {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          requires_confirmation: true,
          action_id: actionId,
          summary,
          expires_in_seconds: 60,
        }),
      },
    ],
  };
}

function plainOkResult(text = "done"): CallToolResult {
  return {
    isError: false,
    content: [{ type: "text", text }],
  };
}

describe("detectMcpConsentEnvelope", () => {
  it("recognises the consent envelope from content[0].text", () => {
    const env = detectMcpConsentEnvelope(consentEnvelopeResult("a-1", "do thing"));
    expect(env).toEqual({ actionId: "a-1", summary: "do thing", expiresInSeconds: 60 });
  });

  it("recognises the envelope from structuredContent", () => {
    const env = detectMcpConsentEnvelope({
      isError: false,
      content: [],
      structuredContent: {
        ok: false,
        requires_confirmation: true,
        action_id: "from-structured",
        summary: "via structured",
      },
    });
    expect(env).toEqual({ actionId: "from-structured", summary: "via structured" });
  });

  it("returns null on a plain tool result", () => {
    expect(detectMcpConsentEnvelope(plainOkResult())).toBeNull();
  });

  it("returns null when requires_confirmation is missing", () => {
    expect(
      detectMcpConsentEnvelope({
        isError: false,
        content: [{ type: "text", text: JSON.stringify({ ok: true, action_id: "x" }) }],
      }),
    ).toBeNull();
  });

  it("returns null when action_id is empty", () => {
    expect(
      detectMcpConsentEnvelope({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({ requires_confirmation: true, action_id: "", summary: "x" }),
          },
        ],
      }),
    ).toBeNull();
  });

  it("supplies a default summary when the envelope omits one", () => {
    const env = detectMcpConsentEnvelope({
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({ requires_confirmation: true, action_id: "a", summary: "" }),
        },
      ],
    });
    expect(env?.summary).toBe("An MCP tool requires user approval.");
  });

  it("ignores non-JSON text blocks", () => {
    expect(
      detectMcpConsentEnvelope({
        isError: false,
        content: [
          { type: "text", text: "not json" },
          { type: "text", text: "still not json" },
        ],
      }),
    ).toBeNull();
  });
});

describe("scrubModelSuppliedConfirmationToken", () => {
  it("strips confirmation_token from a plain object", () => {
    const r = scrubModelSuppliedConfirmationToken({ a: 1, confirmation_token: "smuggled" });
    expect(r.stripped).toBe(true);
    expect(r.cleaned).toEqual({ a: 1 });
  });

  it("leaves untouched input alone", () => {
    const r = scrubModelSuppliedConfirmationToken({ a: 1 });
    expect(r.stripped).toBe(false);
    expect(r.cleaned).toEqual({ a: 1 });
  });

  it("passes through non-objects unchanged", () => {
    const r = scrubModelSuppliedConfirmationToken("hello");
    expect(r.stripped).toBe(false);
    expect(r.cleaned).toBe("hello");
  });
});

function makeMockRuntime(opts: {
  results: CallToolResult[];
  recordedCalls: Array<{ serverName: string; toolName: string; input: unknown }>;
  catalogTool?: Partial<McpCatalogTool>;
}): SessionMcpRuntime {
  let i = 0;
  const tool: McpCatalogTool = {
    serverName: "vault",
    safeServerName: "vault",
    toolName: "create_login",
    description: "create a login",
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: "create a login",
    ...opts.catalogTool,
  };
  return {
    sessionId: "test-session",
    workspaceDir: "/tmp",
    configFingerprint: "fp",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [tool.serverName]: {
          serverName: tool.serverName,
          launchSummary: tool.serverName,
          toolCount: 1,
        },
      },
      tools: [tool],
    }),
    callTool: async (serverName, toolName, input) => {
      opts.recordedCalls.push({ serverName, toolName, input });
      const result = opts.results[i] ?? opts.results[opts.results.length - 1];
      i += 1;
      return result;
    },
    dispose: async () => {},
  };
}

describe("callMcpToolWithConsent", () => {
  it("passes plain results straight through (no envelope, no approval call)", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    let approvalCalls = 0;
    const runtime = makeMockRuntime({ results: [plainOkResult("hi")], recordedCalls: calls });
    const result = await callMcpToolWithConsent({
      runtime,
      serverName: "vault",
      toolName: "search",
      agentToolName: "vault__search",
      input: { query: "router" },
      requestApproval: async () => {
        approvalCalls += 1;
        return "allow-once";
      },
    });
    expect(calls).toHaveLength(1);
    expect(approvalCalls).toBe(0);
    expect(result.isError).toBe(false);
    expect((result.content?.[0] as { text?: string }).text).toBe("hi");
  });

  it("on consent envelope + allow-once, re-calls with confirmation_token", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    const runtime = makeMockRuntime({
      results: [consentEnvelopeResult("act-allow", "create note"), plainOkResult("created")],
      recordedCalls: calls,
    });
    const result = await callMcpToolWithConsent({
      runtime,
      serverName: "vault",
      toolName: "create_login",
      agentToolName: "vault__create_login",
      input: { name: "router" },
      requestApproval: async ({ envelope, ctx }) => {
        expect(envelope.actionId).toBe("act-allow");
        expect(ctx.serverName).toBe("vault");
        expect(ctx.agentToolName).toBe("vault__create_login");
        return "allow-once";
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].input).toEqual({ name: "router" });
    expect(calls[1].input).toEqual({ name: "router", confirmation_token: "act-allow" });
    expect((result.content?.[0] as { text?: string }).text).toBe("created");
  });

  it("on consent envelope + deny, returns synthetic denied result and does NOT re-call", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    const runtime = makeMockRuntime({
      results: [consentEnvelopeResult("act-deny", "send email")],
      recordedCalls: calls,
    });
    const result = await callMcpToolWithConsent({
      runtime,
      serverName: "email",
      toolName: "send_direct",
      agentToolName: "email__send_direct",
      input: { to: "boss@example.com" },
      requestApproval: async () => "deny",
    });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
    const text = (result.content?.[0] as { text?: string }).text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.approved).toBe(false);
    expect(parsed.reason).toMatch(/declined/i);
    // The original action_id MUST NOT leak to the model.
    expect(text).not.toContain("act-deny");
  });

  it("on approval system error, returns denied result and does NOT re-call", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    const runtime = makeMockRuntime({
      results: [consentEnvelopeResult("act-err", "summary")],
      recordedCalls: calls,
    });
    const result = await callMcpToolWithConsent({
      runtime,
      serverName: "vault",
      toolName: "reveal",
      agentToolName: "vault__reveal",
      input: { id: "abc" },
      requestApproval: async () => {
        throw new Error("gateway down");
      },
    });
    expect(calls).toHaveLength(1);
    expect(result.isError).toBe(true);
  });

  it("strips a model-supplied confirmation_token before the FIRST call", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    const runtime = makeMockRuntime({
      results: [plainOkResult("ok")],
      recordedCalls: calls,
    });
    await callMcpToolWithConsent({
      runtime,
      serverName: "vault",
      toolName: "create_login",
      agentToolName: "vault__create_login",
      input: { name: "router", confirmation_token: "model-fabricated" },
      requestApproval: async () => "allow-once",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ name: "router" });
    expect((calls[0].input as Record<string, unknown>).confirmation_token).toBeUndefined();
  });

  it("does not loop when the upstream still returns a consent envelope after approval", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    const runtime = makeMockRuntime({
      results: [consentEnvelopeResult("act-1"), consentEnvelopeResult("act-2")],
      recordedCalls: calls,
    });
    const result = await callMcpToolWithConsent({
      runtime,
      serverName: "buggy",
      toolName: "tool",
      agentToolName: "buggy__tool",
      input: {},
      requestApproval: async () => "allow-once",
    });
    expect(calls).toHaveLength(2);
    expect(result.isError).toBe(true);
  });

  it("when consentEnabled=false, never calls the approval requester even if envelope is present", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    let approvalCalls = 0;
    const runtime = makeMockRuntime({
      results: [consentEnvelopeResult("act-x")],
      recordedCalls: calls,
    });
    const result = await callMcpToolWithConsent({
      runtime,
      serverName: "x",
      toolName: "y",
      agentToolName: "x__y",
      input: {},
      consentEnabled: false,
      requestApproval: async () => {
        approvalCalls += 1;
        return "deny";
      },
    });
    expect(calls).toHaveLength(1);
    expect(approvalCalls).toBe(0);
    expect(detectMcpConsentEnvelope(result)).not.toBeNull();
  });
});

describe("buildConsentDeniedResult", () => {
  it("does not include action_id in the user-visible content", () => {
    const r = buildConsentDeniedResult({
      envelope: { actionId: "secret-token-id", summary: "stuff" },
      decision: "deny",
      serverName: "s",
      toolName: "t",
    });
    const text = (r.content?.[0] as { text?: string }).text ?? "";
    expect(text).not.toContain("secret-token-id");
  });
});

describe("materializeBundleMcpToolsForRun (consent integration)", () => {
  it("threads requestApproval into the materialized tool's execute()", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    const runtime = makeMockRuntime({
      results: [consentEnvelopeResult("act-mat", "do it"), plainOkResult("done")],
      recordedCalls: calls,
    });
    let observedAgentToolName = "";
    const materialized = await materializeBundleMcpToolsForRun({
      runtime,
      requestApproval: async ({ ctx }) => {
        observedAgentToolName = ctx.agentToolName;
        return "allow-once";
      },
    });
    expect(materialized.tools).toHaveLength(1);
    const tool = materialized.tools[0];
    const result = await tool.execute("call-1", { name: "x" }, undefined, undefined);
    expect(observedAgentToolName).toBe("vault__create_login");
    expect(calls).toHaveLength(2);
    expect(calls[1].input).toEqual({ name: "x", confirmation_token: "act-mat" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "done" });
  });

  it("respects consentEnabled=false and surfaces the envelope to the agent", async () => {
    const calls: Array<{ serverName: string; toolName: string; input: unknown }> = [];
    const runtime = makeMockRuntime({
      results: [consentEnvelopeResult("act-z")],
      recordedCalls: calls,
    });
    const materialized = await materializeBundleMcpToolsForRun({
      runtime,
      consentEnabled: false,
      requestApproval: async () => "deny",
    });
    const result = await materialized.tools[0].execute("call-1", {}, undefined, undefined);
    expect(calls).toHaveLength(1);
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).toContain("requires_confirmation");
  });
});
