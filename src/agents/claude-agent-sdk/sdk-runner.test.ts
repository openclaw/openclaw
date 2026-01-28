import { describe, expect, it, vi, beforeEach } from "vitest";

import { runSdkAgent } from "./sdk-runner.js";
import type { SdkRunnerParams } from "./sdk-runner.types.js";

// ---------------------------------------------------------------------------
// Mock the SDK and MCP bridge
// ---------------------------------------------------------------------------

// Mock the Claude Agent SDK loader.
vi.mock("./sdk.js", () => ({
  loadClaudeAgentSdk: vi.fn(),
}));

// Mock the tool bridge (avoid needing a real McpServer).
vi.mock("./tool-bridge.js", () => ({
  bridgeClawdbrainToolsToMcpServer: vi.fn(),
}));

import { loadClaudeAgentSdk } from "./sdk.js";
import { bridgeClawdbrainToolsToMcpServer } from "./tool-bridge.js";

const mockLoadSdk = vi.mocked(loadClaudeAgentSdk);
const mockBridge = vi.mocked(bridgeClawdbrainToolsToMcpServer);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseParams(overrides?: Partial<SdkRunnerParams>): SdkRunnerParams {
  return {
    runId: "test-run-1",
    sessionId: "test-session-1",
    prompt: "Hello, agent!",
    workspaceDir: "/tmp/workspace",
    tools: [],
    ...overrides,
  };
}

function mockBridgeResult() {
  return {
    serverConfig: { type: "sdk" as const, name: "clawdbrain", instance: {} },
    allowedTools: ["mcp__clawdbrain__web_fetch"],
    toolCount: 1,
    registeredTools: ["web_fetch"],
    skippedTools: [],
  };
}

/** Create an async iterable from an array of events. */
async function* eventsFrom<T>(events: T[]): AsyncIterable<T> {
  for (const event of events) {
    yield event;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockBridge.mockResolvedValue(mockBridgeResult());
});

