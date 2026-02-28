import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";

/**
 * REGRESSION TEST: NETWORK_IO allowlist derivation from pack schema
 *
 * This test suite validates that:
 * 1. executeWithNetworkGating() derives ALLOWED_NETWORK_OPS from the pack's field_schema.method.enum
 * 2. If the schema is missing or malformed, FALLBACK_ALLOWED_NETWORK_OPS is used
 * 3. The allowlist check respects the schema enum (add/remove verbs)
 * 4. PACK_POLICY_INCOMPLETE is triggered appropriately
 * 5. The fallback allowlist stays in sync with the pack schema enum (regression guard)
 */

// Mock routeClarityBurst before importing
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (...args: unknown[]) => routeClarityBurstMock(...args),
}));

// Mock getPackForStage to allow schema manipulation
const getPackForStageMock = vi.fn();
vi.mock("../clarityburst/pack-registry.js", () => ({
  getPackForStage: (...args: unknown[]) => getPackForStageMock(...args),
  getAvailableStageIds: () => ["NETWORK_IO", "SHELL_EXEC"],
  getPackCount: () => 2,
}));

// Mock allowed-contracts
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: () => ["NETWORK_GET_PUBLIC", "NETWORK_POST_DATA"],
}));

// Mock decision-override to ALLOW by default
vi.mock("../clarityburst/decision-override.js", () => ({
  applyNetworkOverrides: vi.fn(() => ({
    outcome: "ALLOW",
    reason: "explicit_allow",
    contractId: "NETWORK_GET_PUBLIC",
  })),
  applyFileSystemOverrides: vi.fn(),
  applyShellOverrides: vi.fn(),
}));

import {
  wrapWithNetworkGating,
  FALLBACK_ALLOWED_NETWORK_OPS,
  extractMethodEnumFromPack,
  deriveAllowedNetworkOps,
} from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "../clarityburst/errors.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Create a valid NETWORK_IO pack with customizable method enum
 */
function createMockNetworkPack(methodEnum?: string[] | null) {
  const basePack = {
    pack_id: "openclawd.NETWORK_IO",
    pack_version: "1.0.0",
    stage_id: "NETWORK_IO",
    description: "Test NETWORK_IO pack",
    thresholds: { min_confidence_T: 0.55, dominance_margin_Delta: 0.1 },
    contracts: [
      {
        contract_id: "NETWORK_GET_PUBLIC",
        risk_class: "LOW",
        required_fields: ["url", "method"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
      {
        contract_id: "NETWORK_POST_DATA",
        risk_class: "MEDIUM",
        required_fields: ["url", "method", "body"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
    ],
    field_schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        method:
          methodEnum === null
            ? { type: "string" } // No enum at all
            : methodEnum === undefined
            ? { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] }
            : { type: "string", enum: methodEnum },
      },
      required: ["url"],
    },
  };
  return basePack;
}

/**
 * Create a mock tool for testing
 */
function createMockTool(): { tool: AnyAgentTool; executeSpy: ReturnType<typeof vi.fn> } {
  const executeSpy = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "mock result" }],
    details: { ok: true },
  }));
  return {
    tool: {
      name: "mock_network",
      label: "Mock Network",
      description: "Mock network tool",
      parameters: { type: "object", properties: {} },
      execute: executeSpy,
    },
    executeSpy,
  };
}

