import { describe, expect, it, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// Mock routeClarityBurst before importing the module under test
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (...args: unknown[]) => routeClarityBurstMock(...args),
}));

// Mock getPackForStage with vi.fn() so we can override return values per-test
const getPackForStageMock = vi.fn(() => ({
  pack_id: "test-network-pack",
  pack_version: "1.0.0",
  contracts: [
    {
      contract_id: "NET_HTTP_REQUEST",
      risk_class: "HIGH",
      needs_confirmation: false,
    },
    {
      contract_id: "NET_EXTERNAL_POST",
      risk_class: "CRITICAL",
      needs_confirmation: true,
    },
  ],
  // Include field_schema with method enum to enable allowlist derivation
  field_schema: {
    properties: {
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "FETCH"],
      },
    },
  },
}));
vi.mock("../clarityburst/pack-registry.js", () => ({
  getPackForStage: () => getPackForStageMock(),
}));

// Mock allowed-contracts with vi.fn() so we can override return values per-test
const deriveAllowedContractsMock = vi.fn(() => ["NET_HTTP_REQUEST", "NET_EXTERNAL_POST"]);
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: () => deriveAllowedContractsMock(),
}));

// Mock applyNetworkOverrides to simulate confirmation requirements
vi.mock("../clarityburst/decision-override.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../clarityburst/decision-override.js")>();
  return {
    ...original,
    applyNetworkOverrides: vi.fn((pack, routerResult, context) => {
      // If userConfirmed is true, return PROCEED
      if (context.userConfirmed) {
        return {
          outcome: "PROCEED",
          contractId: routerResult?.data?.top1?.contract_id ?? null,
        };
      }
      // For HIGH/CRITICAL risk contracts without confirmation, return ABSTAIN_CONFIRM
      const contract = routerResult?.data?.top1;
      const riskClass = contract?.contract_risk?.toUpperCase?.() ?? "";
      if (riskClass === "HIGH" || riskClass === "CRITICAL" || contract?.needs_confirmation) {
        return {
          outcome: "ABSTAIN_CONFIRM",
          reason: "CONFIRM_REQUIRED",
          contractId: contract?.contract_id ?? null,
        };
      }
      return {
        outcome: "PROCEED",
        contractId: contract?.contract_id ?? null,
      };
    }),
  };
});

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { canonicalizeUrl } from "../clarityburst/canonicalize.js";
import { ClarityBurstAbstainError } from "./bash-tools.exec.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Helper to compute the expected opHash8 for a network operation.
 * Uses the exported canonicalizeUrl() to ensure single source of truth.
 */
function computeExpectedOpHash8(operation: string, url: string): string {
  const canonicalUrl = canonicalizeUrl(url);
  const basis = `${operation}:${canonicalUrl}`;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 8);
}

