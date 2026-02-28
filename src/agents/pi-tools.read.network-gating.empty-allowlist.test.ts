import { describe, expect, it, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION TEST: NETWORK_IO empty allowedContractIds runtime invariant
// ─────────────────────────────────────────────────────────────────────────────
// This test validates that:
// 1. When deriveAllowedContracts() returns [] for NETWORK_IO, the wrapper
//    throws ClarityBurstAbstainError with ABSTAIN_CLARIFY + PACK_POLICY_INCOMPLETE
// 2. routeClarityBurst() is NEVER called (blocked before routing)
// 3. The executor is NEVER called (blocked before execution)
// ─────────────────────────────────────────────────────────────────────────────

// Mock routeClarityBurst before importing the module under test
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (...args: unknown[]) => routeClarityBurstMock(...args),
}));

// Mock deriveAllowedContracts to return empty array
const deriveAllowedContractsMock = vi.fn();
vi.mock("../clarityburst/allowed-contracts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../clarityburst/allowed-contracts.js")>();
  return {
    ...actual,
    deriveAllowedContracts: (...args: unknown[]) => deriveAllowedContractsMock(...args),
    // Keep createFullCapabilities as real implementation
    createFullCapabilities: actual.createFullCapabilities,
  };
});

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "../clarityburst/errors.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("NETWORK_IO empty allowedContractIds runtime invariant", () => {
  // Create a mock tool that should NEVER be executed when invariant blocks
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

  /**
   * ┌────────────────────────────────────────────────────────────────────────────┐
   * │  INVARIANT: Empty allowedContractIds MUST hard-block BEFORE routing       │
   * ├────────────────────────────────────────────────────────────────────────────┤
   * │  An empty allowedContractIds means capabilities deny everything (or the   │
   * │  pack/cap mapping is broken). In that state:                              │
   * │    - Routing results are meaningless (router can't pick a permitted       │
   * │      contract)                                                            │
   * │    - "fail-open only on mismatch" must not accidentally trigger           │
   * │    - The correct response is deterministic: clarify/block, not attempt    │
   * │                                                                           │
   * │  Expected behavior:                                                       │
   * │    - outcome: "ABSTAIN_CLARIFY"                                           │
   * │    - reason: "PACK_POLICY_INCOMPLETE"                                     │
   * │    - contractId: null                                                     │
   * │    - routeClarityBurst NEVER called (routerMock.callCount === 0)          │
   * │    - executor NEVER called (executeSpy.callCount === 0)                   │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  describe("empty allowedContractIds causes hard-block", () => {
    it("throws ClarityBurstAbstainError with exact fields when deriveAllowedContracts returns []", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act & Assert: Should throw ClarityBurstAbstainError
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      // Assert: Error has exact expected fields
      expect(caughtError).not.toBeNull();
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toBe(
        "No contracts permitted by current capability set; cannot proceed."
      );

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called - blocked before execution
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks POST operation with empty allowedContractIds", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

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
        await wrappedTool.execute("call-2", { body: "{}" }, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks DELETE operation with empty allowedContractIds", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "DELETE",
        { userText: "delete https://api.example.com/resource/123" },
        { url: "https://api.example.com/resource/123" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("call-3", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });
  });

  /**
   * ┌────────────────────────────────────────────────────────────────────────────┐
   * │  REGRESSION: Fail-open must NOT accidentally trigger with empty allowlist │
   * ├────────────────────────────────────────────────────────────────────────────┤
   * │  The fail-open logic for router mismatch (contract not in pack) must NOT  │
   * │  be reached when allowedContractIds is empty. The invariant check must    │
   * │  fire BEFORE any routing or mismatch logic executes.                      │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  describe("fail-open mismatch logic is unreachable with empty allowlist", () => {
    it("does not accidentally fail-open when router would return unknown contract", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      // Even if router returns a contract, we should never reach that code path
      deriveAllowedContractsMock.mockReturnValue([]);

      // This mock should never be called, but configure it to return an unknown contract
      // that would normally trigger fail-open mismatch logic
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "UNKNOWN_CONTRACT_NOT_IN_PACK", score: 0.99 },
          top2: { contract_id: "ANOTHER_UNKNOWN", score: 0.8 },
        },
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
        await wrappedTool.execute("call-4", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        if (err instanceof ClarityBurstAbstainError) {
          caughtError = err;
        } else {
          throw err;
        }
      }

      // Assert: We got the PACK_POLICY_INCOMPLETE error, not fail-open execution
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.instructions).toContain("No contracts permitted");

      // Assert: Router was NEVER called - invariant fired first
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called - fail-open did not trigger
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });
  });

  /**
   * ┌────────────────────────────────────────────────────────────────────────────┐
   * │  SANITY CHECK: Non-empty allowedContractIds proceeds to routing           │
   * ├────────────────────────────────────────────────────────────────────────────┤
   * │  When allowedContractIds is non-empty, the invariant should NOT fire and  │
   * │  the wrapper should proceed to call routeClarityBurst().                  │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  describe("non-empty allowedContractIds proceeds normally", () => {
    it("calls routeClarityBurst when allowedContractIds is non-empty", async () => {
      // Arrange: Mock deriveAllowedContracts to return a non-empty array
      deriveAllowedContractsMock.mockReturnValue(["NETWORK_GET_PUBLIC", "NETWORK_POST_DATA"]);

      // Mock router to return a valid contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "NETWORK_GET_PUBLIC", score: 0.95 },
          top2: { contract_id: "NETWORK_POST_DATA", score: 0.7 },
        },
      });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act: Execute (may throw for other reasons, but router should be called)
      try {
        await wrappedTool.execute("call-5", {}, new AbortController().signal);
      } catch {
        // Expected - other checks may fail, but router should have been called
      }

      // Assert: Router WAS called - invariant did not fire
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Correct stageId passed to router
      const routerCallArgs = routeClarityBurstMock.mock.calls[0][0];
      expect(routerCallArgs.stageId).toBe("NETWORK_IO");
      expect(routerCallArgs.allowedContractIds).toEqual(["NETWORK_GET_PUBLIC", "NETWORK_POST_DATA"]);
    });
  });
});
