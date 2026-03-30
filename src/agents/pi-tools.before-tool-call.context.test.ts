import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runBeforeToolCallHook } from "./pi-tools.before-tool-call.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("before_tool_call hook context payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards systemPrompt/messages/tools when available", async () => {
    const runBeforeToolCall = vi.fn().mockResolvedValue(undefined);
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "before_tool_call"),
      runBeforeToolCall,
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any);

    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "check this call" }],
        timestamp: Date.now(),
      },
    ];
    const tools = [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    await runBeforeToolCallHook({
      toolName: "read",
      toolCallId: "tool-call-1",
      params: { path: "/tmp/file" },
      ctx: {
        runId: "run-1",
        getSystemPrompt: () => "You are an assistant.",
        getMessages: () => messages,
        getTools: () => tools,
      },
    });

    expect(runBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        toolCallId: "tool-call-1",
        params: { path: "/tmp/file" },
        runId: "run-1",
        systemPrompt: "You are an assistant.",
        messages,
        tools,
      }),
      expect.objectContaining({
        toolName: "read",
        runId: "run-1",
        toolCallId: "tool-call-1",
      }),
    );
  });
});