describe("NETWORK_IO allowlist derivation from pack schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: router returns valid result
    routeClarityBurstMock.mockResolvedValue({
      ok: true,
      data: { top1: { contract_id: "NETWORK_GET_PUBLIC", score: 0.95 } },
    });
  });

  describe("extractMethodEnumFromPack()", () => {
    it("extracts and lowercases method enum from valid schema", () => {
      const pack = createMockNetworkPack(["GET", "POST", "PUT"]);
      const result = extractMethodEnumFromPack(pack);
      expect(result).toEqual(["get", "post", "put"]);
    });

    it("returns undefined when field_schema is missing", () => {
      const pack = { pack_id: "test", contracts: [], field_schema: undefined };
      const result = extractMethodEnumFromPack(pack as { field_schema?: Record<string, unknown> });
      expect(result).toBeUndefined();
    });

    it("returns undefined when method property is missing", () => {
      const pack = {
        field_schema: { url: { type: "string" } },
      };
      const result = extractMethodEnumFromPack(pack);
      expect(result).toBeUndefined();
    });

    it("returns undefined when method.enum is not an array", () => {
      const pack = {
        field_schema: { method: { type: "string", enum: "GET" } },
      };
      const result = extractMethodEnumFromPack(pack);
      expect(result).toBeUndefined();
    });

    it("returns undefined when method.enum is empty", () => {
      const pack = {
        field_schema: { method: { type: "string", enum: [] } },
      };
      const result = extractMethodEnumFromPack(pack);
      expect(result).toBeUndefined();
    });

    it("returns undefined when enum contains non-strings", () => {
      const pack = {
        field_schema: { method: { type: "string", enum: ["GET", 123, "POST"] } },
      };
      const result = extractMethodEnumFromPack(pack);
      expect(result).toBeUndefined();
    });
  });

  describe("deriveAllowedNetworkOps()", () => {
    it("derives from schema enum when valid", () => {
      const pack = createMockNetworkPack(["GET", "POST", "CUSTOM"]);
      const { allowedOps, usedFallback } = deriveAllowedNetworkOps(pack);
      expect(usedFallback).toBe(false);
      expect(allowedOps).toEqual(new Set(["get", "post", "custom"]));
    });

    it("uses fallback when schema is missing", () => {
      const pack = { pack_id: "test", contracts: [], field_schema: undefined };
      const { allowedOps, usedFallback } = deriveAllowedNetworkOps(pack as { field_schema?: Record<string, unknown> });
      expect(usedFallback).toBe(true);
      expect(allowedOps).toEqual(new Set(FALLBACK_ALLOWED_NETWORK_OPS));
    });

    it("uses fallback when method.enum is null/undefined", () => {
      const pack = createMockNetworkPack(null);
      const { allowedOps, usedFallback } = deriveAllowedNetworkOps(pack);
      expect(usedFallback).toBe(true);
      expect(allowedOps).toEqual(new Set(FALLBACK_ALLOWED_NETWORK_OPS));
    });
  });

  describe("allowlist check respects pack schema enum", () => {
    it("allows verbs in the schema enum", async () => {
      const pack = createMockNetworkPack(["GET", "POST"]);
      getPackForStageMock.mockReturnValue(pack);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "get", { userText: "test" }, { url: "https://example.com" });

      await wrappedTool.execute("call-1", {}, new AbortController().signal);
      expect(executeSpy).toHaveBeenCalled();
    });

    it("blocks verbs NOT in the schema enum", async () => {
      // Pack with only GET and POST - no DELETE
      const pack = createMockNetworkPack(["GET", "POST"]);
      getPackForStageMock.mockReturnValue(pack);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "delete", { userText: "test" }, { url: "https://example.com" });

      await expect(wrappedTool.execute("call-1", {}, new AbortController().signal)).rejects.toThrow(
        ClarityBurstAbstainError
      );

      // Executor should NOT be called
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it("respects dynamically added verbs (e.g., TRACE)", async () => {
      // Pack with TRACE added to enum
      const pack = createMockNetworkPack(["GET", "POST", "TRACE"]);
      getPackForStageMock.mockReturnValue(pack);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "trace", { userText: "test" }, { url: "https://example.com" });

      await wrappedTool.execute("call-1", {}, new AbortController().signal);
      expect(executeSpy).toHaveBeenCalled();
    });

    it("respects dynamically removed verbs (e.g., PATCH removed)", async () => {
      // Pack WITHOUT PATCH in enum
      const pack = createMockNetworkPack(["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"]);
      getPackForStageMock.mockReturnValue(pack);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "patch", { userText: "test" }, { url: "https://example.com" });

      await expect(wrappedTool.execute("call-1", {}, new AbortController().signal)).rejects.toThrow(
        ClarityBurstAbstainError
      );

      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe("fallback behavior when schema is missing", () => {
    it("uses FALLBACK_ALLOWED_NETWORK_OPS when field_schema.method.enum is missing", async () => {
      // Pack with no enum
      const pack = createMockNetworkPack(null);
      getPackForStageMock.mockReturnValue(pack);

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "get", { userText: "test" }, { url: "https://example.com" });

      await wrappedTool.execute("call-1", {}, new AbortController().signal);
      expect(executeSpy).toHaveBeenCalled();
    });

    it("includes fallback note in error message when schema is missing", async () => {
      const pack = createMockNetworkPack(null);
      getPackForStageMock.mockReturnValue(pack);

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "custom", { userText: "test" }, { url: "https://example.com" });

      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.instructions).toContain("using fallback allowlist");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
      }
    });

    it("does NOT include fallback note when schema is present", async () => {
      const pack = createMockNetworkPack(["GET", "POST"]);
      getPackForStageMock.mockReturnValue(pack);

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "delete", { userText: "test" }, { url: "https://example.com" });

      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.instructions).not.toContain("using fallback allowlist");
      }
    });
  });

  describe("REGRESSION: fallback allowlist must match production pack schema", () => {
    /**
     * CRITICAL REGRESSION TEST
     *
     * This test ensures that FALLBACK_ALLOWED_NETWORK_OPS stays in sync with
     * the actual NETWORK_IO.json pack's field_schema.method.enum.
     *
     * If this test fails, it means either:
     * 1. NETWORK_IO.json's method enum was updated but FALLBACK_ALLOWED_NETWORK_OPS wasn't
     * 2. FALLBACK_ALLOWED_NETWORK_OPS was changed without updating the pack
     *
     * Both scenarios indicate a configuration divergence that could lead to
     * inconsistent behavior between runtime derivation and fallback modes.
     */
    it("FALLBACK_ALLOWED_NETWORK_OPS matches real NETWORK_IO pack's method enum", async () => {
      // Load the REAL pack from disk (bypassing mocks) using dynamic import
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const packPath = path.resolve(__dirname, "../../ontology-packs/NETWORK_IO.json");
      const realPackContent = JSON.parse(fs.readFileSync(packPath, "utf-8"));

      // Extract the real enum from the pack
      const realEnum = extractMethodEnumFromPack(realPackContent);

      // ASSERTION: The real pack MUST have a valid method enum
      expect(realEnum).toBeDefined();
      expect(realEnum!.length).toBeGreaterThan(0);

      // Convert both to sorted sets for comparison
      const realEnumSet = new Set(realEnum!.map((v: string) => v.toLowerCase()));
      const fallbackSet = new Set(FALLBACK_ALLOWED_NETWORK_OPS);

      // REGRESSION ASSERTION: Sets must be identical
      const realEnumSorted = [...realEnumSet].sort();
      const fallbackSorted = [...fallbackSet].sort();

      expect(fallbackSorted).toEqual(realEnumSorted);

      // Additional check: exact match - all fallback verbs in real enum
      for (const verb of fallbackSet) {
        expect(realEnumSet.has(verb)).toBe(true);
      }
      // All real enum verbs in fallback (cast to Set<string> to avoid literal type issues)
      const fallbackAsStrings = fallbackSet as Set<string>;
      for (const verb of realEnumSet) {
        expect(fallbackAsStrings.has(verb)).toBe(true);
      }
    });

    it("real NETWORK_IO pack has the expected standard HTTP methods", async () => {
      // Load the REAL pack from disk (bypassing mocks)
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const packPath = path.resolve(__dirname, "../../ontology-packs/NETWORK_IO.json");
      const realPackContent = JSON.parse(fs.readFileSync(packPath, "utf-8"));

      const realEnum = extractMethodEnumFromPack(realPackContent);

      expect(realEnum).toBeDefined();

      // Standard HTTP methods that MUST be present
      const requiredMethods = ["get", "post", "put", "delete", "head", "options"];
      for (const method of requiredMethods) {
        expect(realEnum).toContain(method);
      }
    });
  });

  describe("error message includes sorted allowed verbs", () => {
    it("lists allowed verbs in alphabetical order", async () => {
      const pack = createMockNetworkPack(["POST", "GET", "DELETE"]);
      getPackForStageMock.mockReturnValue(pack);

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(tool, "unknown", { userText: "test" }, { url: "https://example.com" });

      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        const abstainError = err as ClarityBurstAbstainError;
        // Should be alphabetically sorted: delete, get, post
        expect(abstainError.instructions).toContain("delete, get, post");
      }
    });
  });
});