describe("wrapWithNetworkGating confirmation gating", () => {
  // Create a mock tool for testing
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

  describe("ABSTAIN_CONFIRM is thrown when confirmation is required", () => {
    it("throws when lastUserMessage is missing", async () => {
      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: "NET_HTTP_REQUEST",
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "fetch",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act & Assert
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      try {
        await wrappedTool.execute("call-2", {}, new AbortController().signal);
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.outcome).toBe("ABSTAIN_CONFIRM");
      }

      // Tool should not be executed
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("throws when lastUserMessage is wrong (partial match)", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);
      const expectedToken = `CONFIRM NETWORK_IO ${contractId} ${opHash8}`;

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // Partial match - missing the hash
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch data",
          lastUserMessage: `CONFIRM NETWORK_IO ${contractId}`, // Missing opHash8
        },
        { url: targetUrl }
      );

      // Act & Assert
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("throws when lastUserMessage has extra whitespace", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);
      const expectedToken = `CONFIRM NETWORK_IO ${contractId} ${opHash8}`;

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // Token with leading/trailing whitespace should NOT match (exact match required)
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch data",
          lastUserMessage: ` ${expectedToken} `, // Extra whitespace
        },
        { url: targetUrl }
      );

      // Act & Assert
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("throws when lastUserMessage has different case", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // Lowercase "confirm" should NOT match
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch data",
          lastUserMessage: `confirm NETWORK_IO ${contractId} ${opHash8}`, // lowercase confirm
        },
        { url: targetUrl }
      );

      // Act & Assert
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("throws when lastUserMessage has wrong contract ID", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: "NET_HTTP_REQUEST",
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // Wrong contract ID
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch data",
          lastUserMessage: `CONFIRM NETWORK_IO WRONG_CONTRACT ${opHash8}`,
        },
        { url: targetUrl }
      );

      // Act & Assert
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("throws when lastUserMessage has wrong opHash8 (different URL)", async () => {
      const targetUrl = "https://api.example.com/data";
      const differentUrl = "https://api.example.com/other";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";
      const wrongOpHash8 = computeExpectedOpHash8(op, differentUrl);

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // opHash8 computed from different URL should NOT match
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch data",
          lastUserMessage: `CONFIRM NETWORK_IO ${contractId} ${wrongOpHash8}`,
        },
        { url: targetUrl }
      );

      // Act & Assert
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("includes the expected confirmation token in ABSTAIN_CONFIRM instructions", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);
      const expectedToken = `CONFIRM NETWORK_IO ${contractId} ${opHash8}`;

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        { userText: "fetch data" }, // No lastUserMessage
        { url: targetUrl }
      );

      // Act & Assert
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.outcome).toBe("ABSTAIN_CONFIRM");
        // The instructions should contain the exact token user needs to confirm
        expect(abstainError.instructions).toBe(expectedToken);
      }
    });
  });

  describe("PROCEED occurs only with exact token match", () => {
    it("proceeds when lastUserMessage exactly matches expected token", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);
      const exactToken = `CONFIRM NETWORK_IO ${contractId} ${opHash8}`;

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch data",
          lastUserMessage: exactToken, // Exact match
        },
        { url: targetUrl }
      );

      // Act
      const result = await wrappedTool.execute("call-1", {}, new AbortController().signal);

      // Assert: Tool was executed
      expect(executeSpy).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("proceeds for CRITICAL risk contract with exact token match", async () => {
      const targetUrl = "https://api.example.com/submit";
      const op = "post";
      const contractId = "NET_EXTERNAL_POST";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);
      const exactToken = `CONFIRM NETWORK_IO ${contractId} ${opHash8}`;

      // Arrange: Router returns CRITICAL-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "CRITICAL",
            needs_confirmation: true,
            score: 0.98,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "post data",
          lastUserMessage: exactToken,
        },
        { url: targetUrl }
      );

      // Act
      const result = await wrappedTool.execute("call-1", {}, new AbortController().signal);

      // Assert: Tool was executed
      expect(executeSpy).toHaveBeenCalled();
    });
  });

  describe("replay/self-confirm bypass prevention", () => {
    it("cannot bypass confirmation using userText (only lastUserMessage is checked)", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";
      const opHash8 = computeExpectedOpHash8(op, targetUrl);
      const confirmToken = `CONFIRM NETWORK_IO ${contractId} ${opHash8}`;

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // Attempt to bypass by putting confirmation token in userText (not lastUserMessage)
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: confirmToken, // Token in userText should NOT work
          lastUserMessage: undefined, // No user message
        },
        { url: targetUrl }
      );

      // Act & Assert: Should still throw because lastUserMessage doesn't match
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("cannot replay old confirmation token for different URL", async () => {
      const originalUrl = "https://api.example.com/safe";
      const maliciousUrl = "https://api.example.com/dangerous";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";

      // Get the token for the original URL
      const originalOpHash8 = computeExpectedOpHash8(op, originalUrl);
      const oldToken = `CONFIRM NETWORK_IO ${contractId} ${originalOpHash8}`;

      // Arrange: Router returns HIGH-risk contract for the malicious URL
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // Attempt to replay old token for a different URL
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch dangerous data",
          lastUserMessage: oldToken, // Token for different URL
        },
        { url: maliciousUrl } // Different URL!
      );

      // Act & Assert: Should throw because opHash8 doesn't match
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("cannot replay confirmation token for different operation", async () => {
      const targetUrl = "https://api.example.com/data";
      const originalOp = "fetch";
      const maliciousOp = "delete";
      const contractId = "NET_HTTP_REQUEST";

      // Get the token for the original operation
      const originalOpHash8 = computeExpectedOpHash8(originalOp, targetUrl);
      const oldToken = `CONFIRM NETWORK_IO ${contractId} ${originalOpHash8}`;

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      // Attempt to replay token for different operation
      const wrappedTool = wrapWithNetworkGating(
        tool,
        maliciousOp, // Different operation!
        {
          userText: "delete data",
          lastUserMessage: oldToken, // Token for different operation
        },
        { url: targetUrl }
      );

      // Act & Assert: Should throw because opHash8 doesn't match
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("token is bound to canonical URL (whitespace trimmed)", async () => {
      const urlWithWhitespace = "  https://api.example.com/data  ";
      const cleanUrl = "https://api.example.com/data";
      const op = "fetch";
      const contractId = "NET_HTTP_REQUEST";

      // Both should produce the same hash because URL is trimmed
      const opHash8 = computeExpectedOpHash8(op, urlWithWhitespace);
      const expectedHash8 = computeExpectedOpHash8(op, cleanUrl);
      expect(opHash8).toBe(expectedHash8); // Sanity check

      const exactToken = `CONFIRM NETWORK_IO ${contractId} ${opHash8}`;

      // Arrange: Router returns HIGH-risk contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        {
          userText: "fetch data",
          lastUserMessage: exactToken,
        },
        { url: urlWithWhitespace } // URL with whitespace
      );

      // Act: Should succeed because URL is canonicalized (trimmed)
      const result = await wrappedTool.execute("call-1", {}, new AbortController().signal);

      // Assert: Tool was executed
      expect(executeSpy).toHaveBeenCalled();
    });
  });

  describe("opHash8 computation", () => {
    it("produces consistent 8-character hex fingerprint", () => {
      const op = "fetch";
      const url = "https://api.example.com/data";
      const hash = computeExpectedOpHash8(op, url);

      expect(hash).toHaveLength(8);
      expect(hash).toMatch(/^[0-9a-f]{8}$/);

      // Same inputs should produce same hash
      expect(computeExpectedOpHash8(op, url)).toBe(hash);
    });

    it("produces different hashes for different URLs", () => {
      const op = "fetch";
      const hash1 = computeExpectedOpHash8(op, "https://api.example.com/a");
      const hash2 = computeExpectedOpHash8(op, "https://api.example.com/b");

      expect(hash1).not.toBe(hash2);
    });

    it("produces different hashes for different operations", () => {
      const url = "https://api.example.com/data";
      const hash1 = computeExpectedOpHash8("fetch", url);
      const hash2 = computeExpectedOpHash8("post", url);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("capability-denied hard-block (top1 in pack but not in allowedContractIds)", () => {
    it("throws ABSTAIN_CLARIFY with reason capability_denied when contract is in pack but filtered by capabilities", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      // Use a contract that exists in the pack but we'll mock deriveAllowedContracts to exclude it
      const contractId = "NET_FILTERED_OUT";

      // Arrange: Router returns a contract that exists in pack but is NOT in allowedContractIds
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: contractId,
            contract_risk: "HIGH",
            score: 0.95,
          },
        },
      });

      // Override pack mock to include NET_FILTERED_OUT in the pack
      getPackForStageMock.mockReturnValueOnce({
        pack_id: "test-network-pack",
        pack_version: "1.0.0",
        contracts: [
          { contract_id: "NET_HTTP_REQUEST", risk_class: "HIGH", needs_confirmation: false },
          { contract_id: "NET_EXTERNAL_POST", risk_class: "CRITICAL", needs_confirmation: true },
          { contract_id: "NET_FILTERED_OUT", risk_class: "HIGH", needs_confirmation: false }, // In pack
        ],
        field_schema: {
          properties: {
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "FETCH"],
            },
          },
        },
      });

      // Override allowedContracts mock to NOT include NET_FILTERED_OUT (capability filtered)
      deriveAllowedContractsMock.mockReturnValueOnce([
        "NET_HTTP_REQUEST",
        "NET_EXTERNAL_POST",
        // NET_FILTERED_OUT is intentionally excluded - simulating capability filtering
      ]);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        { userText: "fetch data" },
        { url: targetUrl }
      );

      // Act & Assert: Should throw ABSTAIN_CLARIFY with reason capability_denied
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("capability_denied");
        expect(abstainError.contractId).toBe(contractId);
        expect(abstainError.instructions).toContain("NET_FILTERED_OUT");
        expect(abstainError.instructions).toContain("capability");
      }

      // Tool should NOT be executed (hard-block, not fail-open)
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("fails-open only when top1 contract is NOT in pack at all (true mismatch)", async () => {
      const targetUrl = "https://api.example.com/data";
      const op = "fetch";
      // Use a contract that does NOT exist in the pack at all
      const unknownContractId = "COMPLETELY_UNKNOWN_CONTRACT";

      // Arrange: Router returns a contract that does NOT exist in the pack
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: unknownContractId,
            contract_risk: "LOW",
            score: 0.5,
          },
        },
      });

      // Override pack mock - does NOT include COMPLETELY_UNKNOWN_CONTRACT
      getPackForStageMock.mockReturnValueOnce({
        pack_id: "test-network-pack",
        pack_version: "1.0.0",
        contracts: [
          { contract_id: "NET_HTTP_REQUEST", risk_class: "HIGH", needs_confirmation: false },
          { contract_id: "NET_EXTERNAL_POST", risk_class: "CRITICAL", needs_confirmation: true },
          // COMPLETELY_UNKNOWN_CONTRACT is NOT in this pack
        ],
        field_schema: {
          properties: {
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "FETCH"],
            },
          },
        },
      });

      deriveAllowedContractsMock.mockReturnValueOnce([
        "NET_HTTP_REQUEST",
        "NET_EXTERNAL_POST",
      ]);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        { userText: "fetch data" },
        { url: targetUrl }
      );

      // Act: Should fail-open (execute tool) because contract is NOT in pack (true mismatch)
      const result = await wrappedTool.execute("call-1", {}, new AbortController().signal);

      // Assert: Tool WAS executed (fail-open for true mismatch)
      expect(executeSpy).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("does NOT fail-open when contract is in pack but capability-filtered (regression test)", async () => {
      // This test documents the fix: previously, ANY mismatch with allowedContractIds
      // would fail-open. Now, only true mismatches (contract not in pack) fail-open.
      // Capability-filtered contracts must hard-block.

      const targetUrl = "https://api.example.com/sensitive";
      const op = "post";
      const capabilityFilteredContract = "NET_ADMIN_ONLY";

      // Router identifies NET_ADMIN_ONLY as the correct contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: capabilityFilteredContract,
            contract_risk: "CRITICAL",
            score: 0.99,
          },
        },
      });

      // Pack DOES contain NET_ADMIN_ONLY (it's a valid contract)
      getPackForStageMock.mockReturnValueOnce({
        pack_id: "test-network-pack",
        pack_version: "1.0.0",
        contracts: [
          { contract_id: "NET_HTTP_REQUEST", risk_class: "HIGH", needs_confirmation: false },
          { contract_id: "NET_ADMIN_ONLY", risk_class: "CRITICAL", needs_confirmation: true },
        ],
        field_schema: {
          properties: {
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            },
          },
        },
      });

      // But allowedContractIds does NOT include NET_ADMIN_ONLY (user lacks admin capability)
      deriveAllowedContractsMock.mockReturnValueOnce([
        "NET_HTTP_REQUEST",
        // NET_ADMIN_ONLY is filtered out due to missing capability
      ]);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        op,
        { userText: "post to admin endpoint" },
        { url: targetUrl }
      );

      // Act & Assert: MUST throw (hard-block), NOT execute tool (no fail-open)
      await expect(
        wrappedTool.execute("call-1", {}, new AbortController().signal)
      ).rejects.toThrow(ClarityBurstAbstainError);

      // Critical assertion: tool was NOT executed
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });
});
