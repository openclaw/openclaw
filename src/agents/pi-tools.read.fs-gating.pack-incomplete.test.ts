import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression Test: PackPolicyIncompleteError → ClarityBurstAbstainError conversion
 *
 * This test suite validates the central error-mapping rule that ensures
 * PackPolicyIncompleteError is always converted into a ClarityBurstAbstainError
 * with { outcome:"ABSTAIN_CLARIFY", reason:"PACK_POLICY_INCOMPLETE", contractId:null }
 * at the FILE_SYSTEM_OPS commit-point wrapper (writeTool.execute / editTool.execute).
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

// Mock sandbox-paths to allow all paths (not testing sandbox logic here)
vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: vi.fn().mockResolvedValue(undefined),
}));

// Mock createWriteTool/createEditTool from pi-coding-agent
vi.mock("@mariozechner/pi-coding-agent", () => ({
  createWriteTool: () => ({
    name: "write",
    label: "Write File",
    description: "Write content to a file",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "written" }], details: { ok: true } }),
  }),
  createEditTool: () => ({
    name: "edit",
    label: "Edit File",
    description: "Edit a file",
    parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } } },
    execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "edited" }], details: { ok: true } }),
  }),
  createReadTool: () => ({
    name: "read",
    label: "Read File",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file content" }], details: { ok: true } }),
  }),
}));

import { createSandboxedWriteTool, createSandboxedEditTool } from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "./bash-tools.exec.js";
import { PackPolicyIncompleteError } from "../clarityburst/pack-registry.js";

