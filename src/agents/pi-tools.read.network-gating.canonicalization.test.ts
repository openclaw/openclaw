import { describe, expect, it, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

/**
 * Regression test: NETWORK_IO operation canonicalization consistency
 *
 * This test ensures that:
 * 1. routeClarityBurst() receives context.operation === canonicalizeOperation(rawOp)
 * 2. The opHash8 confirmation token uses canonicalizeOperation() exactly
 *
 * If these invariants break, confirmation tokens will fail to match even when
 * the user provides the correct token, or worse, replay attacks could succeed.
 */

// Capture the router call arguments for inspection
let lastRouterCallArgs: unknown = null;

// Mock routeClarityBurst to capture call arguments
const routeClarityBurstMock = vi.fn(async (args: unknown) => {
  lastRouterCallArgs = args;
  return {
    ok: true,
    data: {
      top1: {
        contract_id: "NET_HTTP_REQUEST",
        contract_risk: "HIGH",
        score: 0.95,
      },
    },
  };
});
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (arg: unknown) => routeClarityBurstMock(arg),
}));

// Mock getPackForStage
vi.mock("../clarityburst/pack-registry.js", () => ({
  getPackForStage: () => ({
    pack_id: "test-network-pack",
    pack_version: "1.0.0",
    contracts: [
      { contract_id: "NET_HTTP_REQUEST", risk_class: "HIGH", needs_confirmation: false },
    ],
  }),
}));

// Mock allowed-contracts
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: () => ["NET_HTTP_REQUEST"],
}));

// Mock applyNetworkOverrides to return ABSTAIN_CONFIRM so we can inspect the token
vi.mock("../clarityburst/decision-override.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../clarityburst/decision-override.js")>();
  return {
    ...original,
    applyNetworkOverrides: vi.fn(() => ({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId: "NET_HTTP_REQUEST",
    })),
  };
});

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { canonicalizeOperation, canonicalizeUrl } from "../clarityburst/canonicalize.js";
import { ClarityBurstAbstainError } from "../clarityburst/errors.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Compute the expected opHash8 using the shared canonicalization utilities.
 * This mirrors the internal computeNetworkOpHash8() implementation.
 */
function computeExpectedOpHash8(operation: string, url: string): string {
  const canonicalOp = canonicalizeOperation(operation);
  const canonicalUrl = canonicalizeUrl(url);
  const basis = `${canonicalOp}:${canonicalUrl}`;
  return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 8);
}

describe("NETWORK_IO canonicalizeOperation() consistency", () => {
  const createMockTool = (): AnyAgentTool => ({
    name: "mock_network",
    label: "Mock Network",
    description: "Mock network tool",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "mock result" }],
      details: { ok: true },
    })),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    lastRouterCallArgs = null;
  });

  describe("router context uses canonicalizeOperation()", () => {
    it("passes canonicalized operation to routeClarityBurst context (uppercase input)", async () => {
      const rawOp = "GET";
      const targetUrl = "https://api.example.com/data";

      const tool = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        rawOp,
        { userText: "get data" },
        { url: targetUrl }
      );

      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
      } catch {
        // Expected ABSTAIN_CONFIRM
      }

      // REGRESSION ASSERTION: router context.operation MUST equal canonicalizeOperation(rawOp)
      expect(lastRouterCallArgs).toBeDefined();
      const args = lastRouterCallArgs as { context: { operation: string } };
      expect(args.context.operation).toBe(canonicalizeOperation(rawOp));
      expect(args.context.operation).toBe("get"); // lowercase
    });

    it("passes canonicalized operation to routeClarityBurst context (mixed case with whitespace)", async () => {
      const rawOp = "  PoSt  ";
      const targetUrl = "https://api.example.com/submit";

      const tool = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        rawOp,
        { userText: "post data" },
        { url: targetUrl }
      );

      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
      } catch {
        // Expected ABSTAIN_CONFIRM
      }

      // REGRESSION ASSERTION: router context.operation MUST equal canonicalizeOperation(rawOp)
      expect(lastRouterCallArgs).toBeDefined();
      const args = lastRouterCallArgs as { context: { operation: string } };
      expect(args.context.operation).toBe(canonicalizeOperation(rawOp));
      expect(args.context.operation).toBe("post"); // trimmed and lowercase
    });
  });

  describe("opHash8 confirmation token uses canonicalizeOperation()", () => {
    it("ABSTAIN_CONFIRM token contains opHash8 matching canonicalizeOperation() output", async () => {
      const rawOp = "DELETE";
      const targetUrl = "https://api.example.com/resource/123";
      const contractId = "NET_HTTP_REQUEST";

      const tool = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        rawOp,
        { userText: "delete resource" },
        { url: targetUrl }
      );

      // REGRESSION ASSERTION: the opHash8 in the confirmation token MUST be computed
      // using canonicalizeOperation(), not the raw operation string
      const expectedOpHash8 = computeExpectedOpHash8(rawOp, targetUrl);
      const expectedToken = `CONFIRM NETWORK_IO ${contractId} ${expectedOpHash8}`;

      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;

        // The token in instructions MUST match our expected token computed with canonicalizeOperation()
        expect(abstainError.instructions).toBe(expectedToken);
      }
    });

    it("same raw operation with different casing produces identical opHash8", async () => {
      // This ensures canonicalization is applied consistently
      const url = "https://api.example.com/data";

      const hash1 = computeExpectedOpHash8("GET", url);
      const hash2 = computeExpectedOpHash8("get", url);
      const hash3 = computeExpectedOpHash8("  GeT  ", url);

      // All variations MUST produce the same hash after canonicalization
      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it("different operations produce different opHash8 values", async () => {
      const url = "https://api.example.com/data";

      const getHash = computeExpectedOpHash8("GET", url);
      const postHash = computeExpectedOpHash8("POST", url);
      const deleteHash = computeExpectedOpHash8("DELETE", url);

      expect(getHash).not.toBe(postHash);
      expect(postHash).not.toBe(deleteHash);
      expect(getHash).not.toBe(deleteHash);
    });
  });

  describe("canonicalizeOperation() single source of truth", () => {
    it("canonicalizeOperation() trims whitespace", () => {
      expect(canonicalizeOperation("  get  ")).toBe("get");
      expect(canonicalizeOperation("\tpost\n")).toBe("post");
    });

    it("canonicalizeOperation() converts to lowercase", () => {
      expect(canonicalizeOperation("GET")).toBe("get");
      expect(canonicalizeOperation("POST")).toBe("post");
      expect(canonicalizeOperation("DeLeTe")).toBe("delete");
    });

    it("canonicalizeOperation() handles both trim and lowercase", () => {
      expect(canonicalizeOperation("  GET  ")).toBe("get");
      expect(canonicalizeOperation("\t POST \n")).toBe("post");
    });
  });
});
