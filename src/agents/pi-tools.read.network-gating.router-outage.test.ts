import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock routeClarityBurst before importing the module under test
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (...args: unknown[]) => routeClarityBurstMock(...args),
}));

// Mock getPackForStage to return a minimal pack
vi.mock("../clarityburst/pack-registry.js", () => ({
  getPackForStage: () => ({
    pack_id: "test-network-pack",
    pack_version: "1.0.0",
    contracts: [],
  }),
}));

// Mock allowed-contracts to return an empty array
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: () => [],
}));

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "./bash-tools.exec.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("wrapWithNetworkGating", () => {
  // Create a mock tool that should never be executed when router fails
  // Returns the tool and a separate spy to track execute calls (since wrapWithNetworkGating mutates the tool)
  const createMockTool = (): { tool: AnyAgentTool; executeSpy: ReturnType<typeof vi.fn> } => {
    const executeSpy = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "mock result" }],
      details: { ok: true },
    }));
    return {
      tool: {
        name: "mock_fetch",
        label: "Mock Fetch",
        description: "Mock network fetch tool",
        parameters: { type: "object", properties: {} },
        execute: executeSpy,
      },
      executeSpy,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("NETWORK_IO fails closed on ClarityBurst router outage", () => {
    it("throws ClarityBurstAbstainError with exact fields when routeClarityBurst returns { ok: false }", async () => {
      // Arrange: Mock router to return { ok: false }
      routeClarityBurstMock.mockResolvedValue({ ok: false, error: "router_unavailable" });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act & Assert
      await expect(wrappedTool.execute("call-1", {}, new AbortController().signal))
        .rejects.toThrow(ClarityBurstAbstainError);

      try {
        await wrappedTool.execute("call-2", {}, new AbortController().signal);
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // Assert exact fields as specified
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("router_outage");
        expect(abstainError.contractId).toBeNull();
      }

      // Verify the underlying tool was never called (non-retryable abort)
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("throws ClarityBurstAbstainError with exact fields when routeClarityBurst throws", async () => {
      // Arrange: Mock router to throw an error (simulating network failure)
      routeClarityBurstMock.mockRejectedValue(new Error("Connection refused"));

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "POST",
        { userText: "post to https://api.example.com/submit" },
        { url: "https://api.example.com/submit" }
      );

      // Act & Assert
      await expect(wrappedTool.execute("call-1", {}, new AbortController().signal))
        .rejects.toThrow(ClarityBurstAbstainError);

      try {
        await wrappedTool.execute("call-2", {}, new AbortController().signal);
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // Assert exact fields as specified
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("router_outage");
        expect(abstainError.contractId).toBeNull();
      }

      // Verify the underlying tool was never called (non-retryable abort)
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does NOT proceed with tool execution when router is unavailable (fail-closed behavior)", async () => {
      // Arrange: Mock router to return { ok: false }
      routeClarityBurstMock.mockResolvedValue({ ok: false, error: "timeout" });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "DELETE",
        undefined,
        { url: "https://api.example.com/resource/123" }
      );

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: Error was thrown with correct properties
      expect(caughtError).not.toBeNull();
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("router_outage");
      expect(caughtError!.contractId).toBeNull();

      // Assert: The proceed path was NOT exercised
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("includes descriptive instructions in the error", async () => {
      // Arrange
      routeClarityBurstMock.mockResolvedValue({ ok: false, error: "service_unavailable" });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "PATCH",
        undefined,
        { url: "https://api.example.com/update" }
      );

      // Act & Assert
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // Verify instructions mention the operation and router unavailability
        expect(abstainError.instructions).toContain("ClarityBurst router is unavailable");
        expect(abstainError.instructions).toContain("patch"); // operation normalized to lowercase
      }
    });
  });

  /**
   * ┌────────────────────────────────────────────────────────────────────────────┐
   * │  CENTRALIZED INVARIANT: "fail-open only on router mismatch" tripwire      │
   * ├────────────────────────────────────────────────────────────────────────────┤
   * │  This test proves that NETWORK_IO paths NEVER proceed to tool execution   │
   * │  when routeClarityBurst() returns ok:false (router outage), regardless    │
   * │  of whether applyNetworkOverrides() is mocked or bypassed.                │
   * │                                                                            │
   * │  Key invariant: fail-open is ONLY permitted on router mismatch (when      │
   * │  top1.contract_id doesn't match any pack contract). Router outage must    │
   * │  ALWAYS fail-closed.                                                       │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  describe("INVARIANT: router outage never permits fail-open (tripwire)", () => {
    it("blocks tool execution when ok:false AND top1 is absent (no routerMismatch path)", async () => {
      // Arrange: Router outage with NO top1 data at all
      // This ensures routerMismatch logic cannot be triggered since there's no contract to compare
      routeClarityBurstMock.mockResolvedValue({
        ok: false,
        error: "router_outage",
        // Explicitly: no 'data' field, no 'top1' - proving this isn't a mismatch scenario
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("tripwire-call-1", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded despite router outage");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // INVARIANT ASSERTIONS:
      // 1. Error MUST be ClarityBurstAbstainError with reason "router_outage"
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.reason).toBe("router_outage");

      // 2. Executor MUST NOT have been called - this is the critical invariant
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("blocks tool execution when ok:false AND top1 is null (explicit null, no routerMismatch path)", async () => {
      // Arrange: Router outage with explicit null top1
      // This variant catches edge cases where data exists but top1 is explicitly null
      routeClarityBurstMock.mockResolvedValue({
        ok: false,
        error: "router_outage",
        data: { top1: null }, // Explicitly null - cannot trigger mismatch comparison
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "POST",
        { userText: "post to https://api.example.com/submit" },
        { url: "https://api.example.com/submit" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("tripwire-call-2", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded despite router outage with null top1");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // INVARIANT ASSERTIONS:
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.reason).toBe("router_outage");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("blocks tool execution when ok:false AND data is undefined (no routerMismatch possible)", async () => {
      // Arrange: Router outage with undefined data
      // Most minimal outage response - no data field at all
      routeClarityBurstMock.mockResolvedValue({
        ok: false,
        error: "connection_refused",
        // data: undefined - implicitly absent
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "DELETE",
        { userText: "delete resource" },
        { url: "https://api.example.com/resource/123" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("tripwire-call-3", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded despite router outage with undefined data");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // INVARIANT ASSERTIONS:
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.reason).toBe("router_outage");
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("enforces fail-closed at wrapper commit point even when applyNetworkOverrides would PROCEED", async () => {
      /**
       * This is the critical "defense in depth" test.
       *
       * Scenario: Even if someone were to modify applyNetworkOverrides() to return
       * PROCEED on router outage, the wrapper's commit-point check must still block.
       *
       * We prove this by: router returns ok:false, so the code path should NEVER
       * reach applyNetworkOverrides in the first place. The ok:false check must
       * happen BEFORE any override logic.
       */
      routeClarityBurstMock.mockResolvedValue({
        ok: false,
        error: "router_unavailable",
        // No top1, no data - pure outage scenario
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "PUT",
        { userText: "update resource" },
        { url: "https://api.example.com/resource" }
      );

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("commit-point-check", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // INVARIANT ASSERTIONS - the commit-point invariant:
      // 1. Must throw ClarityBurstAbstainError
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      
      // 2. Reason must be "router_outage" (not any override-derived reason)
      expect(caughtError!.reason).toBe("router_outage");
      
      // 3. Outcome must be ABSTAIN_CLARIFY (fail-closed)
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      
      // 4. contractId must be null (no contract was matched due to outage)
      expect(caughtError!.contractId).toBeNull();
      
      // 5. stageId must be NETWORK_IO
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      
      // 6. CRITICAL: executeSpy MUST NOT have been called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });
  });
});