describe("FILE_SYSTEM_OPS - PackPolicyIncompleteError error mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("writeTool.execute: malformed pack causes blocked nonRetryable response", () => {
    /**
     * Regression test: PackPolicyIncompleteError → ClarityBurstAbstainError
     *
     * When getPackForStage("FILE_SYSTEM_OPS") throws PackPolicyIncompleteError,
     * the write tool execute must:
     * 1. NOT call the router
     * 2. NOT call the executor
     * 3. Throw ClarityBurstAbstainError with deterministic fields
     */
    it("throws ClarityBurstAbstainError with exact fields when getPackForStage throws PackPolicyIncompleteError", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      const packError = new PackPolicyIncompleteError(
        "FILE_SYSTEM_OPS",
        ["contracts", "pack_version"],
        "malformed-test-pack"
      );
      getPackForStageMock.mockImplementation(() => {
        throw packError;
      });

      const writeTool = createSandboxedWriteTool("/sandbox");

      // Act & Assert: Should throw ClarityBurstAbstainError
      await expect(
        writeTool.execute("call-1", { path: "/sandbox/test.txt", content: "hello" }, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      try {
        await writeTool.execute("call-2", { path: "/sandbox/test.txt", content: "hello" }, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // INVARIANT: Exact fields for PackPolicyIncompleteError conversion
        expect(abstainError.stageId).toBe("FILE_SYSTEM_OPS");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();

        // INVARIANT: Instructions contain deterministic error details
        expect(abstainError.instructions).toContain("FILE_SYSTEM_OPS");
        expect(abstainError.instructions).toContain("contracts");
        expect(abstainError.instructions).toContain("pack_version");
      }

      // INVARIANT: Router MUST NOT be called when pack validation fails
      expect(routeClarityBurstMock).not.toHaveBeenCalled();
    });

    it("does NOT throw unhandled exception - error is always converted", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      getPackForStageMock.mockImplementation(() => {
        throw new PackPolicyIncompleteError("FILE_SYSTEM_OPS", ["capability_requirements"]);
      });

      const writeTool = createSandboxedWriteTool("/sandbox");

      // Act & Assert: Exception type is always ClarityBurstAbstainError (not PackPolicyIncompleteError)
      let caughtError: unknown = null;
      try {
        await writeTool.execute("call-1", { path: "/sandbox/test.txt", content: "hello" }, new AbortController().signal);
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
        throw new PackPolicyIncompleteError("FILE_SYSTEM_OPS", missingFields, "test-pack-v2");
      });

      const writeTool = createSandboxedWriteTool("/sandbox");

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await writeTool.execute("call-1", { path: "/sandbox/test.txt", content: "hello" }, new AbortController().signal);
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
        throw new PackPolicyIncompleteError("FILE_SYSTEM_OPS", ["contracts"]);
      });

      const writeTool = createSandboxedWriteTool("/sandbox");

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await writeTool.execute("call-adapter-test", { path: "/sandbox/test.txt", content: "hello" }, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: All fields needed for adapter conversion are present
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("FILE_SYSTEM_OPS");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();
      expect(typeof caughtError!.instructions).toBe("string");
      expect(caughtError!.instructions.length).toBeGreaterThan(0);

      // INVARIANT: Router never called
      expect(routeClarityBurstMock).not.toHaveBeenCalled();
    });
  });

  describe("editTool.execute: malformed pack causes blocked nonRetryable response", () => {
    /**
     * Regression test: PackPolicyIncompleteError → ClarityBurstAbstainError for edit operations
     */
    it("throws ClarityBurstAbstainError with exact fields when getPackForStage throws PackPolicyIncompleteError", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      const packError = new PackPolicyIncompleteError(
        "FILE_SYSTEM_OPS",
        ["contracts", "pack_version"],
        "malformed-edit-pack"
      );
      getPackForStageMock.mockImplementation(() => {
        throw packError;
      });

      const editTool = createSandboxedEditTool("/sandbox");

      // Act & Assert: Should throw ClarityBurstAbstainError
      await expect(
        editTool.execute("call-1", { path: "/sandbox/test.txt", oldText: "old", newText: "new" }, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      try {
        await editTool.execute("call-2", { path: "/sandbox/test.txt", oldText: "old", newText: "new" }, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // INVARIANT: Exact fields for PackPolicyIncompleteError conversion
        expect(abstainError.stageId).toBe("FILE_SYSTEM_OPS");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();

        // INVARIANT: Instructions contain deterministic error details
        expect(abstainError.instructions).toContain("FILE_SYSTEM_OPS");
        expect(abstainError.instructions).toContain("contracts");
        expect(abstainError.instructions).toContain("pack_version");
      }

      // INVARIANT: Router MUST NOT be called when pack validation fails
      expect(routeClarityBurstMock).not.toHaveBeenCalled();
    });

    it("does NOT throw unhandled exception - error is always converted for edit operations", async () => {
      // Arrange: Mock getPackForStage to throw PackPolicyIncompleteError
      getPackForStageMock.mockImplementation(() => {
        throw new PackPolicyIncompleteError("FILE_SYSTEM_OPS", ["capability_requirements"]);
      });

      const editTool = createSandboxedEditTool("/sandbox");

      // Act & Assert: Exception type is always ClarityBurstAbstainError (not PackPolicyIncompleteError)
      let caughtError: unknown = null;
      try {
        await editTool.execute("call-1", { path: "/sandbox/test.txt", oldText: "old", newText: "new" }, new AbortController().signal);
      } catch (err) {
        caughtError = err;
      }

      // Must be ClarityBurstAbstainError (not the original PackPolicyIncompleteError)
      expect(caughtError).not.toBeInstanceOf(PackPolicyIncompleteError);
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
    });
  });

  describe("FILE_SYSTEM_OPS: non-PackPolicyIncompleteError errors are re-thrown", () => {
    /**
     * Ensures that only PackPolicyIncompleteError is converted;
     * other errors from getPackForStage propagate unchanged.
     */
    it("re-throws non-PackPolicyIncompleteError errors from writeTool", async () => {
      // Arrange: Mock getPackForStage to throw a different error type
      const unexpectedError = new Error("Unexpected database connection error");
      getPackForStageMock.mockImplementation(() => {
        throw unexpectedError;
      });

      const writeTool = createSandboxedWriteTool("/sandbox");

      // Act & Assert: Should re-throw the original error (not convert it)
      let caughtError: unknown = null;
      try {
        await writeTool.execute("call-1", { path: "/sandbox/test.txt", content: "hello" }, new AbortController().signal);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBe(unexpectedError);
      expect(caughtError).not.toBeInstanceOf(ClarityBurstAbstainError);

      // INVARIANT: Router not called due to early error
      expect(routeClarityBurstMock).not.toHaveBeenCalled();
    });

    it("re-throws non-PackPolicyIncompleteError errors from editTool", async () => {
      // Arrange: Mock getPackForStage to throw a different error type
      const unexpectedError = new Error("Unexpected file system error");
      getPackForStageMock.mockImplementation(() => {
        throw unexpectedError;
      });

      const editTool = createSandboxedEditTool("/sandbox");

      // Act & Assert: Should re-throw the original error (not convert it)
      let caughtError: unknown = null;
      try {
        await editTool.execute("call-1", { path: "/sandbox/test.txt", oldText: "old", newText: "new" }, new AbortController().signal);
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
