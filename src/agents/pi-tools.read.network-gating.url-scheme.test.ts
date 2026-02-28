import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

/**
 * URL scheme allowlist regression tests for NETWORK_IO gating.
 *
 * These tests verify that executeWithNetworkGating() hard-blocks URLs with
 * non-http/https schemes BEFORE calling routeClarityBurst() or the executor.
 *
 * Test cases:
 * - file:// URLs → ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE
 * - ftp:// URLs → ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE
 * - data: URLs → ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE
 * - scheme-less URLs (no protocol) → ABSTAIN_CLARIFY with PACK_POLICY_INCOMPLETE
 * - http:// URLs → allowed (router is called)
 * - https:// URLs → allowed (router is called)
 */

// Spy on routeClarityBurst to verify it's NOT called for blocked schemes
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

describe("NETWORK_IO URL scheme allowlist check", () => {
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

  describe("blocked URL schemes (hard-block before routing)", () => {
    it("blocks file:// URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "file:///etc/passwd" });

      // Act & Assert
      try {
        await tool.execute("call-file", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
        expect(abstainError.instructions).toContain("http://");
        expect(abstainError.instructions).toContain("https://");
      }

      // Assert: Router was NEVER called (blocked before routing)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks ftp:// URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "ftp://ftp.example.com/file.txt" });

      // Act & Assert
      try {
        await tool.execute("call-ftp", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
        expect(abstainError.instructions).toContain("http://");
        expect(abstainError.instructions).toContain("https://");
      }

      // Assert: Router was NEVER called (blocked before routing)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks data: URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "data:text/html,<script>alert(1)</script>" });

      // Act & Assert
      try {
        await tool.execute("call-data", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
        expect(abstainError.instructions).toContain("http://");
        expect(abstainError.instructions).toContain("https://");
      }

      // Assert: Router was NEVER called (blocked before routing)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks scheme-less URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "example.com/path" });

      // Act & Assert
      try {
        await tool.execute("call-schemeless", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
        expect(abstainError.contractId).toBeNull();
        expect(abstainError.instructions).toContain("http://");
        expect(abstainError.instructions).toContain("https://");
      }

      // Assert: Router was NEVER called (blocked before routing)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });

    it("blocks javascript: URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "javascript:alert(document.cookie)" });

      // Act & Assert
      try {
        await tool.execute("call-javascript", {}, new AbortController().signal);
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

    it("blocks blob: URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "blob:https://example.com/12345" });

      // Act & Assert
      try {
        await tool.execute("call-blob", {}, new AbortController().signal);
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

    it("blocks mailto: URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "mailto:user@example.com" });

      // Act & Assert
      try {
        await tool.execute("call-mailto", {}, new AbortController().signal);
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

    it("blocks tel: URLs with ABSTAIN_CLARIFY and PACK_POLICY_INCOMPLETE", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "tel:+1234567890" });

      // Act & Assert
      try {
        await tool.execute("call-tel", {}, new AbortController().signal);
        expect.fail("Expected ClarityBurstAbstainError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainError = err as ClarityBurstAbstainError;
        expect(abstainError.stageId).toBe("NETWORK_IO");
        expect(abstainError.outcome).toBe("ABSTAIN_CLARIFY");
        expect(abstainError.reason).toBe("PACK_POLICY_INCOMPLETE");
      }

      // Assert: Router was NEVER called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe("allowed URL schemes (proceed to routing)", () => {
    it("allows http:// URLs and proceeds to router", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "http://example.com/api" });

      // Act
      await tool.execute("call-http", {}, new AbortController().signal);

      // Assert: Router WAS called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called (after router approved)
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows https:// URLs and proceeds to router", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "https://secure.example.com/api" });

      // Act
      await tool.execute("call-https", {}, new AbortController().signal);

      // Assert: Router WAS called
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called (after router approved)
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows HTTP:// URLs (case-insensitive scheme check)", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "HTTP://EXAMPLE.COM/API" });

      // Act
      await tool.execute("call-http-upper", {}, new AbortController().signal);

      // Assert: Router WAS called (case-insensitive check passed)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it("allows HTTPS:// URLs (case-insensitive scheme check)", async () => {
      // Arrange
      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "HTTPS://Secure.Example.Com/path" });

      // Act
      await tool.execute("call-https-mixed", {}, new AbortController().signal);

      // Assert: Router WAS called (case-insensitive check passed)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(1);

      // Assert: Executor WAS called
      expect(executeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("error field validation", () => {
    it("file:// error contains exact expected fields", async () => {
      // Arrange
      const { tool } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "file:///secret/data" });

      // Act & Assert
      try {
        await tool.execute("call-file-exact", {}, undefined);
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

    it("ftp:// error contains exact expected fields", async () => {
      // Arrange
      const { tool } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "post", {}, { url: "ftp://files.example.org/upload" });

      // Act & Assert
      try {
        await tool.execute("call-ftp-exact", {}, undefined);
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

    it("data: error contains exact expected fields", async () => {
      // Arrange
      const { tool } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "data:application/json,{}" });

      // Act & Assert
      try {
        await tool.execute("call-data-exact", {}, undefined);
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

    it("scheme-less error contains exact expected fields", async () => {
      // Arrange
      const { tool } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "api.example.com/v1/users" });

      // Act & Assert
      try {
        await tool.execute("call-schemeless-exact", {}, undefined);
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

  describe("scheme check ordering (must be before router)", () => {
    it("scheme check blocks before ANY router or pack lookup calls", async () => {
      // Arrange: Clear all mocks to verify call order
      vi.clearAllMocks();

      const { tool, executeSpy } = createMockNetworkTool();
      wrapWithNetworkGating(tool, "get", {}, { url: "file:///etc/shadow" });

      // Act
      try {
        await tool.execute("call-ordering", {}, undefined);
        expect.fail("Expected ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
      }

      // Assert: Router was NEVER called (scheme check happened first)
      expect(routeClarityBurstMock).toHaveBeenCalledTimes(0);

      // Assert: Executor was NEVER called
      expect(executeSpy).toHaveBeenCalledTimes(0);

      // Assert: applyNetworkOverrides was NEVER called
      expect(applyNetworkOverridesMock).toHaveBeenCalledTimes(0);
    });
  });
});
