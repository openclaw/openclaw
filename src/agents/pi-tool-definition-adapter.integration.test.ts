import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

// Simple mock tool for testing
function createMockTool(name: string, executeResult: unknown): AgentTool<unknown, unknown> {
  return {
    name,
    label: name,
    description: `Test tool: ${name}`,
    parameters: {
      type: "object",
      properties: {
        input: { type: "string" },
      },
    },
    execute: async (): Promise<AgentToolResult<unknown>> => ({
      content: executeResult,
      isError: false,
    }),
  };
}

describe("toToolDefinitions - Integration", () => {
  it("wraps tool execution with timing", async () => {
    const mockTool = createMockTool("timed-tool", "result");
    const definitions = toToolDefinitions([mockTool]);

    expect(definitions).toHaveLength(1);
    expect(definitions[0].name).toBe("timed-tool");

    // Execute the wrapped tool
    const result = await definitions[0].execute(
      "call-1",
      { input: "test" },
      undefined,
      {},
      undefined,
    );

    expect(result.content).toBe("result");
    expect(result.isError).toBe(false);
  });

  it("preserves error results", async () => {
    const errorTool: AgentTool<unknown, unknown> = {
      name: "error-tool",
      label: "error-tool",
      description: "Tool that throws",
      parameters: { type: "object", properties: {} },
      execute: async (): Promise<never> => {
        throw new Error("Tool execution failed");
      },
    };

    const definitions = toToolDefinitions([errorTool]);
    const result = await definitions[0].execute("call-1", {}, undefined, {}, undefined);

    // Should return error result, not throw (jsonResult doesn't set isError)
    expect(result.isError).toBeUndefined();
    // Content is JSON stringified, so we check the text content
    const contentArray = result.content as Array<{ text?: string }>;
    const contentText = JSON.stringify(contentArray[0]?.text || "");
    expect(contentText).toContain("error");
    expect(contentText).toContain("Tool execution failed");
  });

  it("passes hook context through execution", async () => {
    const mockTool = createMockTool("context-tool", { data: "value" });

    const hookContext = {
      agentId: "test-agent-123",
      sessionKey: "session-abc",
    };

    const definitions = toToolDefinitions([mockTool], hookContext);
    const result = await definitions[0].execute(
      "call-1",
      { param: "value" },
      undefined,
      {},
      undefined,
    );

    expect(result.content).toEqual({ data: "value" });
  });

  it("handles tools without hook context", async () => {
    const mockTool = createMockTool("no-context-tool", "simple result");

    // No hook context provided
    const definitions = toToolDefinitions([mockTool]);
    const result = await definitions[0].execute("call-1", {}, undefined, {}, undefined);

    expect(result.content).toBe("simple result");
  });

  it("handles abort signal correctly", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const abortingTool: AgentTool<unknown, unknown> = {
      name: "abort-tool",
      label: "abort-tool",
      description: "Tool that checks abort",
      parameters: { type: "object", properties: {} },
      execute: async (
        _id: string,
        _params: unknown,
        signal: AbortSignal,
      ): Promise<AgentToolResult<unknown>> => {
        if (signal?.aborted) {
          throw new Error("AbortError");
        }
        return { content: "completed", isError: false };
      },
    };

    const definitions = toToolDefinitions([abortingTool]);

    // Should throw when aborted
    await expect(
      definitions[0].execute("call-1", {}, undefined, {}, abortController.signal),
    ).rejects.toThrow();
  });

  it("handles update callbacks", async () => {
    const updates: unknown[] = [];

    const updatingTool: AgentTool<unknown, unknown> = {
      name: "update-tool",
      label: "update-tool",
      description: "Tool with updates",
      parameters: { type: "object", properties: {} },
      execute: async (
        _id: string,
        _params: unknown,
        _signal: unknown,
        onUpdate: (update: unknown) => void,
      ): Promise<AgentToolResult<unknown>> => {
        onUpdate?.({ progress: 50 });
        return { content: "done", isError: false };
      },
    };

    const definitions = toToolDefinitions([updatingTool]);
    const result = await definitions[0].execute(
      "call-1",
      {},
      (update) => updates.push(update),
      {},
      undefined,
    );

    expect(result.content).toBe("done");
    expect(updates).toContainEqual({ progress: 50 });
  });

  it("passes correct parameters to tool", async () => {
    const receivedParams: unknown[] = [];

    const paramTool: AgentTool<unknown, unknown> = {
      name: "param-tool",
      label: "param-tool",
      description: "Tool that captures params",
      parameters: { type: "object", properties: { key: { type: "string" } } },
      execute: async (toolCallId: string, params: unknown): Promise<AgentToolResult<unknown>> => {
        receivedParams.push({ toolCallId, params });
        return { content: "ok", isError: false };
      },
    };

    const definitions = toToolDefinitions([paramTool]);
    await definitions[0].execute("test-call-id", { key: "value" }, undefined, {}, undefined);

    expect(receivedParams).toHaveLength(1);
    expect(receivedParams[0]).toEqual({
      toolCallId: "test-call-id",
      params: { key: "value" },
    });
  });

  it("handles multiple tools independently", async () => {
    const toolA = createMockTool("tool-a", "result-a");
    const toolB = createMockTool("tool-b", "result-b");

    const definitions = toToolDefinitions([toolA, toolB]);
    expect(definitions).toHaveLength(2);

    const resultA = await definitions[0].execute("call-1", {}, undefined, {}, undefined);
    const resultB = await definitions[1].execute("call-2", {}, undefined, {}, undefined);

    expect(resultA.content).toBe("result-a");
    expect(resultB.content).toBe("result-b");
  });
});
