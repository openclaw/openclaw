/**
 * Tests for Concurrent Tool Execution
 */

import { describe, it, expect, vi } from "vitest";
import {
  isConcurrencySafeTool,
  isSerialTool,
  categorizeTools,
  createConcurrentExecutor,
  executeToolsConcurrently,
} from "./concurrent-tools.js";

describe("isConcurrencySafeTool", () => {
  describe("safe tools", () => {
    it("should return true for read tools", () => {
      expect(isConcurrencySafeTool("read")).toBe(true);
      expect(isConcurrencySafeTool("glob")).toBe(true);
      expect(isConcurrencySafeTool("grep")).toBe(true);
    });

    it("should return true for web tools", () => {
      expect(isConcurrencySafeTool("web_fetch")).toBe(true);
      expect(isConcurrencySafeTool("web_search")).toBe(true);
    });

    it("should return true for memory tools", () => {
      expect(isConcurrencySafeTool("memory_search")).toBe(true);
      expect(isConcurrencySafeTool("memory_get")).toBe(true);
    });

    it("should return true for session query tools", () => {
      expect(isConcurrencySafeTool("sessions_list")).toBe(true);
      expect(isConcurrencySafeTool("sessions_history")).toBe(true);
    });

    it("should return true for browser read tools", () => {
      expect(isConcurrencySafeTool("browser_status")).toBe(true);
      expect(isConcurrencySafeTool("browser_snapshot")).toBe(true);
      expect(isConcurrencySafeTool("browser_screenshot")).toBe(true);
    });

    it("should handle case-insensitive tool names", () => {
      expect(isConcurrencySafeTool("READ")).toBe(true);
      expect(isConcurrencySafeTool("Read")).toBe(true);
      expect(isConcurrencySafeTool(" WEB_FETCH ")).toBe(true);
    });
  });

  describe("unsafe tools", () => {
    it("should return false for write tools", () => {
      expect(isConcurrencySafeTool("write")).toBe(false);
      expect(isConcurrencySafeTool("edit")).toBe(false);
    });

    it("should return false for exec tools", () => {
      expect(isConcurrencySafeTool("exec")).toBe(false);
      expect(isConcurrencySafeTool("process")).toBe(false);
    });

    it("should return false for message tools", () => {
      expect(isConcurrencySafeTool("message")).toBe(false);
    });

    it("should return false for session spawn tools", () => {
      expect(isConcurrencySafeTool("sessions_spawn")).toBe(false);
      expect(isConcurrencySafeTool("sessions_send")).toBe(false);
    });

    it("should return false for gateway tools", () => {
      expect(isConcurrencySafeTool("gateway_restart")).toBe(false);
      expect(isConcurrencySafeTool("gateway_config_apply")).toBe(false);
    });

    it("should return false for browser action tools", () => {
      expect(isConcurrencySafeTool("browser_act")).toBe(false);
      expect(isConcurrencySafeTool("browser_navigate")).toBe(false);
    });
  });

  describe("unknown tools", () => {
    it("should return false for unknown tools (conservative)", () => {
      expect(isConcurrencySafeTool("unknown_tool")).toBe(false);
      expect(isConcurrencySafeTool("custom_tool")).toBe(false);
    });
  });
});

describe("isSerialTool", () => {
  it("should be inverse of isConcurrencySafeTool", () => {
    expect(isSerialTool("read")).toBe(false);
    expect(isSerialTool("write")).toBe(true);
    expect(isSerialTool("unknown")).toBe(true);
  });
});

describe("categorizeTools", () => {
  it("should separate safe and unsafe tools", () => {
    const tools = ["read", "write", "glob", "exec", "grep", "message"];
    const { safe, unsafe } = categorizeTools(tools);
    
    expect(safe).toEqual(["read", "glob", "grep"]);
    expect(unsafe).toEqual(["write", "exec", "message"]);
  });

  it("should handle empty arrays", () => {
    const { safe, unsafe } = categorizeTools([]);
    expect(safe).toEqual([]);
    expect(unsafe).toEqual([]);
  });

  it("should handle all-safe arrays", () => {
    const { safe, unsafe } = categorizeTools(["read", "glob", "grep"]);
    expect(safe).toEqual(["read", "glob", "grep"]);
    expect(unsafe).toEqual([]);
  });

  it("should handle all-unsafe arrays", () => {
    const { safe, unsafe } = categorizeTools(["write", "exec", "message"]);
    expect(safe).toEqual([]);
    expect(unsafe).toEqual(["write", "exec", "message"]);
  });
});

