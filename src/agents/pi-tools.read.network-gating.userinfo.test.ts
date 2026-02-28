import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

/**
 * Credential-in-URL (userinfo) hard-block regression tests for NETWORK_IO gating.
 *
 * These tests verify that executeWithNetworkGating() hard-blocks URLs containing
 * userinfo (embedded credentials) BEFORE calling routeClarityBurst() or the executor.
 *
 * Test cases:
 * - http://user@host/path → ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE (blocked)
 * - http://user:pass@host/path → ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE (blocked)
 * - https://host/path → allowed (control - no userinfo)
 *
 * Assert: router/executor never called on blocked cases.
 */

// Spy on routeClarityBurst to verify it's NOT called for blocked URLs
const routeClarityBurstMock = vi.fn();
vi.mock("../clarityburst/router-client.js", () => ({
  routeClarityBurst: (args: unknown) => routeClarityBurstMock(args),
}));

// Spy on getPackForStage
const getPackForStageMock = vi.fn().mockReturnValue({
  pack_id: "test-network-pack",
  pack_version: "1.0.0",
  contracts: [
    {
      contract_id: "NET_HTTP_REQUEST",
      risk_class: "LOW",
      needs_confirmation: false,
    },
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
vi.mock("../clarityburst/pack-registry.js", () => ({
  getPackForStage: (stageId: string) => getPackForStageMock(stageId),
}));

// Spy on deriveAllowedContracts
const deriveAllowedContractsMock = vi.fn().mockReturnValue(["NET_HTTP_REQUEST"]);
vi.mock("../clarityburst/allowed-contracts.js", () => ({
  createFullCapabilities: () => ({}),
  deriveAllowedContracts: (stageId: string, pack: unknown, caps: unknown) =>
    deriveAllowedContractsMock(stageId, pack, caps),
}));

// Spy on applyNetworkOverrides
const applyNetworkOverridesMock = vi.fn().mockReturnValue({
  outcome: "PROCEED",
  contractId: "NET_HTTP_REQUEST",
});
vi.mock("../clarityburst/decision-override.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../clarityburst/decision-override.js")>();
  return {
    ...original,
    applyNetworkOverrides: (pack: unknown, routerResult: unknown, context: unknown) =>
      applyNetworkOverridesMock(pack, routerResult, context),
  };
});

import { wrapWithNetworkGating } from "./pi-tools.read.js";
import { ClarityBurstAbstainError } from "./bash-tools.exec.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

// Type alias for the executor function signature
type ExecutorFn = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>
) => Promise<AgentToolResult<unknown>>;

/**
 * Creates a mock network tool for testing.
 * Returns the tool and a spy on the original execute function.
 */
function createMockNetworkTool(): { tool: AnyAgentTool; executeSpy: ExecutorFn & ReturnType<typeof vi.fn> } {
  const executeSpy = vi.fn().mockResolvedValue({
    isError: false,
    content: [{ type: "text" as const, text: "Network operation succeeded" }],
  }) as ExecutorFn & ReturnType<typeof vi.fn>;

  const tool: AnyAgentTool = {
    name: "network_fetch",
    label: "Network Fetch",
    description: "Fetches data from a URL",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
    execute: executeSpy,
  };

  return { tool, executeSpy };
}

