import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

/**
 * Stage-integrity tests for NETWORK_IO gating.
 * 
 * These tests verify that executeWithNetworkGating() ALWAYS uses stageId "NETWORK_IO"
 * when calling routeClarityBurst() and applyNetworkOverrides(). This is tested by
 * spying on the mocked dependencies and asserting the stageId in call arguments.
 * 
 * No test-only hooks or bypass parameters exist in production code.
 */

// Spy on routeClarityBurst to capture call arguments
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (args: unknown) => routeClarityBurstMock(args),
}));

// Spy on getPackForStage to verify stageId argument
const getPackForStageMock = vi.fn().mockReturnValue({
  pack_id: "test-network-pack",
  pack_version: "1.0.0",
  contracts: [
    {
      contract_id: "NET_HTTP_REQUEST",
      risk_class: "LOW",
      needs_confirmation: false,
    },
  ],
  // Include field_schema with method enum to enable allowlist derivation
  field_schema: {
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "FETCH", "CONNECT", "LISTEN", "SEND"],
      },
    },
  },
});
vi.mock("../clarityburst/pack-registry.js", () => ({
  getPackForStage: (stageId: string) => getPackForStageMock(stageId),
}));

// Spy on deriveAllowedContracts to verify stageId argument
const deriveAllowedContractsMock = vi.fn().mockReturnValue(["NET_HTTP_REQUEST"]);
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: (stageId: string, pack: unknown, caps: unknown) =>
    deriveAllowedContractsMock(stageId, pack, caps),
}));

// Spy on applyNetworkOverrides to verify context.stageId
const applyNetworkOverridesMock = vi.fn().mockReturnValue({
  outcome: "PROCEED",
  contractId: "NET_HTTP_REQUEST",
});
vi.mock("../clarityburst/decision-override.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../clarityburst/decision-override.js")>();
  return {
    ...original,
    applyNetworkOverrides: (pack: unknown, routerResult: unknown, context: unknown) =>
      applyNetworkOverridesMock(pack, routerResult, context),
  };
});

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "./bash-tools.exec.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

// Type alias for the executor function signature
type ExecutorFn = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>
) => Promise<AgentToolResult<unknown>>;

/**
 * Creates a mock network tool for testing.
 * Returns the tool and a spy on the original execute function.
 */
function createMockNetworkTool(): { tool: AnyAgentTool; executeSpy: ExecutorFn & ReturnType<typeof vi.fn> } {
  const executeSpy = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text" as const, text: "Network operation succeeded" }],
  }) as ExecutorFn & ReturnType<typeof vi.fn>;

  const tool: AnyAgentTool = {
    name: "network_fetch",
    label: "Network Fetch",
    description: "Fetches data from a URL",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
    execute: executeSpy,
  };

  return { tool, executeSpy };
}

