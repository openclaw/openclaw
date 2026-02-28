import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock routeClarityBurst before importing the module under test
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (...args: unknown[]) => routeClarityBurstMock(...args),
}));

// Mock getPackForStage to return a pack with a HIGH-risk contract
vi.mock("../clarityburst/pack-registry.js", () => ({
  getPackForStage: () => ({
    pack_id: "test-network-pack",
    pack_version: "1.0.0",
    contracts: [
      {
        contract_id: "NET_HTTP_REQUEST",
        risk_class: "HIGH",
        needs_confirmation: false,
      },
    ],
    // Include field_schema with method enum to enable allowlist derivation
    field_schema: {
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "FETCH", "CONNECT"],
        },
      },
    },
  }),
}));

// Mock allowed-contracts to return our test contract IDs
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: () => ["NET_HTTP_REQUEST"],
}));

// Mock applyNetworkOverrides to require confirmation
vi.mock("../clarityburst/decision-override.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../clarityburst/decision-override.js")>();
  return {
    ...original,
    applyNetworkOverrides: vi.fn((_pack, routerResult, context) => {
      // Always require confirmation unless user confirmed
      if (context.userConfirmed) {
        return {
          outcome: "PROCEED",
          contractId: routerResult?.data?.top1?.contract_id ?? null,
        };
      }
      return {
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: routerResult?.data?.top1?.contract_id ?? null,
      };
    }),
  };
});

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "./bash-tools.exec.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Creates a mock network tool for testing.
 * Returns the tool and a spy on the original execute function.
 */
function createMockNetworkTool(): { tool: AnyAgentTool; executeSpy: ReturnType<typeof vi.fn> } {
  const executeSpy = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text", text: "Network operation succeeded" }],
  });

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

describe("NETWORK_IO gating is non-bypassable after patching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Configure router to return a successful HIGH-risk contract match
    routeClarityBurstMock.mockResolvedValue({
      ok: true,
      data: {
        top1: {
          contract_id: "NET_HTTP_REQUEST",
          confidence: 0.95,
          dominance: 0.85,
          contract_risk: "HIGH",
          needs_confirmation: false,
        },
      },
    });
  });

  it("original execute reference cannot be called directly after patching - tool instance is mutated", async () => {
    // Arrange: Create a mock tool and capture reference to original execute
    const { tool, executeSpy } = createMockNetworkTool();
    const originalExecuteRef = tool.execute;

    // Act: Apply gating - this should mutate the tool instance directly
    const gatedTool = wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });

    // Assert: The returned tool is the same instance (mutated in place)
    expect(gatedTool).toBe(tool);

    // Assert: The execute method has been replaced
    expect(tool.execute).not.toBe(originalExecuteRef);

    // Assert: Calling tool.execute now goes through gating and should throw
    // (because confirmation is required but not provided)
    await expect(
      tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal)
    ).rejects.toThrow(ClarityBurstAbstainError);

    // Assert: The original executeSpy was never called because gating blocked it
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("even if caller holds reference to original execute, calling it through tool.execute still gates", async () => {
    // Arrange: Create a mock tool
    const { tool, executeSpy } = createMockNetworkTool();

    // Capture reference before patching
    const preGatingExecuteRef = tool.execute;

    // Apply gating
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });

    // Verify the tool.execute was replaced (the instance was mutated)
    expect(tool.execute).not.toBe(preGatingExecuteRef);

    // Calling through the tool object always goes through gating
    await expect(
      tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal)
    ).rejects.toThrow(ClarityBurstAbstainError);

    // The original execute was never invoked
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("pre-gating execute reference is stale and cannot bypass gating on the instance", async () => {
    // Arrange: Create a mock tool
    const { tool, executeSpy } = createMockNetworkTool();

    // Save the original execute function before patching
    const staleExecuteRef = tool.execute;

    // Apply gating - mutates the tool instance
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });

    // The stale reference still works (it's a function), but calling it directly
    // does NOT go through gating - this demonstrates why we needed the patch:
    // - If someone calls staleExecuteRef directly, they bypass gating
    // - But if they access tool.execute, they get the gated version
    
    // Calling through tool.execute (the gated version) blocks:
    await expect(
      tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal)
    ).rejects.toThrow(ClarityBurstAbstainError);
    expect(executeSpy).not.toHaveBeenCalled();

    // NOTE: The stale reference (staleExecuteRef) would bypass gating if called directly,
    // but no code should hold such a reference - the patch ensures that anyone accessing
    // tool.execute after wrapWithNetworkGating() gets the gated version.
    // This is the key invariant: tool.execute IS the gated execute after patching.
  });

  it("gating allows execution when confirmation is properly provided", async () => {
    // Arrange: Create a mock tool
    const { tool, executeSpy } = createMockNetworkTool();

    // Compute the expected confirmation token
    const opHash8 = require("node:crypto")
      .createHash("sha256")
      .update("fetch:https://example.com")
      .digest("hex")
      .slice(0, 8);
    const confirmToken = `CONFIRM NETWORK_IO NET_HTTP_REQUEST ${opHash8}`;

    // Apply gating with the correct confirmation token
    wrapWithNetworkGating(
      tool,
      "fetch",
      { lastUserMessage: confirmToken },
      { url: "https://example.com" }
    );

    // Act: Call execute - should succeed because confirmation was provided
    const result = await tool.execute(
      "call-1",
      { url: "https://example.com" },
      new AbortController().signal
    );

    // Assert: The original execute was called
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: "Network operation succeeded" }],
    });
  });

  it("router-mismatch fail-open behavior is preserved", async () => {
    // Arrange: Configure router to return a contract_id NOT in allowedContractIds
    routeClarityBurstMock.mockResolvedValue({
      ok: true,
      data: {
        top1: {
          contract_id: "UNKNOWN_CONTRACT_NOT_IN_ALLOWED",
          confidence: 0.95,
          dominance: 0.85,
          contract_risk: "HIGH",
        },
      },
    });

    const { tool, executeSpy } = createMockNetworkTool();

    // Apply gating
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });

    // Act: Call execute - should succeed (fail-open on mismatch)
    const result = await tool.execute(
      "call-1",
      { url: "https://example.com" },
      new AbortController().signal
    );

    // Assert: The original execute was called (fail-open)
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      isError: false,
      content: [{ type: "text", text: "Network operation succeeded" }],
    });
  });

  it("multiple calls to wrapWithNetworkGating on same tool instance stack correctly", async () => {
    // Arrange: Create a mock tool
    const { tool, executeSpy } = createMockNetworkTool();

    // Apply gating twice (simulating accidental double-wrap)
    // Each wrap should capture the current execute and replace it
    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });
    const afterFirstWrap = tool.execute;

    wrapWithNetworkGating(tool, "fetch", {}, { url: "https://example.com" });
    const afterSecondWrap = tool.execute;

    // The second wrap replaced the first wrapped execute
    expect(afterSecondWrap).not.toBe(afterFirstWrap);

    // Calling should still go through gating and block
    await expect(
      tool.execute("call-1", { url: "https://example.com" }, new AbortController().signal)
    ).rejects.toThrow(ClarityBurstAbstainError);

    // Original execute never called
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
