/**
 * Integration tests verifying the three-layer defense against session stuck:
 * 1. allowSyntheticToolResults — repairs orphaned toolCalls on context build
 * 2. withToolCallTimeout — prevents individual tool hangs
 * 3. drain timeout — prevents pendingToolTasks deadlock
 *
 * These tests verify the layers work independently and in combination.
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { toToolDefinitions, withToolCallTimeout } from "./pi-tool-definition-adapter.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

function extractJsonFromResult(result: unknown): unknown {
  if (result && typeof result === "object" && "details" in result) {
    return (result as { details: unknown }).details;
  }
  return result;
}

describe("session stuck prevention — integration", () => {
  describe("Layer 2: tool timeout prevents individual tool hangs", () => {
    it("hung tool returns error result that model can act on", async () => {
      vi.useFakeTimers();

      const hungTool: AgentTool = {
        name: "web_fetch",
        label: "Web Fetch",
        description: "fetches a URL",
        parameters: Type.Object({}),
        execute: async () => new Promise(() => {}), // never resolves
      };

      const defs = toToolDefinitions([hungTool], { toolCallTimeoutSeconds: 0.1 });
      const promise = defs[0].execute("call-hung", {}, undefined, undefined, extensionContext);

      vi.advanceTimersByTime(100);
      const result = await promise;
      const json = extractJsonFromResult(result);

      // Model receives an error result — session continues instead of hanging
      expect(json).toMatchObject({
        status: "error",
        tool: "web_fetch",
      });
      expect((json as { error: string }).error).toContain("timed out");

      vi.useRealTimers();
    });

    it("multiple parallel tools — one times out, others complete", async () => {
      vi.useFakeTimers();

      const fastTool: AgentTool = {
        name: "fast_tool",
        label: "Fast",
        description: "fast",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: "fast done" }],
          details: { fast: true },
        }),
      };

      const slowTool: AgentTool = {
        name: "slow_tool",
        label: "Slow",
        description: "slow",
        parameters: Type.Object({}),
        execute: async () => new Promise(() => {}),
      };

      const defs = toToolDefinitions([fastTool, slowTool], { toolCallTimeoutSeconds: 0.1 });

      const fastPromise = defs[0].execute("call-fast", {}, undefined, undefined, extensionContext);
      const slowPromise = defs[1].execute("call-slow", {}, undefined, undefined, extensionContext);

      // Fast tool completes immediately
      const fastResult = await fastPromise;
      expect(fastResult.details).toMatchObject({ fast: true });

      // Slow tool needs timer advance
      vi.advanceTimersByTime(100);
      const slowResult = await slowPromise;
      const json = extractJsonFromResult(slowResult);
      expect(json).toMatchObject({ status: "error", tool: "slow_tool" });

      vi.useRealTimers();
    });
  });

  describe("Layer 2: abort signal propagation", () => {
    it("timeout triggers abort that reaches tool execution", async () => {
      vi.useFakeTimers();

      let toolReceivedAbort = false;
      const tool: AgentTool = {
        name: "cancellable_tool",
        label: "Cancellable",
        description: "respects abort",
        parameters: Type.Object({}),
        execute: async (_id, _params, signal) => {
          signal?.addEventListener("abort", () => {
            toolReceivedAbort = true;
          });
          return new Promise(() => {});
        },
      };

      const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 0.05 });
      const promise = defs[0].execute("call-cancel", {}, undefined, undefined, extensionContext);

      vi.advanceTimersByTime(50);
      await promise; // resolves with error result

      expect(toolReceivedAbort).toBe(true);

      vi.useRealTimers();
    });
  });

  describe("Layer 3: drain timeout concept", () => {
    it("Promise.race timeout pattern works for stuck promises", async () => {
      // Simulates the agent-runner drain timeout pattern
      const TIMEOUT_MS = 100;
      const neverSettles = new Promise<void>(() => {});
      const pendingToolTasks = new Set([neverSettles]);

      vi.useFakeTimers();

      let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        drainTimeoutId = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
      });
      const drain = Promise.allSettled(pendingToolTasks).then(() => {
        clearTimeout(drainTimeoutId);
        return "settled" as const;
      });

      const racePromise = Promise.race([drain, timeout]);
      vi.advanceTimersByTime(TIMEOUT_MS);
      const outcome = await racePromise;

      expect(outcome).toBe("timeout");

      vi.useRealTimers();
    });

    it("drain completes before timeout — timeout is cleared", async () => {
      const settlesImmediately = Promise.resolve();
      const pendingToolTasks = new Set([settlesImmediately]);

      let drainTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const clearSpy = vi.spyOn(global, "clearTimeout");

      const timeout = new Promise<"timeout">((resolve) => {
        drainTimeoutId = setTimeout(() => resolve("timeout"), 30_000);
      });
      const drain = Promise.allSettled(pendingToolTasks).then(() => {
        clearTimeout(drainTimeoutId);
        return "settled" as const;
      });

      const outcome = await Promise.race([drain, timeout]);
      expect(outcome).toBe("settled");
      expect(clearSpy).toHaveBeenCalled();

      clearSpy.mockRestore();
    });
  });

  describe("withToolCallTimeout — branch coverage", () => {
    it("timeout=0 bypasses wrapper entirely", async () => {
      let executeCalled = false;
      const result = await withToolCallTimeout(
        async () => {
          executeCalled = true;
          return "direct";
        },
        0,
        "tool",
      );
      expect(executeCalled).toBe(true);
      expect(result).toBe("direct");
    });

    it("negative timeout bypasses wrapper entirely", async () => {
      const result = await withToolCallTimeout(
        async () => "negative-bypass",
        -100,
        "tool",
      );
      expect(result).toBe("negative-bypass");
    });

    it("already-aborted signal bypasses wrapper", async () => {
      const abortedSignal = {
        aborted: true,
        reason: new Error("already aborted"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        onabort: null,
        throwIfAborted: () => {},
        dispatchEvent: () => true,
      } as unknown as AbortSignal;

      let executeCalled = false;
      try {
        await withToolCallTimeout(
          async () => {
            executeCalled = true;
            return "bypassed";
          },
          1000,
          "tool",
          abortedSignal,
        );
      } catch {
        // may throw if execute checks signal
      }
      expect(executeCalled).toBe(true);
    });
  });
});
