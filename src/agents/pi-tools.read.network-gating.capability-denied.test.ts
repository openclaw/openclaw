import { describe, expect, it, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION TEST: wrapWithNetworkGating() capability_denied hard-block
// ─────────────────────────────────────────────────────────────────────────────
// This test validates that:
// 1. routeClarityBurst() receives allowedContractIds (capability-filtered) for NETWORK_IO
// 2. If router returns top1 in pack BUT NOT in allowedContractIds → hard-block with capability_denied
// 3. If router returns top1 NOT in pack at all → fail-open (executor called)
// 4. routeClarityBurst() context contains canonicalized operation and url (trimmed)
//    that exactly match the inputs used to compute opHash8
// ─────────────────────────────────────────────────────────────────────────────

// Mock routeClarityBurst before importing the module under test
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (...args: unknown[]) => routeClarityBurstMock(...args),
}));

// Use the real pack-registry and allowed-contracts for accurate capability derivation
// This ensures we test the actual capability-filtering logic

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { canonicalizeUrl } from "../clarityburst/canonicalize.js";
import { ClarityBurstAbstainError } from "../clarityburst/errors.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { getPackForStage } from "../clarityburst/pack-registry.js";
import {
  createFullCapabilities,
  deriveAllowedContracts,
} from "../clarityburst/allowed-contracts.js";

