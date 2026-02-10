import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "./failover-error.js";

const { queryMock, logMock } = vi.hoisted(() => {
  const mock = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() };
  mock.child.mockReturnValue(mock);
  return { queryMock: vi.fn(), logMock: mock };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => logMock,
}));

import {
  classifySDKAssistantError,
  classifySDKResultError,
  runSDKAgent,
} from "./claude-sdk-integration.js";

function makeAsyncIterable<T>(items: T[]): AsyncGenerator<T, void> {
  return (async function* () {
    for (const item of items) {
      yield item;
    }
  })();
}

describe("classifySDKAssistantError", () => {
  it("maps authentication_failed to auth", () => {
    expect(classifySDKAssistantError("authentication_failed")).toBe("auth");
  });

  it("maps billing_error to billing", () => {
    expect(classifySDKAssistantError("billing_error")).toBe("billing");
  });

  it("maps rate_limit to rate_limit", () => {
    expect(classifySDKAssistantError("rate_limit")).toBe("rate_limit");
  });

  it("maps invalid_request to format", () => {
    expect(classifySDKAssistantError("invalid_request")).toBe("format");
  });

  it("maps server_error to unknown", () => {
    expect(classifySDKAssistantError("server_error")).toBe("unknown");
  });

  it("maps unknown to unknown", () => {
    expect(classifySDKAssistantError("unknown")).toBe("unknown");
  });

  it("returns null for max_output_tokens", () => {
    expect(classifySDKAssistantError("max_output_tokens")).toBeNull();
  });
});

describe("classifySDKResultError", () => {
  it("maps error_max_turns to timeout", () => {
    expect(classifySDKResultError("error_max_turns")).toBe("timeout");
  });

  it("maps error_max_budget_usd to billing", () => {
    expect(classifySDKResultError("error_max_budget_usd")).toBe("billing");
  });

  it("maps error_max_structured_output_retries to format", () => {
    expect(classifySDKResultError("error_max_structured_output_retries")).toBe("format");
  });

  it("maps error_during_execution to unknown", () => {
    expect(classifySDKResultError("error_during_execution")).toBe("unknown");
  });
});

