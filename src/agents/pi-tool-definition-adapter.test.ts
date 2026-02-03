import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { jsonResult } from "./tools/common.js";

function extractJsonFromResult(result: unknown): unknown {
  if (result && typeof result === "object" && "details" in result) {
    return result.details;
  }
  return result;
}

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call1", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call2", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  describe("tool call timeout", () => {
    it("times out slow tools and returns error result", async () => {
      const tool = {
        name: "slow",
        label: "Slow",
        description: "takes forever",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10000));
          return jsonResult({ status: "ok" });
        },
      } satisfies AgentTool<unknown, unknown>;

      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 0.05 });
      const result = await defs[0].execute("call3", {}, undefined, undefined);

      const resultObj = extractJsonFromResult(result) as { status: string; error: string };
      expect(resultObj.status).toBe("error");
      expect(resultObj.error).toContain("timed out");
      expect(resultObj.error).toContain("50ms");
    });

    it("completes fast tools without timeout", async () => {
      const tool = {
        name: "fast",
        label: "Fast",
        description: "completes quickly",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResult({ status: "ok", result: "done" });
        },
      } satisfies AgentTool<unknown, unknown>;

      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 1 });
      const result = await defs[0].execute("call4", {}, undefined, undefined);

      const resultObj = extractJsonFromResult(result) as { status: string; result: string };
      expect(resultObj.status).toBe("ok");
      expect(resultObj.result).toBe("done");
    });

    it("disables timeout when set to 0", async () => {
      const tool = {
        name: "notimed",
        label: "NoTimed",
        description: "no timeout",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResult({ status: "ok" });
        },
      } satisfies AgentTool<unknown, unknown>;

      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 0 });
      const result = await defs[0].execute("call5", {}, undefined, undefined);

      const resultObj = extractJsonFromResult(result) as { status: string };
      expect(resultObj.status).toBe("ok");
    });

    it("handles abort signal and returns error result", async () => {
      const tool = {
        name: "abortable",
        label: "Abortable",
        description: "can be aborted",
        parameters: {},
        execute: async (_id, _params, signal) => {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(resolve, 10000);
            signal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new Error("Aborted"));
            });
          });
          return jsonResult({ status: "ok" });
        },
      } satisfies AgentTool<unknown, unknown>;

      const abortController = new AbortController();
      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 1 });

      // Start execution
      const promise = defs[0].execute("call6", {}, undefined, undefined, abortController.signal);

      // Abort after a short delay
      setTimeout(() => abortController.abort(), 10);

      // Should return error result (not throw) because the outer error handler converts errors
      const result = await promise;
      const resultObj = extractJsonFromResult(result) as { status: string; error?: string };
      expect(resultObj.status).toBe("error");
      expect(resultObj.error).toMatch(/abort/i);
    });

    it("handles tool execution errors", async () => {
      const tool = {
        name: "failing",
        label: "Failing",
        description: "fails during execution",
        parameters: {},
        execute: async () => {
          throw new Error("Something went wrong");
        },
      } satisfies AgentTool<unknown, unknown>;

      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 1 });
      const result = await defs[0].execute("call7", {}, undefined, undefined);

      const resultObj = extractJsonFromResult(result) as { status: string; error: string };
      expect(resultObj.status).toBe("error");
      expect(resultObj.error).toBe("Something went wrong");
    });

    it("cleans up timeout and abort listeners when execution completes", async () => {
      const removeEventListener = vi.fn();
      const addEventListener = vi.fn();
      const mockSignal = {
        aborted: false,
        addEventListener,
        removeEventListener,
      } as unknown as AbortSignal;

      const tool = {
        name: "cleanup",
        label: "Cleanup",
        description: "tests cleanup",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResult({ status: "ok" });
        },
      } satisfies AgentTool<unknown, unknown>;

      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 1 });
      await defs[0].execute("call8", {}, undefined, undefined, mockSignal);

      // Should have added and removed the abort listener
      expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("cleans up abort listener when timeout fires first", async () => {
      const removeEventListener = vi.fn();
      const addEventListener = vi.fn();
      const mockSignal = {
        aborted: false,
        addEventListener,
        removeEventListener,
      } as unknown as AbortSignal;

      const tool = {
        name: "timeoutfirst",
        label: "TimeoutFirst",
        description: "timeout fires before completion",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10000));
          return jsonResult({ status: "ok" });
        },
      } satisfies AgentTool<unknown, unknown>;

      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 0.05 });
      await defs[0].execute("call9", {}, undefined, undefined, mockSignal);

      // Should have added the listener
      expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
      // Should have removed the listener when timeout fired (FIX for Issue #1)
      expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    });
  });
});