describe("wrapWithNetworkGating capability_denied regression", () => {
  // Create a mock tool that should never be executed when capability-denied blocks
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

  describe("allowedContractIds derivation and router invocation", () => {
    it("sends capability-filtered allowedContractIds to routeClarityBurst() for NETWORK_IO", async () => {
      // Arrange: Get the real pack and derive expected allowedContractIds
      const networkPack = getPackForStage("NETWORK_IO");
      const caps = createFullCapabilities(); // explicitlyAllowCritical: false by default
      const expectedAllowedContractIds = deriveAllowedContracts("NETWORK_IO", networkPack, caps);

      // Verify our test setup: CRITICAL + deny_by_default contracts should be filtered out
      expect(expectedAllowedContractIds).not.toContain("NETWORK_RAW_SOCKET");
      expect(expectedAllowedContractIds).not.toContain("NETWORK_PROXY_TUNNEL");
      // But other contracts should be present
      expect(expectedAllowedContractIds).toContain("NETWORK_GET_PUBLIC");

      // Mock router to return ok:true with a valid allowed contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "NETWORK_GET_PUBLIC", score: 0.95 },
          top2: { contract_id: "NETWORK_DNS_LOOKUP", score: 0.8 },
        },
      });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch https://api.example.com/data" },
        { url: "https://api.example.com/data" }
      );

      // Act
      try {
        await wrappedTool.execute("call-1", {}, new AbortController().signal);
      } catch {
        // May throw due to override checks, but we only care about the router call
      }

      // Assert: routeClarityBurst was called with expected allowedContractIds
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
      const routerCallArgs = routeClarityBurstMock.mock.calls[0][0];

      // Verify stageId
      expect(routerCallArgs.stageId).toBe("NETWORK_IO");

      // Verify allowedContractIds matches the capability-derived set
      expect(routerCallArgs.allowedContractIds).toEqual(expectedAllowedContractIds);

      // Verify packId and packVersion match the real pack
      expect(routerCallArgs.packId).toBe(networkPack.pack_id);
      expect(routerCallArgs.packVersion).toBe(networkPack.pack_version);
    });
  });

  describe("capability_denied hard-block (top1 in pack but NOT in allowedContractIds)", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │  INVARIANT: Capability-denied contracts must NEVER execute                 │
     * ├────────────────────────────────────────────────────────────────────────────┤
     * │  When the router returns a top1 contract that exists in the pack but is    │
     * │  filtered out by capability derivation (e.g., CRITICAL + deny_by_default   │
     * │  without explicitlyAllowCritical), the wrapper MUST hard-block with:       │
     * │    - reason: "capability_denied"                                           │
     * │    - outcome: "ABSTAIN_CLARIFY"                                            │
     * │    - No tool execution (executeSpy.callCount === 0)                        │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("throws ClarityBurstAbstainError with reason:capability_denied when top1 is in pack but not in allowedContractIds", async () => {
      // Arrange: NETWORK_RAW_SOCKET is CRITICAL + deny_by_default in NETWORK_IO pack
      // With default capabilities (explicitlyAllowCritical: false), it's filtered out
      const inPackButNotAllowed = "NETWORK_RAW_SOCKET";

      // Verify test precondition: contract exists in pack
      const networkPack = getPackForStage("NETWORK_IO");
      const packContractIds = networkPack.contracts.map((c) => c.contract_id);
      expect(packContractIds).toContain(inPackButNotAllowed);

      // Verify test precondition: contract is NOT in allowedContractIds with default caps
      const caps = createFullCapabilities();
      const allowedContractIds = deriveAllowedContracts("NETWORK_IO", networkPack, caps);
      expect(allowedContractIds).not.toContain(inPackButNotAllowed);

      // Mock router to return the in-pack-but-not-allowed contract with strong scores
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: inPackButNotAllowed, score: 0.99 },
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.75 },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "connect raw socket to internal host" },
        { url: "tcp://internal.corp:22" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("capability-denied-test", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded despite capability_denied");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: ClarityBurstAbstainError with exact fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("capability_denied");
      expect(caughtError!.contractId).toBe(inPackButNotAllowed);

      // Assert: executeSpy call count is 0 - tool was NOT executed
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("includes contract ID and capability guidance in error instructions", async () => {
      // Arrange: Use NETWORK_PROXY_TUNNEL (another CRITICAL + deny_by_default contract)
      const inPackButNotAllowed = "NETWORK_PROXY_TUNNEL";

      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: inPackButNotAllowed, score: 0.92 },
          top2: { contract_id: "NETWORK_POST_DATA", score: 0.65 },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "POST",
        { userText: "tunnel traffic through proxy" },
        { url: "https://proxy.corp/tunnel" }
      );

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("capability-denied-instructions", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: Error includes contract ID and capability guidance
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.instructions).toContain(inPackButNotAllowed);
      expect(caughtError!.instructions).toContain("capability");
      expect(caughtError!.instructions).toContain("NETWORK_IO");

      // Assert: No tool execution
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("hard-blocks even with very high router confidence scores", async () => {
      // Arrange: Router returns perfect scores for a capability-denied contract
      const inPackButNotAllowed = "NETWORK_RAW_SOCKET";

      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: inPackButNotAllowed, score: 1.0 }, // Perfect score
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.1 },  // Very low dominance margin
        },
      });

      const { tool, executeSpy } = createMockTool();
      // NOTE: Use a valid operation verb (GET) to pass the allowlist check and reach
      // the capability_denied check. The test verifies that even with perfect router
      // confidence, the capability-denied contract is still hard-blocked.
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "establish raw socket connection" },
        { url: "tcp://192.168.1.1:8080" }
      );

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("high-confidence-denied", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: Still hard-blocked despite perfect router confidence
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.reason).toBe("capability_denied");
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe("fail-open on true mismatch (top1 NOT in pack at all)", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │  ALTERNATIVE CASE: True router mismatch → fail-open                        │
     * ├────────────────────────────────────────────────────────────────────────────┤
     * │  When the router returns a top1 contract that does NOT exist in the pack   │
     * │  at all (router misconfiguration or stale data), the wrapper should:       │
     * │    - NOT throw capability_denied                                           │
     * │    - Proceed with tool execution (fail-open behavior)                      │
     * │    - executeSpy.callCount === 1                                            │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("executes tool when top1 contract is NOT in pack (true mismatch fail-open)", async () => {
      // Arrange: Router returns a contract_id that doesn't exist in NETWORK_IO pack
      const notInPack = "NONEXISTENT_CONTRACT_XYZ";

      // Verify test precondition: contract does NOT exist in pack
      const networkPack = getPackForStage("NETWORK_IO");
      const packContractIds = networkPack.contracts.map((c) => c.contract_id);
      expect(packContractIds).not.toContain(notInPack);

      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: notInPack, score: 0.88 },
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.70 },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        "GET",
        { userText: "fetch some data" },
        { url: "https://api.example.com/data" }
      );

      // Act
      const result = await wrappedTool.execute("mismatch-test", {}, new AbortController().signal);

      // Assert: Tool was executed (fail-open on true mismatch)
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(result).toBeDefined();
    });

    it("distinguishes true mismatch (fail-open) from capability-denied (hard-block)", async () => {
      // This test runs both scenarios to prove the distinction

      // Scenario A: True mismatch (not in pack) → fail-open
      const notInPack = "COMPLETELY_FAKE_CONTRACT";
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: notInPack, score: 0.90 },
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.80 },
        },
      });

      const { tool: toolA, executeSpy: execSpyA } = createMockTool();
      const wrappedA = wrapWithNetworkGating(
        toolA,
        "GET",
        { userText: "scenario A" },
        { url: "https://example.com/a" }
      );

      // Should NOT throw - fail-open
      await wrappedA.execute("scenario-a", {}, new AbortController().signal);
      expect(execSpyA).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      // Scenario B: In pack but not allowed → capability_denied hard-block
      const inPackButNotAllowed = "NETWORK_RAW_SOCKET";
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: inPackButNotAllowed, score: 0.90 },
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.80 },
        },
      });

      const { tool: toolB, executeSpy: execSpyB } = createMockTool();
      const wrappedB = wrapWithNetworkGating(
        toolB,
        "GET",
        { userText: "scenario B" },
        { url: "https://example.com/b" }
      );

      // Should throw capability_denied
      let threwB = false;
      try {
        await wrappedB.execute("scenario-b", {}, new AbortController().signal);
      } catch (err) {
        threwB = true;
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as ClarityBurstAbstainError).reason).toBe("capability_denied");
      }

      expect(threwB).toBe(true);
      expect(execSpyB).toHaveBeenCalledTimes(0);
    });
  });

  describe("allowlist-based operation classifier (default-deny unknown ops)", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │  INVARIANT: Unknown operation verbs are hard-blocked BEFORE routing       │
     * ├────────────────────────────────────────────────────────────────────────────┤
     * │  When the operation verb is not in ALLOWED_NETWORK_OPS, the wrapper MUST  │
     * │  hard-block with:                                                         │
     * │    - reason: "PACK_POLICY_INCOMPLETE"                                     │
     * │    - outcome: "ABSTAIN_CLARIFY"                                           │
     * │    - routeClarityBurst NEVER called (routerMock.callCount === 0)          │
     * │    - executeSpy NEVER called (executeSpy.callCount === 0)                 │
     * │                                                                            │
     * │  ALLOWED_NETWORK_OPS is restricted to verbs defined in the NETWORK_IO     │
     * │  ontology pack's field_schema.method enum:                                │
     * │    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]           │
     * │                                                                            │
     * │  Speculative verbs removed (not in ontology): connect, listen, fetch      │
     * │  Exotic verbs always blocked: tunnel, raw_socket                          │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("hard-blocks unknown operation verb 'tunnel' before calling router", async () => {
      // Arrange: Use an exotic/unsupported operation verb
      const unknownOp = "tunnel";

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        unknownOp,
        { userText: "tunnel traffic through proxy" },
        { url: "tcp://proxy.internal:8080" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("unknown-op-tunnel", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded with unknown operation verb");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: ClarityBurstAbstainError with exact fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();

      // Assert: Instructions mention the unsupported verb and list allowed verbs
      expect(caughtError!.instructions).toContain("tunnel");
      expect(caughtError!.instructions).toContain("not recognized");
      expect(caughtError!.instructions).toContain("get");
      expect(caughtError!.instructions).toContain("post");

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Tool executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("hard-blocks unknown operation verb 'raw_socket' before calling router", async () => {
      // Arrange: Another exotic/unsupported operation verb
      const unknownOp = "raw_socket";

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        unknownOp,
        { userText: "open raw socket connection" },
        { url: "tcp://192.168.1.1:22" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("unknown-op-raw-socket", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded with unknown operation verb");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: ClarityBurstAbstainError with exact fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();

      // Assert: Instructions mention the unsupported verb
      expect(caughtError!.instructions).toContain("raw_socket");

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Tool executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("hard-blocks removed speculative verb 'connect' before calling router", async () => {
      // Arrange: 'connect' was speculatively added but is not in the NETWORK_IO ontology
      const removedOp = "connect";

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        removedOp,
        { userText: "connect to WebSocket endpoint" },
        { url: "wss://example.com/socket" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("removed-op-connect", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded with removed operation verb 'connect'");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: ClarityBurstAbstainError with exact fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();

      // Assert: Instructions mention the unsupported verb
      expect(caughtError!.instructions).toContain("connect");
      expect(caughtError!.instructions).toContain("not recognized");

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Tool executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("hard-blocks removed speculative verb 'listen' before calling router", async () => {
      // Arrange: 'listen' was speculatively added for server-side bind but is not in the ontology
      const removedOp = "listen";

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        removedOp,
        { userText: "listen on port 8080" },
        { url: "tcp://0.0.0.0:8080" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("removed-op-listen", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded with removed operation verb 'listen'");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: ClarityBurstAbstainError with exact fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();

      // Assert: Instructions mention the unsupported verb
      expect(caughtError!.instructions).toContain("listen");
      expect(caughtError!.instructions).toContain("not recognized");

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Tool executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("hard-blocks removed speculative verb 'fetch' before calling router", async () => {
      // Arrange: 'fetch' was speculatively added as a generic operation but is not in the ontology
      // (the ontology uses specific HTTP verbs like GET, POST, etc.)
      const removedOp = "fetch";

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        removedOp,
        { userText: "fetch data from API" },
        { url: "https://api.example.com/data" }
      );

      // Act & Assert
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("removed-op-fetch", {}, new AbortController().signal);
        throw new Error("INVARIANT VIOLATION: Tool execution proceeded with removed operation verb 'fetch'");
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: ClarityBurstAbstainError with exact fields
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.stageId).toBe("NETWORK_IO");
      expect(caughtError!.outcome).toBe("ABSTAIN_CLARIFY");
      expect(caughtError!.reason).toBe("PACK_POLICY_INCOMPLETE");
      expect(caughtError!.contractId).toBeNull();

      // Assert: Instructions mention the unsupported verb
      expect(caughtError!.instructions).toContain("fetch");
      expect(caughtError!.instructions).toContain("not recognized");

      // Assert: Router was NEVER called - blocked before routing
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Tool executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("allows known operation verb 'get' to proceed to routing", async () => {
      // Arrange: Use a known/allowed operation verb
      const knownOp = "get";

      // Mock router to return a valid allowed contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "NETWORK_GET_PUBLIC", score: 0.95 },
          top2: { contract_id: "NETWORK_DNS_LOOKUP", score: 0.8 },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        knownOp,
        { userText: "fetch public API" },
        { url: "https://api.example.com/data" }
      );

      // Act - may throw due to override checks, but router should be called
      try {
        await wrappedTool.execute("known-op-get", {}, new AbortController().signal);
      } catch {
        // May throw due to other gating checks, that's fine
      }

      // Assert: Router WAS called - not blocked by allowlist
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
    });

    it("normalizes operation verb case before allowlist check", async () => {
      // Arrange: Use uppercase version of allowed verb
      const uppercaseOp = "POST";

      // Mock router to return a valid allowed contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "NETWORK_POST_DATA", score: 0.90 },
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.75 },
        },
      });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        uppercaseOp,
        { userText: "post data to API" },
        { url: "https://api.example.com/submit" }
      );

      // Act - may throw due to override checks, but router should be called
      try {
        await wrappedTool.execute("uppercase-op-post", {}, new AbortController().signal);
      } catch {
        // May throw due to other gating checks, that's fine
      }

      // Assert: Router WAS called - uppercase was normalized to lowercase
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("canonicalized inputs regression (operation + url fingerprinting)", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │  INVARIANT: routeClarityBurst() context uses exact same canonicalized      │
     * │             inputs that are used to compute opHash8                        │
     * ├────────────────────────────────────────────────────────────────────────────┤
     * │  The router decision MUST be bound to the same fingerprinted inputs used   │
     * │  to compute the confirmation token. If the router sees different inputs    │
     * │  than opHash8 computation, an attacker could:                              │
     * │    1. Craft whitespace-padded inputs to get a benign router classification │
     * │    2. Use trimmed inputs for opHash8 to bypass confirmation                │
     * │                                                                            │
     * │  This test ensures:                                                        │
     * │    - context.operation === operation.trim().toLowerCase()                  │
     * │    - context.url === url.trim() (canonicalizeUrl)                          │
     * │    - opHash8 is computed from same canonicalized values                    │
     * └────────────────────────────────────────────────────────────────────────────┘
     */

    /**
     * Helper to compute opHash8 the same way as the implementation.
     * Uses the exported canonicalizeUrl() to ensure single source of truth.
     */
    function computeExpectedOpHash8(operation: string, url: string): string {
      const canonicalOp = operation.trim().toLowerCase();
      const canonicalUrl = canonicalizeUrl(url);
      const basis = `${canonicalOp}:${canonicalUrl}`;
      return crypto.createHash("sha256").update(basis).digest("hex").slice(0, 8);
    }

    it("passes canonicalized operation and url to routeClarityBurst() context", async () => {
      // Arrange: Use inputs with leading/trailing whitespace
      const rawOperation = "  GET  ";
      const rawUrl = "  https://api.example.com/data  ";

      // Expected canonicalized values using the single source of truth
      const expectedOp = rawOperation.trim().toLowerCase();
      const expectedUrl = canonicalizeUrl(rawUrl);

      // Mock router to return a valid allowed contract
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "NETWORK_GET_PUBLIC", score: 0.95 },
          top2: { contract_id: "NETWORK_DNS_LOOKUP", score: 0.8 },
        },
      });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        rawOperation,
        { userText: "fetch data from API" },
        { url: rawUrl }
      );

      // Act
      try {
        await wrappedTool.execute("canonicalize-test", {}, new AbortController().signal);
      } catch {
        // May throw due to override checks, but we only care about the router call args
      }

      // Assert: routeClarityBurst was called with canonicalized context
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
      const routerCallArgs = routeClarityBurstMock.mock.calls[0][0];

      // REGRESSION: Verify context.url uses canonicalizeUrl() as single source of truth
      expect(routerCallArgs.context).toBeDefined();
      expect(routerCallArgs.context.operation).toBe(expectedOp);
      expect(routerCallArgs.context.url).toBe(expectedUrl);
      // This assertion will fail if router context diverges from canonicalizeUrl()
      expect(routerCallArgs.context.url).toBe(canonicalizeUrl(rawUrl));
    });

    it("ensures opHash8 in confirmation token matches canonicalized inputs", async () => {
      // Arrange: Use inputs with significant whitespace that would produce different hashes
      const rawOperation = "\t  GET \n";
      const rawUrl = "   https://api.example.com/auth   ";

      // Compute expected opHash8 from canonicalized inputs
      const expectedOpHash8 = computeExpectedOpHash8(rawOperation, rawUrl);

      // Mock router to return a HIGH risk contract that requires confirmation
      // NETWORK_AUTHENTICATED_REQUEST is defined in NETWORK_IO pack with:
      // - risk_class: "HIGH"
      // - needs_confirmation: true
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "NETWORK_AUTHENTICATED_REQUEST", score: 0.95 },
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.7 },
        },
      });

      const { tool, executeSpy } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        rawOperation,
        { userText: "submit data to API" },
        { url: rawUrl }
      );

      // Act: Execute expecting ABSTAIN_CONFIRM due to HIGH risk
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("ophash-test", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: Should get ABSTAIN_CONFIRM with confirmation token
      // The confirmation token contains opHash8 which must match canonicalized inputs
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect(caughtError!.outcome).toBe("ABSTAIN_CONFIRM");

      // Extract opHash8 from the instructions (format: CONFIRM NETWORK_IO <CONTRACT_ID> <opHash8>)
      const instructions = caughtError!.instructions;
      const tokenMatch = instructions.match(/CONFIRM NETWORK_IO (\S+) ([a-f0-9]{8})/);
      expect(tokenMatch).not.toBeNull();

      const actualOpHash8 = tokenMatch![2];
      expect(actualOpHash8).toBe(expectedOpHash8);

      // Verify tool was NOT executed
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("router context and opHash8 use identical inputs (consistency check)", async () => {
      // Arrange: Extreme whitespace case
      const rawOperation = "   get   ";
      const rawUrl = "\n\t  https://internal.example.com/api  \r\n";

      const expectedOp = "get";
      const expectedUrl = "https://internal.example.com/api";
      const expectedOpHash8 = computeExpectedOpHash8(rawOperation, rawUrl);

      // Mock router to return a HIGH risk contract that requires confirmation
      // NETWORK_INTERNAL_ENDPOINT is defined in NETWORK_IO pack with:
      // - risk_class: "HIGH"
      // - needs_confirmation: true
      routeClarityBurstMock.mockResolvedValue({
        ok: true,
        data: {
          top1: { contract_id: "NETWORK_INTERNAL_ENDPOINT", score: 0.92 },
          top2: { contract_id: "NETWORK_GET_PUBLIC", score: 0.5 },
        },
      });

      const { tool } = createMockTool();
      const wrappedTool = wrapWithNetworkGating(
        tool,
        rawOperation,
        { userText: "delete resource" },
        { url: rawUrl }
      );

      // Act
      let caughtError: ClarityBurstAbstainError | null = null;
      try {
        await wrappedTool.execute("consistency-test", {}, new AbortController().signal);
      } catch (err) {
        caughtError = err as ClarityBurstAbstainError;
      }

      // Assert: Router received canonicalized context
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
      const routerCallArgs = routeClarityBurstMock.mock.calls[0][0];
      expect(routerCallArgs.context.operation).toBe(expectedOp);
      expect(routerCallArgs.context.url).toBe(expectedUrl);

      // Assert: opHash8 in confirmation token matches expected
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      const instructions = caughtError!.instructions;
      const tokenMatch = instructions.match(/CONFIRM NETWORK_IO (\S+) ([a-f0-9]{8})/);
      expect(tokenMatch).not.toBeNull();
      expect(tokenMatch![2]).toBe(expectedOpHash8);

      // CRITICAL: Verify router context and opHash8 would produce same hash
      // by computing hash from router context values
      const routerContextHash = crypto
        .createHash("sha256")
        .update(`${routerCallArgs.context.operation}:${routerCallArgs.context.url}`)
        .digest("hex")
        .slice(0, 8);
      expect(routerContextHash).toBe(expectedOpHash8);
    });

    it("non-trimmed raw inputs would produce different opHash8 (proving canonicalization matters)", () => {
      // This test proves WHY canonicalization is important by showing hash divergence
      const rawOp = "  GET  ";
      const rawUrl = "  https://example.com  ";

      // Hash with raw inputs (incorrect - would allow bypass)
      const rawBasis = `${rawOp}:${rawUrl}`;
      const rawHash = crypto.createHash("sha256").update(rawBasis).digest("hex").slice(0, 8);

      // Hash with canonicalized inputs (correct) - uses canonicalizeUrl() for URL
      const canonicalBasis = `${rawOp.trim().toLowerCase()}:${canonicalizeUrl(rawUrl)}`;
      const canonicalHash = crypto.createHash("sha256").update(canonicalBasis).digest("hex").slice(0, 8);

      // The hashes MUST be different - if they were the same, canonicalization wouldn't matter
      expect(rawHash).not.toBe(canonicalHash);

      // Verify our helper produces the canonical hash
      const helperHash = computeExpectedOpHash8(rawOp, rawUrl);
      expect(helperHash).toBe(canonicalHash);
    });

    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │  REGRESSION TEST: routeClarityBurst().context.url === canonicalizeUrl()   │
     * ├────────────────────────────────────────────────────────────────────────────┤
     * │  This test ensures the router context URL uses canonicalizeUrl() as the   │
     * │  single source of truth. If the implementation diverges (e.g., uses raw   │
     * │  url.trim() instead), this test will fail.                                 │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("REGRESSION: router context URL must equal canonicalizeUrl(rawUrl)", async () => {
      // Arrange: Various edge-case URLs that might differ if canonicalization diverges
      const testCases = [
        "  https://api.example.com  ",           // leading/trailing spaces
        "\thttps://api.example.com\t",           // tabs
        "\nhttps://api.example.com\n",           // newlines
        "  \t\n  https://api.example.com \n\t ", // mixed whitespace
        "https://api.example.com",               // no whitespace (control)
      ];

      for (const rawUrl of testCases) {
        routeClarityBurstMock.mockClear();
        routeClarityBurstMock.mockResolvedValue({
          ok: true,
          data: {
            top1: { contract_id: "NETWORK_GET_PUBLIC", score: 0.95 },
            top2: { contract_id: "NETWORK_DNS_LOOKUP", score: 0.8 },
          },
        });

        const { tool } = createMockTool();
        // Use "get" which is in the allowed operation verbs list
        const wrappedTool = wrapWithNetworkGating(
          tool,
          "get",
          { userText: "test canonicalization regression" },
          { url: rawUrl }
        );

        try {
          await wrappedTool.execute("regression-test", {}, new AbortController().signal);
        } catch {
          // May throw, we only care about the router call
        }

        expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);
        const routerCallArgs = routeClarityBurstMock.mock.calls[0][0];

        // CRITICAL ASSERTION: router context.url MUST equal canonicalizeUrl(rawUrl)
        // This will fail if implementation uses different canonicalization logic
        expect(routerCallArgs.context.url).toBe(canonicalizeUrl(rawUrl));
      }
    });
  });
});
