import { describe, expect, it, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION TEST: FILE_SYSTEM_OPS empty allowedContractIds runtime invariant
// ─────────────────────────────────────────────────────────────────────────────
// This test validates that:
// 1. When deriveAllowedContracts() returns [] for FILE_SYSTEM_OPS, write/edit ops
//    throw ClarityBurstAbstainError with ABSTAIN_CLARIFY + PACK_POLICY_INCOMPLETE
// 2. routeClarityBurst() is NEVER called (blocked before routing)
// 3. The underlying executor is NEVER called (blocked before execution)
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

// Mock the sandbox path assertion to always pass (not testing sandbox paths here)
vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: vi.fn().mockResolvedValue(undefined),
}));

// Mock the underlying pi-coding-agent tools
const mockWriteExecute = vi.fn();
const mockEditExecute = vi.fn();
const mockReadExecute = vi.fn();
vi.mock("@mariozechner/pi-coding-agent", () => ({
  createWriteTool: () => ({
    name: "write",
    label: "Write File",
    description: "Write content to a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    execute: mockWriteExecute,
  }),
  createEditTool: () => ({
    name: "edit",
    label: "Edit File",
    description: "Edit a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path", "oldText", "newText"],
    },
    execute: mockEditExecute,
  }),
  createReadTool: () => ({
    name: "read",
    label: "Read File",
    description: "Read content from a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    execute: mockReadExecute,
  }),
}));

import {
  createSandboxedWriteTool,
  createSandboxedEditTool,
} from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "../clarityburst/errors.js";