describe("runSDKAgent", () => {
  beforeEach(() => {
    queryMock.mockReset();
    logMock.info.mockReset();
    logMock.debug.mockReset();
    logMock.warn.mockReset();
  });

  it("returns SDKAgentResult on success", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Working..." }] },
          session_id: "sess-1",
          uuid: "uuid-1",
          parent_tool_use_id: null,
        },
        {
          type: "result",
          subtype: "success",
          result: "Done!",
          session_id: "sess-1",
          duration_ms: 5000,
          duration_api_ms: 4000,
          is_error: false,
          num_turns: 3,
          total_cost_usd: 0.05,
          usage: {
            input_tokens: 100,
            output_tokens: 200,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "uuid-2",
        },
      ]),
    );

    const result = await runSDKAgent({
      prompt: "hello",
      cwd: "/tmp",
    });

    expect(result.text).toBe("Done!");
    expect(result.sessionId).toBe("sess-1");
    expect(result.durationMs).toBe(5000);
    expect(result.numTurns).toBe(3);
    expect(result.totalCostUsd).toBe(0.05);
    expect(result.usage).toEqual({
      input: 100,
      output: 200,
      cacheRead: 50,
      cacheWrite: 10,
    });

    const callArgs = queryMock.mock.calls[0]?.[0] as {
      prompt: string;
      options: Record<string, unknown>;
    };
    expect(callArgs.prompt).toBe("hello");
    expect(callArgs.options.cwd).toBe("/tmp");
    expect(callArgs.options.permissionMode).toBe("bypassPermissions");
    expect(callArgs.options.allowDangerouslySkipPermissions).toBe(true);
  });

  it("includes settingSources for user, project, and local settings", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp" });

    const callArgs = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(callArgs.options.settingSources).toEqual(["user", "project", "local"]);
  });

  it("passes systemPromptAppend via preset append", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u",
        },
      ]),
    );

    await runSDKAgent({
      prompt: "test",
      cwd: "/tmp",
      systemPromptAppend: "Extra instructions",
    });

    const callArgs = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(callArgs.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Extra instructions",
    });
  });

  it("uses preset without append when systemPromptAppend is absent", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp" });

    const callArgs = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(callArgs.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("passes sessionId for new sessions", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "my-session",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp", sessionId: "my-session" });

    const callArgs = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(callArgs.options.sessionId).toBe("my-session");
    expect(callArgs.options.resume).toBeUndefined();
  });

  it("passes resume for resumed sessions", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "old-session",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp", resume: "old-session" });

    const callArgs = queryMock.mock.calls[0]?.[0] as { options: Record<string, unknown> };
    expect(callArgs.options.resume).toBe("old-session");
    expect(callArgs.options.sessionId).toBeUndefined();
  });

  it("throws FailoverError with reason auth on authentication_failed", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "assistant",
          message: { content: [] },
          error: "authentication_failed",
          session_id: "s",
          uuid: "u",
          parent_tool_use_id: null,
        },
      ]),
    );

    try {
      await runSDKAgent({ prompt: "test", cwd: "/tmp" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("auth");
    }
  });

  it("throws FailoverError with reason rate_limit on rate_limit", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "assistant",
          message: { content: [] },
          error: "rate_limit",
          session_id: "s",
          uuid: "u",
          parent_tool_use_id: null,
        },
      ]),
    );

    try {
      await runSDKAgent({ prompt: "test", cwd: "/tmp" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("rate_limit");
    }
  });

  it("throws FailoverError with reason billing on billing_error", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "assistant",
          message: { content: [] },
          error: "billing_error",
          session_id: "s",
          uuid: "u",
          parent_tool_use_id: null,
        },
      ]),
    );

    try {
      await runSDKAgent({ prompt: "test", cwd: "/tmp" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("billing");
    }
  });

  it("throws FailoverError with reason timeout on error_max_turns", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "result",
          subtype: "error_max_turns",
          duration_ms: 10000,
          duration_api_ms: 9000,
          is_error: true,
          num_turns: 250,
          stop_reason: null,
          total_cost_usd: 1.5,
          usage: {
            input_tokens: 1000,
            output_tokens: 2000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          errors: ["Max turns reached"],
          uuid: "u",
          session_id: "s",
        },
      ]),
    );

    try {
      await runSDKAgent({ prompt: "test", cwd: "/tmp" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("timeout");
    }
  });

  it("throws FailoverError with reason format on error_max_structured_output_retries", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "result",
          subtype: "error_max_structured_output_retries",
          duration_ms: 5000,
          duration_api_ms: 4000,
          is_error: true,
          num_turns: 10,
          stop_reason: null,
          total_cost_usd: 0.5,
          usage: {
            input_tokens: 500,
            output_tokens: 1000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          errors: ["Structured output retries exhausted"],
          uuid: "u",
          session_id: "s",
        },
      ]),
    );

    try {
      await runSDKAgent({ prompt: "test", cwd: "/tmp" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("format");
    }
  });

  it("throws FailoverError on unexpected stream end", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Working..." }] },
          session_id: "s",
          uuid: "u",
          parent_tool_use_id: null,
        },
        // No result message - stream ends
      ]),
    );

    try {
      await runSDKAgent({ prompt: "test", cwd: "/tmp" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).reason).toBe("unknown");
      expect((err as FailoverError).message).toContain("unexpectedly");
    }
  });

  it("wraps SDK internal errors as FailoverError", async () => {
    queryMock.mockImplementationOnce(() => ({
      async next() {
        throw new Error("Connection refused");
      },
      async return() {
        return { done: true as const, value: undefined };
      },
      async throw(e: unknown) {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    }));

    try {
      await runSDKAgent({ prompt: "test", cwd: "/tmp" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FailoverError);
      expect((err as FailoverError).message).toContain("Connection refused");
    }
  });

  it("logs init event with model, tools, and mcp server status", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "system",
          subtype: "init",
          model: "claude-opus-4-6",
          tools: ["Bash", "Read", "Edit"],
          mcp_servers: [
            { name: "tavily", status: "connected" },
            { name: "serena", status: "failed" },
          ],
          permissionMode: "bypassPermissions",
          slash_commands: [],
          output_style: "concise",
          skills: [],
          plugins: [],
          agents: [],
          apiKeySource: "user",
          claude_code_version: "1.0.0",
          cwd: "/tmp",
          uuid: "u",
          session_id: "s",
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u2",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp" });

    expect(logMock.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "sdk init: model=claude-opus-4-6 tools=3 mcp=tavily:connected,serena:failed",
      ),
    );
  });

  it("logs tool_progress events", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "tool_progress",
          tool_use_id: "tu-1",
          tool_name: "Bash",
          parent_tool_use_id: null,
          elapsed_time_seconds: 5,
          uuid: "u",
          session_id: "s",
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          duration_ms: 6000,
          duration_api_ms: 5500,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u2",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp" });

    expect(logMock.info).toHaveBeenCalledWith("sdk tool: Bash (5s)");
  });

  it("logs tool_use from assistant messages", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "git status" } },
              { type: "tool_use", id: "tu-2", name: "Read", input: { file_path: "/tmp/test" } },
            ],
          },
          session_id: "s",
          uuid: "u",
          parent_tool_use_id: null,
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u2",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp" });

    expect(logMock.info).toHaveBeenCalledWith("sdk tool_use: Bash, Read");
  });

  it("logs hook started and response events", async () => {
    queryMock.mockReturnValueOnce(
      makeAsyncIterable([
        {
          type: "system",
          subtype: "hook_started",
          hook_id: "h1",
          hook_name: "pre-bash",
          hook_event: "PreToolUse",
          uuid: "u",
          session_id: "s",
        },
        {
          type: "system",
          subtype: "hook_response",
          hook_id: "h1",
          hook_name: "pre-bash",
          hook_event: "PreToolUse",
          output: "",
          stdout: "",
          stderr: "",
          exit_code: 0,
          outcome: "success",
          uuid: "u2",
          session_id: "s",
        },
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "u3",
        },
      ]),
    );

    await runSDKAgent({ prompt: "test", cwd: "/tmp" });

    expect(logMock.info).toHaveBeenCalledWith("sdk hook: PreToolUse started");
    expect(logMock.info).toHaveBeenCalledWith("sdk hook: PreToolUse success (exit=0)");
  });
});
