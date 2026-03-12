// @vitest-pool threads
// ↑ vi.mock for external packages requires threads pool.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSsmSend = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = mockSsmSend;
  },
  GetParameterCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

import { loadAgentCoreConfig } from "./config.js";

describe("loadAgentCoreConfig", () => {
  beforeEach(() => {
    mockSsmSend.mockReset();
  });

  // ── localOverride path ──────────────────────────────────────────────

  describe("localOverride path", () => {
    it("returns override values directly and does NOT call SSM", async () => {
      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
        localOverride: {
          runtimeArns: ["arn:aws:agentcore:us-west-2:123:runtime/local"],
          memoryNamespacePrefix: "local_",
          defaultModel: "anthropic.claude-haiku-3",
        },
      });

      expect(config.runtimeArns).toEqual(["arn:aws:agentcore:us-west-2:123:runtime/local"]);
      expect(config.memoryNamespacePrefix).toBe("local_");
      expect(config.defaultModel).toBe("anthropic.claude-haiku-3");
      expect(mockSsmSend).not.toHaveBeenCalled();
    });

    it("fills in defaults for missing fields", async () => {
      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
        localOverride: {},
      });

      expect(config.runtimeArns).toEqual([]);
      expect(config.memoryNamespacePrefix).toBe("tenant_");
      expect(config.defaultModel).toBe("anthropic.claude-sonnet-4-20250514");
      expect(config.region).toBe("us-west-2");
      expect(mockSsmSend).not.toHaveBeenCalled();
    });

    it("preserves provided endpoint and invokeTimeoutMs", async () => {
      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
        region: "eu-west-1",
        localOverride: {
          endpoint: "https://localhost:9999",
          invokeTimeoutMs: 60_000,
        },
      });

      expect(config.endpoint).toBe("https://localhost:9999");
      expect(config.invokeTimeoutMs).toBe(60_000);
      expect(config.region).toBe("eu-west-1");
    });
  });

  // ── SSM path ────────────────────────────────────────────────────────

  describe("SSM path", () => {
    it("parses runtime-arns as JSON array of strings", async () => {
      mockSsmSend.mockImplementation((cmd: any) => {
        const name = cmd.input?.Name;
        if (name?.endsWith("/runtime-arns")) {
          return {
            Parameter: {
              Value:
                '["arn:aws:agentcore:us-west-2:123:runtime/a","arn:aws:agentcore:us-west-2:123:runtime/b"]',
            },
          };
        }
        return { Parameter: { Value: null } };
      });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.runtimeArns).toEqual([
        "arn:aws:agentcore:us-west-2:123:runtime/a",
        "arn:aws:agentcore:us-west-2:123:runtime/b",
      ]);
    });

    it("parses memory-config JSON and extracts memoryNamespacePrefix", async () => {
      mockSsmSend.mockImplementation((cmd: any) => {
        const name = cmd.input?.Name;
        if (name?.endsWith("/memory-config")) {
          return {
            Parameter: { Value: '{"memoryEnabled":true,"memoryNamespacePrefix":"custom_prefix_"}' },
          };
        }
        return { Parameter: { Value: null } };
      });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.memoryNamespacePrefix).toBe("custom_prefix_");
    });

    it("uses default-model string value and trims whitespace", async () => {
      mockSsmSend.mockImplementation((cmd: any) => {
        const name = cmd.input?.Name;
        if (name?.endsWith("/default-model")) {
          return { Parameter: { Value: "  anthropic.claude-haiku-3  " } };
        }
        return { Parameter: { Value: null } };
      });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.defaultModel).toBe("anthropic.claude-haiku-3");
    });

    it("falls back to defaults when SSM returns null for all params", async () => {
      mockSsmSend.mockResolvedValue({ Parameter: { Value: null } });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.runtimeArns).toEqual([]);
      expect(config.memoryNamespacePrefix).toBe("tenant_");
      expect(config.defaultModel).toBe("anthropic.claude-sonnet-4-20250514");
      expect(config.region).toBe("us-west-2");
    });

    it("falls back to defaults when SSM params contain invalid JSON", async () => {
      mockSsmSend.mockImplementation((cmd: any) => {
        const name = cmd.input?.Name;
        if (name?.endsWith("/runtime-arns")) {
          return { Parameter: { Value: "not-valid-json{[" } };
        }
        if (name?.endsWith("/memory-config")) {
          return { Parameter: { Value: "{broken" } };
        }
        if (name?.endsWith("/default-model")) {
          return { Parameter: { Value: "" } };
        }
        return {};
      });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.runtimeArns).toEqual([]);
      expect(config.memoryNamespacePrefix).toBe("tenant_");
      expect(config.defaultModel).toBe("anthropic.claude-sonnet-4-20250514");
    });

    it("uses DEFAULT_REGION when region not specified in source", async () => {
      mockSsmSend.mockResolvedValue({ Parameter: { Value: null } });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.region).toBe("us-west-2");
    });
  });

  // ── endpointOverride (loads from SSM, applies endpoint after) ───────

  describe("endpointOverride", () => {
    it("applies endpoint override without skipping SSM", async () => {
      mockSsmSend.mockImplementation((cmd: any) => {
        const name = cmd.input?.Name;
        if (name?.endsWith("/runtime-arns")) {
          return {
            Parameter: {
              Value: '["arn:aws:agentcore:us-west-2:123:runtime/real"]',
            },
          };
        }
        return { Parameter: { Value: null } };
      });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
        endpointOverride: "https://localhost:9999",
      });

      expect(config.runtimeArns).toEqual(["arn:aws:agentcore:us-west-2:123:runtime/real"]);
      expect(config.endpoint).toBe("https://localhost:9999");
      expect(mockSsmSend).toHaveBeenCalled();
    });

    it("does not set endpoint when endpointOverride is undefined", async () => {
      mockSsmSend.mockResolvedValue({ Parameter: { Value: null } });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.endpoint).toBeUndefined();
    });
  });

  // ── SSM error handling ──────────────────────────────────────────────

  describe("SSM error handling", () => {
    it("handles SSM GetParameter failures gracefully and returns defaults", async () => {
      mockSsmSend.mockRejectedValue(new Error("ParameterNotFound"));

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.runtimeArns).toEqual([]);
      expect(config.memoryNamespacePrefix).toBe("tenant_");
      expect(config.defaultModel).toBe("anthropic.claude-sonnet-4-20250514");
      expect(config.region).toBe("us-west-2");
    });

    it("filters out empty and non-string entries from runtimeArns", async () => {
      mockSsmSend.mockImplementation((cmd: any) => {
        const name = cmd.input?.Name;
        if (name?.endsWith("/runtime-arns")) {
          return {
            Parameter: {
              Value: JSON.stringify([
                "arn:aws:agentcore:us-west-2:123:runtime/valid",
                "",
                "   ",
                42,
                null,
                "arn:aws:agentcore:us-west-2:123:runtime/also-valid",
              ]),
            },
          };
        }
        return { Parameter: { Value: null } };
      });

      const config = await loadAgentCoreConfig({
        ssmPrefix: "/hyperion/beta/agentcore",
      });

      expect(config.runtimeArns).toEqual([
        "arn:aws:agentcore:us-west-2:123:runtime/valid",
        "arn:aws:agentcore:us-west-2:123:runtime/also-valid",
      ]);
    });
  });
});