describe("FILE_SYSTEM_OPS empty allowedContractIds runtime invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Configure mock executors to return a valid result (should never be called)
    mockWriteExecute.mockResolvedValue({
      content: [{ type: "text" as const, text: "File written successfully" }],
      details: { ok: true },
    });
    mockEditExecute.mockResolvedValue({
      content: [{ type: "text" as const, text: "File edited successfully" }],
      details: { ok: true },
    });
    mockReadExecute.mockResolvedValue({
      content: [{ type: "text" as const, text: "File content here" }],
      details: { ok: true },
    });
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
  describe("write operations blocked with empty allowedContractIds", () => {
    it("throws ClarityBurstAbstainError with exact fields when deriveAllowedContracts returns []", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

      const writeTool = createSandboxedWriteTool("/sandbox/root");

      // Act & Assert: Should throw ClarityBurstAbstainError
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await writeTool.execute(
          "call-1",
          { path: "test.txt", content: "hello world" },
          new AbortController().signal
        );
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
      expect(caughtError!.stageId).toBe("FILE_SYSTEM_OPS");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toBe(
        "No contracts permitted by current capability set; cannot proceed."
      );

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Underlying executor was NEVER called - blocked before execution
      expect(mockWriteExecute).toHaveBeenCalledTimes(0);
    });

    it("blocks write to sensitive paths with empty allowedContractIds", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

      const writeTool = createSandboxedWriteTool("/sandbox/root");

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await writeTool.execute(
          "call-2",
          { path: "config/secrets.json", content: '{"api_key": "secret"}' },
          new AbortController().signal
        );
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
      expect(mockWriteExecute).toHaveBeenCalledTimes(0);
    });
  });

  describe("edit operations blocked with empty allowedContractIds", () => {
    it("throws ClarityBurstAbstainError with exact fields when deriveAllowedContracts returns []", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

      const editTool = createSandboxedEditTool("/sandbox/root");

      // Act & Assert: Should throw ClarityBurstAbstainError
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await editTool.execute(
          "call-3",
          { path: "test.txt", oldText: "hello", newText: "goodbye" },
          new AbortController().signal
        );
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
      expect(caughtError!.stageId).toBe("FILE_SYSTEM_OPS");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(caughtError!.instructions).toBe(
        "No contracts permitted by current capability set; cannot proceed."
      );

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Underlying executor was NEVER called - blocked before execution
      expect(mockEditExecute).toHaveBeenCalledTimes(0);
    });

    it("blocks edit operations with Claude-style parameters", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

      const editTool = createSandboxedEditTool("/sandbox/root");

      // Act & Assert: Using Claude Code-style parameters (file_path, old_string, new_string)
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await editTool.execute(
          "call-4",
          { file_path: "test.txt", old_string: "hello", new_string: "goodbye" },
          new AbortController().signal
        );
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
      expect(mockEditExecute).toHaveBeenCalledTimes(0);
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
    it("does not accidentally fail-open on write when router would return unknown contract", async () => {
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

      const writeTool = createSandboxedWriteTool("/sandbox/root");

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await writeTool.execute(
          "call-5",
          { path: "test.txt", content: "malicious content" },
          new AbortController().signal
        );
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
      expect(mockWriteExecute).toHaveBeenCalledTimes(0);
    });

    it("does not accidentally fail-open on edit when router would return unknown contract", async () => {
      // Arrange: Mock deriveAllowedContracts to return empty array
      deriveAllowedContractsMock.mockReturnValue([]);

      // This mock should never be called
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "UNKNOWN_CONTRACT_NOT_IN_PACK", score: 0.99 },
          top2: { contract_id: "ANOTHER_UNKNOWN", score: 0.8 },
        },
      });

      const editTool = createSandboxedEditTool("/sandbox/root");

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await editTool.execute(
          "call-6",
          { path: "test.txt", oldText: "hello", newText: "malicious code" },
          new AbortController().signal
        );
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
      expect(mockEditExecute).toHaveBeenCalledTimes(0);
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
    it("calls routeClarityBurst for write when allowedContractIds is non-empty", async () => {
      // Arrange: Mock deriveAllowedContracts to return a non-empty array
      deriveAllowedContractsMock.mockReturnValue(["FS_WRITE_USER_DIR", "FS_EDIT_SOURCE"]);

      // Mock router to return a valid contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "FS_WRITE_USER_DIR", score: 0.95 },
          top2: { contract_id: "FS_EDIT_SOURCE", score: 0.7 },
        },
      });

      const writeTool = createSandboxedWriteTool("/sandbox/root");

      // Act: Execute (may throw for other reasons, but router should be called)
      try {
        await writeTool.execute(
          "call-7",
          { path: "test.txt", content: "hello" },
          new AbortController().signal
        );
      } catch {
        // Expected - other checks may fail, but router should have been called
      }

      // Assert: Router WAS called - invariant did not fire
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Correct stageId passed to router
      const routerCallArgs = routeClarityBurstMock.mock.calls[0][0];
      expect(routerCallArgs.stageId).toBe("FILE_SYSTEM_OPS");
      expect(routerCallArgs.allowedContractIds).toEqual(["FS_WRITE_USER_DIR", "FS_EDIT_SOURCE"]);
    });

    it("calls routeClarityBurst for edit when allowedContractIds is non-empty", async () => {
      // Arrange: Mock deriveAllowedContracts to return a non-empty array
      deriveAllowedContractsMock.mockReturnValue(["FS_WRITE_USER_DIR", "FS_EDIT_SOURCE"]);

      // Mock router to return a valid contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "FS_EDIT_SOURCE", score: 0.95 },
          top2: { contract_id: "FS_WRITE_USER_DIR", score: 0.7 },
        },
      });

      const editTool = createSandboxedEditTool("/sandbox/root");

      // Act: Execute (may throw for other reasons, but router should be called)
      try {
        await editTool.execute(
          "call-8",
          { path: "test.txt", oldText: "hello", newText: "goodbye" },
          new AbortController().signal
        );
      } catch {
        // Expected - other checks may fail, but router should have been called
      }

      // Assert: Router WAS called - invariant did not fire
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Correct stageId passed to router
      const routerCallArgs = routeClarityBurstMock.mock.calls[0][0];
      expect(routerCallArgs.stageId).toBe("FILE_SYSTEM_OPS");
      expect(routerCallArgs.allowedContractIds).toEqual(["FS_WRITE_USER_DIR", "FS_EDIT_SOURCE"]);
    });
  });
});