describe("NETWORK_IO credential-in-URL (userinfo) hard-block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Configure router to return a successful LOW-risk contract match
    routeClarityBurstMock.mockResolvedValue({
      ok: true,
      data: {
        top1: {
          contract_id: "NET_HTTP_REQUEST",
          confidence: 0.95,
          dominance: 0.85,
          contract_risk: "LOW",
          needs_confirmation: false,
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("blocked URLs with userinfo (hard-block before routing)", () => {
    it("blocks http://user@host/path with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://user@example.com/path" });

      // Act & Assert
      try {
        await tool.execute("call-user-only", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
        expect(abstainError.instructions).toContain("credentials");
        expect(abstainError.instructions).toContain("userinfo");
      }

      // Assert: Router was NEVER called (blocked before routing)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks http://user:pass@host/path with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://user:pass@example.com/path" });

      // Act & Assert
      try {
        await tool.execute("call-user-pass", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
        expect(abstainError.instructions).toContain("credentials");
        expect(abstainError.instructions).toContain("userinfo");
      }

      // Assert: Router was NEVER called (blocked before routing)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks https://user:password@host/path with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "post", {}, { url: "https://admin:secret123@api.example.com/admin" });

      // Act & Assert
      try {
        await tool.execute("call-https-userinfo", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
      }

      // Assert: Router was NEVER called (blocked before routing)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks URL with empty password (user:@host)", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://user:@example.com/path" });

      // Act & Assert
      try {
        await tool.execute("call-empty-pass", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
      }

      // Assert: Router was NEVER called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks URL with userinfo without path (http://user:pass@host)", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://user:pass@example.com" });

      // Act & Assert
      try {
        await tool.execute("call-no-path", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
      }

      // Assert: Router was NEVER called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks URL with port and userinfo (http://user:pass@host:8080/path)", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://user:pass@example.com:8080/api/v1" });

      // Act & Assert
      try {
        await tool.execute("call-port-userinfo", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
      }

      // Assert: Router was NEVER called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks URL with URL-encoded credentials", async () => {
      // Arrange: URL-encoded credentials (user%40domain:p%40ss@host)
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://user%40domain:p%40ss@example.com/path" });

      // Act & Assert
      try {
        await tool.execute("call-encoded-creds", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
      }

      // Assert: Router was NEVER called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe("allowed URLs without userinfo (proceed to routing)", () => {
    it("allows https://host/path (control - no userinfo)", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "https://example.com/path" });

      // Act
      await tool.execute("call-no-userinfo", {}, new AbortController().signal);

      // Assert: Router WAS called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called (after router approved)
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows http://host/path (no userinfo)", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://example.com/api/data" });

      // Act
      await tool.execute("call-http-no-userinfo", {}, new AbortController().signal);

      // Assert: Router WAS called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows URL with @ in path (not in authority)", async () => {
      // Arrange: @ in path is NOT userinfo
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "https://example.com/users/@username/profile" });

      // Act
      await tool.execute("call-at-in-path", {}, new AbortController().signal);

      // Assert: Router WAS called (@ in path is allowed)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows URL with @ in query string (not in authority)", async () => {
      // Arrange: @ in query is NOT userinfo
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "https://example.com/search?email=user@domain.com" });

      // Act
      await tool.execute("call-at-in-query", {}, new AbortController().signal);

      // Assert: Router WAS called (@ in query is allowed)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows URL with @ in fragment (not in authority)", async () => {
      // Arrange: @ in fragment is NOT userinfo
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "https://example.com/page#section@anchor" });

      // Act
      await tool.execute("call-at-in-fragment", {}, new AbortController().signal);

      // Assert: Router WAS called (@ in fragment is allowed)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows URL with port but no userinfo", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "https://example.com:8443/secure/api" });

      // Act
      await tool.execute("call-port-no-userinfo", {}, new AbortController().signal);

      // Assert: Router WAS called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("userinfo check ordering (must be after scheme check, before router)", () => {
    it("userinfo check blocks AFTER scheme validation passes but BEFORE router call", async () => {
      // Arrange: Clear all mocks to verify call order
      vi.clearAllMocks();

      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://user:pass@example.com/secret" });

      // Act
      try {
        await tool.execute("call-ordering", {}, undefined);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
      }

      // Assert: Router was NEVER called (userinfo check happened first)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);

      // Assert: applyNetworkOverrides was NEVER called
      expect(applyNetworkOverridesMock).toHaveBeenCalledTimes(0);
    });
  });

  describe("error field validation", () => {
    it("userinfo error contains exact expected fields (user only)", async () => {
      // Arrange
      const { tool } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://admin@internal.example.com/config" });

      // Act & Assert
      try {
        await tool.execute("call-exact-user", {}, undefined);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const e = err as ClarityBurstAbstainError;

        // Exact field validation
        expect(e.stageId).toBe("NETWORK_IO");
        expect(e.outcome).toBe("ABSTAIN_CLARIFY");
        expect(e.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(e.contractId).toBeNull();
        expect(typeof e.instructions).toBe("string");
        expect(e.instructions.length).toBeGreaterThan(0);
      }
    });

    it("userinfo error contains exact expected fields (user:pass)", async () => {
      // Arrange
      const { tool } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "post", {}, { url: "https://user:hunter2@api.example.com/v1/upload" });

      // Act & Assert
      try {
        await tool.execute("call-exact-userpass", {}, undefined);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const e = err as ClarityBurstAbstainError;

        // Exact field validation
        expect(e.stageId).toBe("NETWORK_IO");
        expect(e.outcome).toBe("ABSTAIN_CLARIFY");
        expect(e.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(e.contractId).toBeNull();
        expect(typeof e.instructions).toBe("string");
        expect(e.instructions.length).toBeGreaterThan(0);
      }
    });
  });
});
