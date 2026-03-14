import { describe, expect, it, vi, beforeEach } from "vitest";
import type { VerdictClient } from "./client.js";
import type { VerdictPluginConfig } from "./config.js";
import { createBeforeToolCallHook } from "./hook.js";
import type { PolicyDecision } from "./types.js";

describe("createBeforeToolCallHook", () => {
  const defaultConfig: VerdictPluginConfig = {
    gatewayUrl: "http://localhost:8080",
    failOpen: true,
  };

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const event = {
    toolName: "issue_refund",
    params: { amount: 350, customer_id: "C-123" },
    toolCallId: "tc-1",
  };

  const ctx = {
    agentId: "agent-1",
    sessionId: "sess-1",
    toolName: "issue_refund",
  };

  let mockClient: { evaluate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = { evaluate: vi.fn() };
  });

  function makeHook(config?: Partial<VerdictPluginConfig>) {
    return createBeforeToolCallHook(
      mockClient as unknown as VerdictClient,
      { ...defaultConfig, ...config },
      logger,
    );
  }

  const allowDecision: PolicyDecision = {
    decision: "ALLOW",
    eval_duration_ms: 2.0,
    audit: {
      eval_id: "e1",
      bundle_digest: "sha256:abc",
      input_hash: "sha256:def",
      timestamp: "2026-03-12T00:00:00Z",
      shadow_mode: false,
    },
  };

  it("returns void on ALLOW", async () => {
    mockClient.evaluate.mockResolvedValue(allowDecision);
    const hook = makeHook();
    const result = await hook(event, ctx);
    expect(result).toBeUndefined();
  });

  it("blocks on DENY with formatted reason", async () => {
    const denyDecision: PolicyDecision = {
      ...allowDecision,
      decision: "DENY",
      violations: [
        {
          policy_id: "refund-limit",
          severity: "high",
          message: "Refund exceeds $200 threshold",
          sop_ref: "SOP-v1 3.1",
        },
      ],
    };
    mockClient.evaluate.mockResolvedValue(denyDecision);

    const hook = makeHook();
    const result = await hook(event, ctx);

    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("DENY"),
    });
    expect(result?.blockReason).toContain("refund-limit");
    expect(result?.blockReason).toContain("SOP-v1 3.1");
  });

  it("auto-repairs cap_value and returns modified params", async () => {
    const requireChanges: PolicyDecision = {
      ...allowDecision,
      decision: "REQUIRE_CHANGES",
      violations: [{ policy_id: "cap", severity: "medium", message: "Amount too high" }],
      suggested_repairs: [{ op: "cap_value", max_value: 200, fields: ["args.amount"] }],
    };
    mockClient.evaluate.mockResolvedValue(requireChanges);

    const hook = makeHook();
    const result = await hook(event, ctx);

    expect(result).toEqual({ params: { amount: 200, customer_id: "C-123" } });
  });

  it("auto-repairs redact and returns modified params", async () => {
    const requireChanges: PolicyDecision = {
      ...allowDecision,
      decision: "REQUIRE_CHANGES",
      suggested_repairs: [{ op: "redact", fields: ["args.customer_id"] }],
    };
    mockClient.evaluate.mockResolvedValue(requireChanges);

    const hook = makeHook();
    const result = await hook({ ...event, params: { amount: 50, customer_id: "C-123" } }, ctx);

    expect(result).toEqual({ params: { amount: 50, customer_id: "[REDACTED]" } });
  });

  it("blocks when repairs require human intervention", async () => {
    const requireChanges: PolicyDecision = {
      ...allowDecision,
      decision: "REQUIRE_CHANGES",
      violations: [{ policy_id: "approval", severity: "high", message: "Needs manager" }],
      suggested_repairs: [
        { op: "add_approval", role: "manager", reason: "Amount exceeds threshold" },
      ],
    };
    mockClient.evaluate.mockResolvedValue(requireChanges);

    const hook = makeHook();
    const result = await hook(event, ctx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("add_approval");
  });

  it("skips tools in skipTools config", async () => {
    const hook = makeHook({ skipTools: ["issue_refund"] });
    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
    expect(mockClient.evaluate).not.toHaveBeenCalled();
  });

  it("fails open when gateway is unreachable (failOpen=true)", async () => {
    mockClient.evaluate.mockRejectedValue(new Error("ECONNREFUSED"));

    const hook = makeHook({ failOpen: true });
    const result = await hook(event, ctx);

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("blocks when gateway is unreachable (failOpen=false)", async () => {
    mockClient.evaluate.mockRejectedValue(new Error("ECONNREFUSED"));

    const hook = makeHook({ failOpen: false });
    const result = await hook(event, ctx);

    expect(result?.block).toBe(true);
    expect(result?.blockReason).toContain("ECONNREFUSED");
  });

  it("passes config context fields to ActionRequest", async () => {
    mockClient.evaluate.mockResolvedValue(allowDecision);

    const hook = makeHook({
      principal: "admin@corp.com",
      agentRole: "L2_support",
      identityVerified: true,
      extra: { customer_tier: "premium", department: "finance" },
    });
    await hook(event, ctx);

    const callArg = mockClient.evaluate.mock.calls[0][0];
    expect(callArg.context.principal).toBe("admin@corp.com");
    expect(callArg.context.agent_role).toBe("L2_support");
    expect(callArg.context.identity_verified).toBe(true);
    expect(callArg.context.extra).toEqual({ customer_tier: "premium", department: "finance" });
  });
});