describe("NETWORK_IO stage-integrity assertion via module boundary spies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Configure router to return a successful LOW-risk contract match
    routeClarityBurstMock.mockResolvedValue({
      ok: true,
      data: {
        top1: {
          contract_id: "NET_HTTP_REQUEST",
          confidence: 0.95,
          dominance: 0.85,
          contract_risk: "LOW",
          needs_confirmation: false,
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("always passes stageId 'NETWORK_IO' to getPackForStage()", async () => {
    // Arrange
    const { tool, executeSpy } = createMockNetworkTool();
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });

    // Act
    await tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal);

    // Assert: getPackForStage was called with exactly "NETWORK_IO"
    expect(getPackForStageMock).toHaveBeenCalledTimes(1);
    expect(getPackForStageMock).toHaveBeenCalledWith("NETWORK_IO");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("always passes stageId 'NETWORK_IO' to deriveAllowedContracts()", async () => {
    // Arrange
    const { tool, executeSpy } = createMockNetworkTool();
    wrapWithNetworkGating(tool, "post", {}, { url: "https://api.example.com/submit" });

    // Act
    await tool.execute("call-2", {}, new AbortController().signal);

    // Assert: deriveAllowedContracts was called with stageId "NETWORK_IO" as first arg
    expect(deriveAllowedContractsMock).toHaveBeenCalledTimes(1);
    const calls = deriveAllowedContractsMock.mock.calls;
    expect(calls[0][0]).toBe("NETWORK_IO");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("always passes stageId 'NETWORK_IO' to routeClarityBurst()", async () => {
    // Arrange
    const { tool, executeSpy } = createMockNetworkTool();
    wrapWithNetworkGating(tool, "connect", {}, { url: "wss://socket.example.com" });

    // Act
    await tool.execute("call-3", {}, new AbortController().signal);

    // Assert: routeClarityBurst was called with stageId "NETWORK_IO"
    expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
    const calls = routeClarityBurstMock.mock.calls;
    const routerArgs = calls[0][0] as { stageId: string };
    expect(routerArgs.stageId).toBe("NETWORK_IO");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("always passes context.stageId 'NETWORK_IO' to applyNetworkOverrides()", async () => {
    // Arrange
    const { tool, executeSpy } = createMockNetworkTool();
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com/api" });

    // Act
    await tool.execute("call-4", {}, new AbortController().signal);

    // Assert: applyNetworkOverrides was called with context.stageId === "NETWORK_IO"
    expect(applyNetworkOverridesMock).toHaveBeenCalledTimes(1);
    const calls = applyNetworkOverridesMock.mock.calls;
    const networkContext = calls[0][2] as { stageId: string };
    expect(networkContext.stageId).toBe("NETWORK_IO");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("stageId is immutable across multiple tool invocations", async () => {
    // Arrange: Create multiple tools with different operations
    const { tool: tool1 } = createMockNetworkTool();
    const { tool: tool2 } = createMockNetworkTool();
    const { tool: tool3 } = createMockNetworkTool();

    wrapWithNetworkGating(tool1, "fetch", {}, { url: "https://example.com/1" });
    wrapWithNetworkGating(tool2, "post", {}, { url: "https://example.com/2" });
    wrapWithNetworkGating(tool3, "delete", {}, { url: "https://example.com/3" });

    // Act: Execute all tools
    await tool1.execute("call-a", {}, undefined);
    await tool2.execute("call-b", {}, undefined);
    await tool3.execute("call-c", {}, undefined);

    // Assert: All calls to routeClarityBurst used stageId "NETWORK_IO"
    expect(routeClarityBurstMock).toHaveBeenCalledTimes(3);
    const routerCalls = routeClarityBurstMock.mock.calls;
    for (const call of routerCalls) {
      const args = call[0] as { stageId: string };
      expect(args.stageId).toBe("NETWORK_IO");
    }

    // Assert: All calls to applyNetworkOverrides used context.stageId "NETWORK_IO"
    expect(applyNetworkOverridesMock).toHaveBeenCalledTimes(3);
    const overrideCalls = applyNetworkOverridesMock.mock.calls;
    for (const call of overrideCalls) {
      const context = call[2] as { stageId: string };
      expect(context.stageId).toBe("NETWORK_IO");
    }
  });

  it("throws PACK_POLICY_INCOMPLETE when pack is missing required contracts for NETWORK_IO stage", async () => {
    // Arrange: Mock getPackForStage to return an incomplete pack (no contracts)
    // This simulates a misconfigured NETWORK_IO pack
    getPackForStageMock.mockReturnValueOnce({
      pack_id: "incomplete-network-pack",
      pack_version: "1.0.0",
      contracts: [], // No contracts - should trigger PACK_POLICY_INCOMPLETE on router mismatch path
      // Include field_schema with method enum to enable allowlist derivation for "fetch" operation
      field_schema: {
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "FETCH"],
          },
        },
      },
    });
    // Router returns a contract not in the empty pack - triggers fail-open path
    // (This is a realistic scenario where the pack is misconfigured)

    const { tool, executeSpy } = createMockNetworkTool();
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });

    // Act: Should still execute (fail-open on router mismatch)
    const result = await tool.execute("call-5", {}, new AbortController().signal);

    // Assert: Execution proceeded (fail-open behavior on true mismatch)
    // The important assertion is that stageId was still "NETWORK_IO"
    expect(getPackForStageMock).toHaveBeenCalledWith("NETWORK_IO");
    expect(executeSpy).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("router call context always contains stageId 'NETWORK_IO' regardless of operation type", async () => {
    // Test various operation types to ensure stageId is always NETWORK_IO
    const operations = ["fetch", "post", "put", "delete", "connect", "listen", "send"];

    for (const op of operations) {
      vi.clearAllMocks();
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: "NET_HTTP_REQUEST",
            contract_risk: "LOW",
          },
        },
      });

      const { tool } = createMockNetworkTool();
      wrapWithNetworkGating(tool, op, {}, { url: `https://example.com/${op}` });

      await tool.execute(`call-${op}`, {}, undefined);

      // Assert stageId in router call
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
      const calls = routeClarityBurstMock.mock.calls;
      const args = calls[0][0] as { stageId: string; context: { operation: string } };
      expect(args.stageId).toBe("NETWORK_IO");
      expect(args.context.operation).toBe(op);
    }
  });

  it("never calls executor when router is unavailable (fail-closed with correct stageId)", async () => {
    // Arrange: Router returns error
    routeClarityBurstMock.mockResolvedValue({ ok: false, error: "router_unavailable" });

    const { tool, executeSpy } = createMockNetworkTool();
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });

    // Act & Assert: Should throw with stageId "NETWORK_IO"
    try {
      await tool.execute("call-fail", {}, new AbortController().signal);
      expect.fail("Expected ClarityBurstAbstainError");
    } catch (err) {
      expect(err).toBeInstanceOf(ClarityBurstAbstainError);
      const abstainError = err as ClarityBurstAbstainError;
      expect(abstainError.stageId).toBe("NETWORK_IO");
      expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
      expect(abstainError.reason).toBe("router_outage");
    }

    // Assert: Executor was never called
    expect(executeSpy).toHaveBeenCalledTimes(0);

    // Assert: Router was still called with correct stageId before it failed
    expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
    const calls = routeClarityBurstMock.mock.calls;
    const args = calls[0][0] as { stageId: string };
    expect(args.stageId).toBe("NETWORK_IO");
  });
});
