import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression Test: PackPolicyIncompleteError → ClarityBurstAbstainError conversion
 *
 * This test suite validates the central error-mapping rule that ensures
 * PackPolicyIncompleteError is always converted into a ClarityBurstAbstainError
 * with { outcome:"ABSTAIN_CLARIFY", reason:"PACK_POLICY_INCOMPLETE", contractId:null }
 * at the SHELL_EXEC commit-point wrapper (execTool.execute).
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

// Mock decision-override (should never be reached when pack fails)
vi.mock("../clarityburst/decision-override.js", () => ({
  applyShellExecOverrides: vi.fn(),
}));

// Mock exec-approvals to allow all (not testing approval logic here)
vi.mock("../infra/exec-approvals.js", () => ({
  addAllowlistEntry: vi.fn(),
  evaluateShellAllowlist: vi.fn().mockReturnValue({
    analysisOk: true,
    allowlistSatisfied: true,
    allowlistMatches: [],
    segments: [],
  }),
  maxAsk: vi.fn().mockReturnValue("off"),
  minSecurity: vi.fn().mockReturnValue("full"),
  recordAllowlistUse: vi.fn(),
  requiresExecApproval: vi.fn().mockReturnValue(false),
  resolveSafeBins: vi.fn().mockReturnValue(new Set()),
  resolveExecApprovals: vi.fn().mockReturnValue({
    agent: { security: "full", ask: "off" },
    allowlist: [],
    file: {},
  }),
  resolveExecApprovalsFromFile: vi.fn(),
}));

// Mock system-events to prevent actual event emissions
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

// Mock heartbeat-wake to prevent actual heartbeat requests
vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

// Mock shell-env to provide default PATH
vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn().mockReturnValue("/usr/bin:/bin"),
  resolveShellEnvFallbackTimeoutMs: vi.fn().mockReturnValue(5000),
}));

// Mock session-key functions
vi.mock("../routing/session-key.js", () => ({
  parseAgentSessionKey: vi.fn().mockReturnValue(null),
  resolveAgentIdFromSessionKey: vi.fn().mockReturnValue(undefined),
}));

import { createExecTool } from "./bash-tools.exec.js";
import { ClarityBurstAbstainError } from "../clarityburst/errors.js";
import { PackPolicyIncompleteError } from "../clarityburst/pack-registry.js";

describe("SHELL_EXEC - PackPolicyIncompleteError error mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("execTool.execute: malformed pack causes blocked nonRetryable response", () => {
    /**
     * Regression test: PackPolicyIncompleteError → ClarityBurstAbstainError
     *
     * When getPackForStage("SHELL_EXEC") throws PackPolicyIncompleteError,
     * the exec tool execute must:
     * 1. NOT call the router
     * 2. NOT call the executor
     * 3. Throw ClarityBurstAbstainError with deterministic fields
     */
    it("throws ClarityBurstAbstainError with exact fields when getPackForStage throws PackPolicyIncompleteError", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      const packError = new PackPolicyIncompleteError(
        "SHELL_EXEC",
        ["contracts", "pack_version"],
        "malformed-test-pack"
      );
      getPackForStageMock.mockImplementation(() => {
        throw packError;
      });

      const execTool = createExecTool({ sandbox: undefined });

      // Act & Assert: Should throw ClarityBurstAbstainError
      await expect(
        execTool.execute("call-1", { command: "echo hello" }, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      try {
        await execTool.execute("call-2", { command: "echo hello" }, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // INVARIANT: Exact fields for PackPolicyIncompleteError conversion
        expect(abstainError.stageId).toBe("SHELL_EXEC");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();

        // INVARIANT: Instructions contain deterministic error details
        expect(abstainError.instructions).toContain("SHELL_EXEC");
        expect(abstainError.instructions).toContain("contracts");
        expect(abstainError.instructions).toContain("pack_version");
      }

      // INVARIANT: Router MUST NOT be called when pack validation fails
      expect(routeClarityBurstMock).not.toHaveBeenCalled();
    });

    it("does NOT throw unhandled exception - error is always converted", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      getPackForStageMock.mockImplementation(() => {
        throw new PackPolicyIncompleteError("SHELL_EXEC", ["capability_requirements"]);
      });

      const execTool = createExecTool({ sandbox: undefined });

      // Act & Assert: Exception type is always ClarityBurstAbstainError (not PackPolicyIncompleteError)
      let caughtError: unknown = null;
      try {
        await execTool.execute("call-1", { command: "echo hello" }, new AbortController().signal);
      } catch (err) {
        caughtError = err;
      }

      // Must be ClarityBurstAbstainError (not the original PackPolicyIncompleteError)
      expect(caughtError).not.toBeInstanceOf(PackPolicyIncompleteError);
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
    });

    it("propagates deterministic instructions from PackPolicyIncompleteError fields", async () => {
      // Arrange: Multiple missing fields with pack ID
      const missingFields = ["contracts", "thresholds", "field_schema"];
      getPackForStageMock.mockImplementation(() => {
        throw new PackPolicyIncompleteError("SHELL_EXEC", missingFields, "test-pack-v2");
      });

      const execTool = createExecTool({ sandbox: undefined });

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await execTool.execute("call-1", { command: "echo hello" }, new AbortController().signal);
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
        throw new PackPolicyIncompleteError("SHELL_EXEC", ["contracts"]);
      });

      const execTool = createExecTool({ sandbox: undefined });

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await execTool.execute("call-adapter-test", { command: "echo hello" }, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: All fields needed for adapter conversion are present
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("SHELL_EXEC");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(typeof caughtError!.instructions).toBe("string");
      expect(caughtError!.instructions.length).toBeGreaterThan(0);

      // INVARIANT: Router never called
      expect(routeClarityBurstMock).not.toHaveBeenCalled();
    });
  });

  describe("SHELL_EXEC: non-PackPolicyIncompleteError errors are re-thrown", () => {
    /**
     * Ensures that only PackPolicyIncompleteError is converted;
     * other errors from getPackForStage propagate unchanged.
     */
    it("re-throws non-PackPolicyIncompleteError errors from execTool", async () => {
      // Arrange: Mock getPackForStage to throw a different error type
      const unexpectedError = new Error("Unexpected database connection error");
      getPackForStageMock.mockImplementation(() => {
        throw unexpectedError;
      });

      const execTool = createExecTool({ sandbox: undefined });

      // Act & Assert: Should re-throw the original error (not convert it)
      let caughtError: unknown = null;
      try {
        await execTool.execute("call-1", { command: "echo hello" }, new AbortController().signal);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBe(unexpectedError);
      expect(caughtError).not.toBeInstanceOf(ClarityBurstAbstainError);

      // INVARIANT: Router not called due to early error
      expect(routeClarityBurstMock).not.toHaveBeenCalled();
    });
  });
});
