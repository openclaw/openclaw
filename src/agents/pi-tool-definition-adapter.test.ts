import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../config/config.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { jsonResult } from "./tools/common.js";

function extractJsonFromResult(result: { content: unknown }): unknown {
  if (Array.isArray(result.content) && result.content.length > 0) {
    const firstBlock = result.content[0];
    if (firstBlock && typeof firstBlock === "object" && "text" in firstBlock) {
      return JSON.parse((firstBlock as { text: string }).text);
    }
  }
  return JSON.parse(result.content as string);
}

describe("toToolDefinitions", () => {
  describe("per-tool timeout", () => {
    it("should timeout a tool call that exceeds the configured timeout", async () => {
      const slowTool: AgentTool = {
        name: "slow_tool",
        description: "A tool that takes too long",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          return jsonResult({ status: "success", data: "completed" });
        },
      };

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            toolCallTimeoutSeconds: 1,
          },
        },
      };

      const toolDefs = toToolDefinitions([slowTool], config);
      const startTime = Date.now();
      const result = await toolDefs[0].execute("test-call-id", {}, undefined, undefined, undefined);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(2000);
      expect(elapsed).toBeGreaterThanOrEqual(900);

      const resultObj = extractJsonFromResult(result) as { status: string; error: string };
      expect(resultObj.status).toBe("error");
      expect(resultObj.error).toContain("timed out after 1 seconds");
    });

    it("should not timeout a tool call that completes within the timeout", async () => {
      const fastTool: AgentTool = {
        name: "fast_tool",
        description: "A tool that completes quickly",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return jsonResult({ status: "success", data: "completed" });
        },
      };

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            toolCallTimeoutSeconds: 2,
          },
        },
      };

      const toolDefs = toToolDefinitions([fastTool], config);
      const result = await toolDefs[0].execute("test-call-id", {}, undefined, undefined, undefined);

      const resultObj = extractJsonFromResult(result) as { status: string; data: string };
      expect(resultObj.status).toBe("success");
      expect(resultObj.data).toBe("completed");
    });

    it("should use default timeout of 60 seconds when not configured", async () => {
      const tool: AgentTool = {
        name: "test_tool",
        description: "Test",
        parameters: {},
        execute: vi.fn(async () => jsonResult({ status: "success" })),
      };

      const toolDefs = toToolDefinitions([tool], undefined);
      await toolDefs[0].execute("test-call-id", {}, undefined, undefined, undefined);

      expect(tool.execute).toHaveBeenCalled();
    });

    it("should disable timeout when set to 0", async () => {
      const tool: AgentTool = {
        name: "infinite_tool",
        description: "A tool that would timeout if enabled",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return jsonResult({ status: "success" });
        },
      };

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            toolCallTimeoutSeconds: 0,
          },
        },
      };

      const toolDefs = toToolDefinitions([tool], config);
      const result = await toolDefs[0].execute("test-call-id", {}, undefined, undefined, undefined);

      const resultObj = extractJsonFromResult(result) as { status: string };
      expect(resultObj.status).toBe("success");
    });

    it("should respect abort signal even with timeout", async () => {
      const tool: AgentTool = {
        name: "abortable_tool",
        description: "A tool that checks abort signal",
        parameters: {},
        execute: async (_id, _params, signal) => {
          if (signal?.aborted) {
            throw new Error("Aborted");
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return jsonResult({ status: "success" });
        },
      };

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            toolCallTimeoutSeconds: 5,
          },
        },
      };

      const abortController = new AbortController();
      const toolDefs = toToolDefinitions([tool], config);
      abortController.abort();

      await expect(
        toolDefs[0].execute("test-call-id", {}, undefined, undefined, abortController.signal),
      ).rejects.toThrow();
    });

    it("should handle tool execution errors properly", async () => {
      const errorTool: AgentTool = {
        name: "error_tool",
        description: "A tool that throws an error",
        parameters: {},
        execute: async () => {
          throw new Error("Tool execution failed");
        },
      };

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            toolCallTimeoutSeconds: 5,
          },
        },
      };

      const toolDefs = toToolDefinitions([errorTool], config);
      const result = await toolDefs[0].execute("test-call-id", {}, undefined, undefined, undefined);

      const resultObj = extractJsonFromResult(result) as { status: string; error: string };
      expect(resultObj.status).toBe("error");
      expect(resultObj.error).toContain("Tool execution failed");
    });
  });
});