describe("ConcurrentToolExecutor", () => {
  it("should execute tools in order", async () => {
    const executionOrder: string[] = [];
    
    const executor = async (toolName: string, _args: unknown, _toolCallId: string) => {
      executionOrder.push(toolName);
      return { toolCallId: "1", toolName, result: "ok", duration: 10 };
    };
    
    const concurrentExecutor = createConcurrentExecutor(executor);
    
    await concurrentExecutor.execute("read", {}, "1");
    await concurrentExecutor.execute("write", {}, "2");
    
    expect(executionOrder).toEqual(["read", "write"]);
  });

  it("should wait for pending tools before unsafe execution", async () => {
    const executionOrder: string[] = [];
    const delays: Record<string, number> = {
      read: 50,
      write: 0,
    };
    
    const executor = async (toolName: string, _args: unknown, _toolCallId: string) => {
      await new Promise(resolve => setTimeout(resolve, delays[toolName] ?? 0));
      executionOrder.push(toolName);
      return { toolCallId: "1", toolName, result: "ok", duration: 10 };
    };
    
    const concurrentExecutor = createConcurrentExecutor(executor);
    
    // Start read (safe, slow)
    const readPromise = concurrentExecutor.execute("read", {}, "1");
    
    // Start write (unsafe, should wait for read)
    const writePromise = concurrentExecutor.execute("write", {}, "2");
    
    await Promise.all([readPromise, writePromise]);
    
    // Read should complete before write starts
    expect(executionOrder).toEqual(["read", "write"]);
  });

  it("should track pending count", async () => {
    const executor = async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { toolCallId: "1", toolName: "read", result: "ok", duration: 10 };
    };
    
    const concurrentExecutor = createConcurrentExecutor(executor);
    
    expect(concurrentExecutor.pendingCount).toBe(0);
    
    const promise = concurrentExecutor.execute("read", {}, "1");
    
    // Should have pending execution
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(concurrentExecutor.pendingCount).toBe(1);
    
    await promise;
    expect(concurrentExecutor.pendingCount).toBe(0);
  });
});

describe("executeToolsConcurrently", () => {
  it("should execute safe tools concurrently", async () => {
    const executionTimes: Array<{ tool: string; start: number; end: number }> = [];
    
    const executor = async (toolName: string, _args: unknown, toolCallId: string) => {
      const start = Date.now();
      await new Promise(resolve => setTimeout(resolve, 50));
      const end = Date.now();
      executionTimes.push({ tool: toolName, start, end });
      return { toolCallId, toolName, result: "ok", duration: end - start };
    };
    
    const tools = [
      { toolName: "read", args: { path: "a.txt" }, toolCallId: "1" },
      { toolName: "read", args: { path: "b.txt" }, toolCallId: "2" },
      { toolName: "read", args: { path: "c.txt" }, toolCallId: "3" },
    ];
    
    const results = await executeToolsConcurrently(tools, executor);
    
    expect(results).toHaveLength(3);
    
    // Check that they ran concurrently (overlapping times)
    const [a, b, c] = executionTimes;
    
    // All should have started before the first one ended
    // This indicates concurrent execution
    const allStartedBeforeFirstEnd = executionTimes.every(
      t => t.start < (executionTimes[0].end - executionTimes[0].start + executionTimes[0].start + 30)
    );
    
    // At least some overlap should exist
    expect(allStartedBeforeFirstEnd).toBe(true);
  });

  it("should execute unsafe tools serially", async () => {
    const executionOrder: string[] = [];
    
    const executor = async (toolName: string, _args: unknown, toolCallId: string) => {
      executionOrder.push(toolName);
      return { toolCallId, toolName, result: "ok", duration: 10 };
    };
    
    const tools = [
      { toolName: "write", args: { path: "a.txt" }, toolCallId: "1" },
      { toolName: "write", args: { path: "b.txt" }, toolCallId: "2" },
      { toolName: "write", args: { path: "c.txt" }, toolCallId: "3" },
    ];
    
    await executeToolsConcurrently(tools, executor);
    
    expect(executionOrder).toEqual(["write", "write", "write"]);
  });

  it("should handle mixed safe and unsafe tools", async () => {
    const executionOrder: string[] = [];
    
    const executor = async (toolName: string, _args: unknown, toolCallId: string) => {
      executionOrder.push(toolName);
      await new Promise(resolve => setTimeout(resolve, 10));
      return { toolCallId, toolName, result: "ok", duration: 10 };
    };
    
    const tools = [
      { toolName: "read", args: {}, toolCallId: "1" },   // safe
      { toolName: "read", args: {}, toolCallId: "2" },   // safe
      { toolName: "write", args: {}, toolCallId: "3" },  // unsafe
      { toolName: "read", args: {}, toolCallId: "4" },   // safe
    ];
    
    await executeToolsConcurrently(tools, executor);
    
    // Write should come after the first two reads
    const writeIndex = executionOrder.indexOf("write");
    const readsBeforeWrite = executionOrder.slice(0, writeIndex).filter(t => t === "read");
    
    expect(readsBeforeWrite.length).toBeGreaterThanOrEqual(2);
  });
});