describe("runSdkAgent", () => {
  describe("SDK loading failures", () => {
    it("returns error result when SDK is not installed", async () => {
      mockLoadSdk.mockRejectedValue(new Error("Cannot find module"));

      const result = await runSdkAgent(baseParams());

      expect(result.payloads).toHaveLength(1);
      expect(result.payloads[0].isError).toBe(true);
      expect(result.payloads[0].text).toContain("Claude Agent SDK is not available");
      expect(result.meta.error?.kind).toBe("sdk_unavailable");
    });
  });

  describe("MCP bridge failures", () => {
    it("returns error result when bridge fails", async () => {
      mockLoadSdk.mockResolvedValue({
        query: vi.fn().mockReturnValue(eventsFrom([])),
      });
      mockBridge.mockRejectedValue(new Error("McpServer not found"));

      const result = await runSdkAgent(baseParams());

      expect(result.payloads[0].isError).toBe(true);
      expect(result.payloads[0].text).toContain("Failed to bridge Clawdbrain tools");
      expect(result.meta.error?.kind).toBe("mcp_bridge_failed");
    });
  });

  describe("successful runs", () => {
    it("extracts text from assistant events", async () => {
      const queryFn = vi
        .fn()
        .mockReturnValue(
          eventsFrom([{ type: "message_start" }, { text: "Hello " }, { text: "world!" }]),
        );
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams());

      expect(result.payloads).toHaveLength(1);
      expect(result.payloads[0].text).toBe("Hello\n\nworld!");
      expect(result.meta.eventCount).toBe(3);
      expect(result.meta.extractedChars).toBeGreaterThan(0);
      expect(result.meta.error).toBeUndefined();
    });

    it("prefers terminal result event text", async () => {
      const queryFn = vi
        .fn()
        .mockReturnValue(
          eventsFrom([
            { text: "Partial..." },
            { type: "result", subtype: "success", result: "Final answer." },
          ]),
        );
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams());

      expect(result.payloads[0].text).toBe("Final answer.");
    });

    it("returns no_output error when no text extracted", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "system", data: "started" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams());

      expect(result.payloads[0].text).toContain("no text output");
      expect(result.payloads[0].isError).toBe(true);
      expect(result.meta.error?.kind).toBe("no_output");
    });

    it("deduplicates repeated text chunks", async () => {
      const queryFn = vi.fn().mockReturnValue(
        eventsFrom([
          { text: "Hello" },
          { text: "Hello" }, // duplicate
          { text: "World" },
        ]),
      );
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams());

      expect(result.payloads[0].text).toBe("Hello\n\nWorld");
    });
  });

  describe("callbacks", () => {
    it("calls onPartialReply for each text chunk", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ text: "chunk1" }, { text: "chunk2" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onPartialReply = vi.fn();
      await runSdkAgent(baseParams({ onPartialReply }));

      expect(onPartialReply).toHaveBeenCalledTimes(2);
      expect(onPartialReply).toHaveBeenCalledWith({ text: "chunk1" });
      expect(onPartialReply).toHaveBeenCalledWith({ text: "chunk1\n\nchunk2" });
    });

    it("calls onBlockReply with final text", async () => {
      const queryFn = vi
        .fn()
        .mockReturnValue(eventsFrom([{ type: "result", result: "Final text" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onBlockReply = vi.fn();
      await runSdkAgent(baseParams({ onBlockReply }));

      expect(onBlockReply).toHaveBeenCalledTimes(1);
      expect(onBlockReply).toHaveBeenCalledWith({ text: "Final text" });
    });

    it("calls onToolResult for tool events", async () => {
      const queryFn = vi.fn().mockReturnValue(
        eventsFrom([
          { type: "tool_result", text: "tool output" },
          { type: "result", result: "done" },
        ]),
      );
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onToolResult = vi.fn();
      await runSdkAgent(baseParams({ onToolResult }));

      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onToolResult).toHaveBeenCalledWith({ text: "tool output" });
    });

    it("calls onAssistantMessageStart", async () => {
      const queryFn = vi
        .fn()
        .mockReturnValue(eventsFrom([{ type: "message_start" }, { type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onAssistantMessageStart = vi.fn();
      await runSdkAgent(baseParams({ onAssistantMessageStart }));

      expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    });

    it("calls onAgentEvent for lifecycle events", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "done" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onAgentEvent = vi.fn();
      await runSdkAgent(baseParams({ onAgentEvent }));

      const phases = onAgentEvent.mock.calls
        .map((c) => c[0] as { stream?: string; data?: { phase?: string } })
        .filter((evt) => evt.stream === "lifecycle")
        .map((evt) => evt.data?.phase);
      expect(phases).toContain("start");
      expect(phases).toContain("end");
    });

    it("emits assistant events via onAgentEvent when text is extracted", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ text: "hello" }, { text: "world" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onAgentEvent = vi.fn();
      await runSdkAgent(baseParams({ onAgentEvent }));

      const assistantEvents = onAgentEvent.mock.calls
        .map((c) => c[0] as { stream?: string; data?: { text?: string } })
        .filter((evt) => evt.stream === "assistant");
      expect(assistantEvents.length).toBeGreaterThan(0);
      expect(assistantEvents[0]?.data?.text).toBeDefined();
    });

    it("emits tool lifecycle events via onAgentEvent for tool events", async () => {
      const queryFn = vi.fn().mockReturnValue(
        eventsFrom([
          { type: "tool_execution_start", name: "exec", id: "t1" },
          { type: "tool_result", text: "tool output", id: "t1" },
          { type: "result", result: "done" },
        ]),
      );
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onAgentEvent = vi.fn();
      await runSdkAgent(baseParams({ onAgentEvent }));

      const toolEvents = onAgentEvent.mock.calls
        .map((c) => c[0] as { stream?: string; data?: { phase?: string; name?: string } })
        .filter((evt) => evt.stream === "tool");
      expect(toolEvents.length).toBeGreaterThan(0);
      expect(toolEvents.some((evt) => evt.data?.phase === "start")).toBe(true);
      expect(toolEvents.some((evt) => evt.data?.phase === "result")).toBe(true);
    });

    it("does not break when callback throws", async () => {
      const queryFn = vi
        .fn()
        .mockReturnValue(eventsFrom([{ text: "hello" }, { type: "result", result: "done" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onPartialReply = vi.fn().mockRejectedValue(new Error("callback error"));
      const result = await runSdkAgent(baseParams({ onPartialReply }));

      // Run should still succeed despite callback errors.
      expect(result.payloads[0].text).toBe("done");
    });

    it("does not break when onAgentEvent returns a rejected promise", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onAgentEvent = vi.fn().mockRejectedValue(new Error("event callback error"));
      const result = await runSdkAgent(baseParams({ onAgentEvent }));

      expect(result.payloads[0].text).toBe("ok");
    });
  });

  describe("Claude Code hooks", () => {
    it("passes hook callbacks to the SDK when hooksEnabled is true and emits tool events from hooks", async () => {
      const queryFn = vi.fn().mockImplementation(async (args: any) => {
        const hooks = args?.options?.hooks as any;
        const pre = hooks?.PreToolUse?.[0]?.hooks?.[0];
        const post = hooks?.PostToolUse?.[0]?.hooks?.[0];

        // Simulate a tool run via hooks (what Claude Code would do).
        await pre?.(
          { tool_name: "mcp__clawdbrain__exec", tool_input: { command: "echo hi" } },
          "t1",
          {},
        );
        await post?.(
          {
            tool_name: "mcp__clawdbrain__exec",
            tool_response: { content: [{ type: "text", text: "ok" }] },
          },
          "t1",
          {},
        );

        return eventsFrom([{ type: "result", result: "done" }]);
      });
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const onAgentEvent = vi.fn();
      const onToolResult = vi.fn();
      await runSdkAgent(baseParams({ hooksEnabled: true, onAgentEvent, onToolResult }));

      const toolEvents = onAgentEvent.mock.calls
        .map((c) => c[0] as { stream?: string; data?: { phase?: string; name?: string } })
        .filter((evt) => evt.stream === "tool");
      expect(
        toolEvents.some((evt) => evt.data?.phase === "start" && evt.data?.name === "exec"),
      ).toBe(true);
      expect(
        toolEvents.some((evt) => evt.data?.phase === "result" && evt.data?.name === "exec"),
      ).toBe(true);

      expect(onToolResult).toHaveBeenCalledWith({ text: "ok" });

      const hookEvents = onAgentEvent.mock.calls
        .map((c) => c[0] as { stream?: string; data?: { hookEventName?: string } })
        .filter((evt) => evt.stream === "hook")
        .map((evt) => evt.data?.hookEventName);
      expect(hookEvents).toContain("PreToolUse");
      expect(hookEvents).toContain("PostToolUse");
    });
  });

  describe("SDK options", () => {
    it("passes provider env to SDK options", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      await runSdkAgent(
        baseParams({
          provider: {
            name: "z.AI",
            env: {
              ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
              ANTHROPIC_AUTH_TOKEN: "test-key",
            },
          },
        }),
      );

      const [queryArgs] = queryFn.mock.calls[0] as [{ options?: Record<string, unknown> }];
      const options = queryArgs.options as Record<string, unknown>;
      const env = options.env as Record<string, string>;
      expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("test-key");
    });

    it("passes workspace dir as cwd", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      await runSdkAgent(baseParams({ workspaceDir: "/my/project" }));

      const [queryArgs] = queryFn.mock.calls[0] as [{ options?: Record<string, unknown> }];
      expect((queryArgs.options as Record<string, unknown>).cwd).toBe("/my/project");
    });

    it("disables built-in tools by default", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      await runSdkAgent(baseParams());

      const [queryArgs] = queryFn.mock.calls[0] as [{ options?: Record<string, unknown> }];
      expect((queryArgs.options as Record<string, unknown>).tools).toEqual([]);
    });

    it("enables specified built-in tools", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      await runSdkAgent(baseParams({ builtInTools: ["Read", "Bash"] }));

      const [queryArgs] = queryFn.mock.calls[0] as [{ options?: Record<string, unknown> }];
      const options = queryArgs.options as Record<string, unknown>;
      expect(options.tools).toEqual(["Read", "Bash"]);
      // Built-in tools should be merged into allowedTools.
      expect(options.allowedTools).toEqual(expect.arrayContaining(["Read", "Bash"]));
    });

    it("passes system prompt to SDK options", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      await runSdkAgent(baseParams({ systemPrompt: "You are a test agent." }));

      const [queryArgs] = queryFn.mock.calls[0] as [{ options?: Record<string, unknown> }];
      expect((queryArgs.options as Record<string, unknown>).systemPrompt).toBe(
        "You are a test agent.",
      );
    });

    it("passes maxTurns from provider config", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      await runSdkAgent(baseParams({ provider: { maxTurns: 10 } }));

      const [queryArgs] = queryFn.mock.calls[0] as [{ options?: Record<string, unknown> }];
      expect((queryArgs.options as Record<string, unknown>).maxTurns).toBe(10);
    });
  });

  describe("query errors", () => {
    it("returns error result when query throws", async () => {
      const queryFn = vi.fn().mockImplementation(() => {
        throw new Error("Network error");
      });
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams());

      expect(result.payloads[0].isError).toBe(true);
      expect(result.payloads[0].text).toContain("Network error");
      expect(result.meta.error?.kind).toBe("run_failed");
    });
  });

  describe("metadata", () => {
    it("includes bridge diagnostics in meta", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams());

      expect(result.meta.bridge).toEqual({
        toolCount: 1,
        registeredTools: ["web_fetch"],
        skippedTools: [],
      });
    });

    it("includes provider name in meta", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams({ provider: { name: "z.AI" } }));

      expect(result.meta.provider).toBe("z.AI");
    });

    it("tracks duration", async () => {
      const queryFn = vi.fn().mockReturnValue(eventsFrom([{ type: "result", result: "ok" }]));
      mockLoadSdk.mockResolvedValue({ query: queryFn });

      const result = await runSdkAgent(baseParams());

      expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
