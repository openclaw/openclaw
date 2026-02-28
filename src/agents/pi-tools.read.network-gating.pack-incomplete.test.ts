import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression Test: PackPolicyIncompleteError → ClarityBurstAbstainError conversion
 *
 * This test suite validates the central error-mapping rule that ensures
 * PackPolicyIncompleteError is always converted into a ClarityBurstAbstainError
 * with { outcome:"ABSTAIN_CLARIFY", reason:"PACK_POLICY_INCOMPLETE", contractId:null }
 * at the commit-point wrapper (NETWORK_IO first).
 *
 * INVARIANT: A malformed pack must cause a blocked nonRetryable response
 * (not an unhandled exception, not a retry).
 */

// Mock routeClarityBurst before importing the module under test
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (...args: unknown[]) => routeClarityBurstMock(...args),
}));

// Mock getPackForStage to throw PackPolicyIncompleteError (will be overridden per-test)
const getPackForStageMock = vi.fn();
vi.mock("../clarityburst/pack-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../clarityburst/pack-registry.js")>("../clarityburst/pack-registry.js");
  return {
    ...actual,
    getPackForStage: (...args: unknown[]) => getPackForStageMock(...args),
  };
});

// Mock allowed-contracts to return an empty array (should never be reached when pack fails)
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: () => [],
}));

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "./bash-tools.exec.js";
import { PackPolicyIncompleteError } from "../clarityburst/pack-registry.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("wrapWithNetworkGating - PackPolicyIncompleteError error mapping", () => {
  /**
   * Create a mock tool that should never be executed when pack validation fails.
   * Returns the tool and a separate spy to track execute calls.
   */
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

  describe("NETWORK_IO: malformed pack causes blocked nonRetryable response", () => {
    /**
     * Regression test: PackPolicyIncompleteError → ClarityBurstAbstainError
     *
     * When getPackForStage("NETWORK_IO") throws PackPolicyIncompleteError,
     * executeWithNetworkGating must:
     * 1. NOT call the router
     * 2. NOT call the executor
     * 3. Throw ClarityBurstAbstainError with deterministic fields
     */
    it("throws ClarityBurstAbstainError with exact fields when getPackForStage throws PackPolicyIncompleteError", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      const packError = new PackPolicyIncompleteError(
        "NETWORK_IO",
        ["contracts", "pack_version"],
        "malformed-test-pack"
      );
      getPackForStageMock.mockImplementation(() => {
        throw packError;
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act & Assert: Should throw ClarityBurstAbstainError
      await expect(wrappedTool.execute("call-1", {}, new AbortController().signal))
        .rejects.toThrow(ClarityBurstAbstainError);

      try {
        await wrappedTool.execute("call-2", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // INVARIANT: Exact fields for PackPolicyIncompleteError conversion
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();

        // INVARIANT: Instructions contain deterministic error details
        expect(abstainError.instructions).toContain("NETWORK_IO");
        expect(abstainError.instructions).toContain("contracts");
        expect(abstainError.instructions).toContain("pack_version");
      }

      // INVARIANT: Router MUST NOT be called when pack validation fails
      expect(routeClarityBurstMock).not.toHaveBeenCalled();

      // INVARIANT: Executor MUST NOT be called when pack validation fails
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("does NOT throw unhandled exception - error is always converted", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      getPackForStageMock.mockImplementation(() => {
        throw new PackPolicyIncompleteError("NETWORK_IO", ["capability_requirements"]);
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "POST",
        { userText: "post to https://api.example.com/submit" },
        { url: "https://api.example.com/submit" }
      );

      // Act & Assert: Exception type is always ClarityBurstAbstainError (not PackPolicyIncompleteError)
      let caughtError: unknown = null;
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err;
      }

      // Must be ClarityBurstAbstainError (not the original PackPolicyIncompleteError)
      expect(caughtError).not.toBeInstanceOf(PackPolicyIncompleteError);
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);

      // INVARIANT: Executor never called
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("propagates deterministic instructions from PackPolicyIncompleteError fields", async () => {
      // Arrange: Multiple missing fields with pack ID
      const missingFields = ["contracts", "thresholds", "field_schema"];
      getPackForStageMock.mockImplementation(() => {
        throw new PackPolicyIncompleteError("NETWORK_IO", missingFields, "test-pack-v2");
      });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "DELETE",
        { userText: "delete https://api.example.com/resource/123" },
        { url: "https://api.example.com/resource/123" }
      );

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: Instructions include all missing fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      for (const field of missingFields) {
        expect(caughtError!.instructions).toContain(field);
      }
    });

    /**
     * Regression test: ClarityBurstAbstainError has correct fields for adapter conversion
     *
     * The adapter uses these fields to generate a blocked response with:
     * - status: "blocked"
     * - nonRetryable: true
     * - reason: "PACK_POLICY_INCOMPLETE"
     *
     * This test verifies the error has the correct structure for that conversion.
     */
    it("ClarityBurstAbstainError has correct fields for adapter blocked response conversion", async () => {
      // Arrange
      getPackForStageMock.mockImplementation(() => {
        throw new PackPolicyIncompleteError("NETWORK_IO", ["contracts"]);
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("call-adapter-test", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: All fields needed for adapter conversion are present
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(typeof caughtError!.instructions).toBe("string");
      expect(caughtError!.instructions.length).toBeGreaterThan(0);

      // INVARIANT: Router never called
      expect(routeClarityBurstMock).not.toHaveBeenCalled();

      // INVARIANT: Executor never called
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe("NETWORK_IO: non-PackPolicyIncompleteError errors are re-thrown", () => {
    /**
     * Ensures that only PackPolicyIncompleteError is converted;
     * other errors from getPackForStage propagate unchanged.
     */
    it("re-throws non-PackPolicyIncompleteError errors", async () => {
      // Arrange: Mock getPackForStage to throw a different error type
      const unexpectedError = new Error("Unexpected database connection error");
      getPackForStageMock.mockImplementation(() => {
        throw unexpectedError;
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        undefined,
        { url: "https://api.example.com" }
      );

      // Act & Assert: Should re-throw the original error (not convert it)
      let caughtError: unknown = null;
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBe(unexpectedError);
      expect(caughtError).not.toBeInstanceOf(ClarityBurstAbstainError);

      // INVARIANT: Router not called due to early error
      expect(routeClarityBurstMock).not.toHaveBeenCalled();

      // INVARIANT: Executor not called due to early error
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });
});
