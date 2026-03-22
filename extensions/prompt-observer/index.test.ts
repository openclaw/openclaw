import { beforeEach, describe, expect, it, vi } from "vitest";
import register from "./index.js";

type TestApi = {
  pluginConfig: Record<string, unknown>;
  config: Record<string, unknown>;
  id: string;
  name: string;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
};

function createTestApi(pluginConfig: Record<string, unknown> = {}): TestApi {
  return {
    pluginConfig,
    config: { hooks: { internal: { enabled: true } } },
    id: "prompt-observer",
    name: "Prompt Observer",
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    on: vi.fn(),
    registerHook: vi.fn(),
  };
}

function getTypedHook(api: TestApi, hookName: string): (...args: unknown[]) => unknown {
  const call = api.on.mock.calls.find(([name]) => name === hookName);
  if (!call?.[1]) {
    throw new Error(`missing typed hook ${hookName}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

function getInternalHook(api: TestApi, eventName: string): (...args: unknown[]) => unknown {
  const call = api.registerHook.mock.calls.find(([name]) => name === eventName);
  if (!call?.[1]) {
    throw new Error(`missing internal hook ${eventName}`);
  }
  return call[1] as (...args: unknown[]) => unknown;
}

function parseLoggedPayload(api: TestApi, callIndex = 0): Record<string, unknown> {
  const message = api.logger.info.mock.calls[callIndex]?.[0];
  if (typeof message !== "string") {
    throw new Error("expected JSON log payload");
  }
  return JSON.parse(message) as Record<string, unknown>;
}

describe("prompt-observer plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers bootstrap, llm_input, and tool hooks by default", () => {
    const api = createTestApi();
    register.register(api as never);

    expect(api.registerHook).toHaveBeenCalledWith(
      "agent:bootstrap",
      expect.any(Function),
      expect.objectContaining({
        name: "prompt-observer-bootstrap-files",
      }),
    );
    expect(api.on).toHaveBeenCalledWith("llm_input", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("after_tool_call", expect.any(Function));
    expect(api.on).not.toHaveBeenCalledWith("llm_output", expect.any(Function));
  });

  it("logs bootstrap files and correlates them into llm_input output", () => {
    const api = createTestApi({
      mode: "full",
      maxCharsPerField: 200,
      maxHistoryMessages: 2,
    });
    register.register(api as never);

    const bootstrapHook = getInternalHook(api, "agent:bootstrap");
    bootstrapHook({
      type: "agent",
      action: "bootstrap",
      context: {
        workspaceDir: "/tmp/workspace",
        bootstrapFiles: [{ path: "SOUL.md" }, { path: "tone_skills.md" }],
        sessionId: "session-1",
        sessionKey: "telegram:ops",
        agentId: "sophia",
      },
    });

    const llmInputHook = getTypedHook(api, "llm_input");
    llmInputHook(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "openai",
        model: "gpt-5",
        systemPrompt: `system sk-abcdefghijklmnopqrstuvwxyz0123456789 ${"with a lot more text that should truncate ".repeat(8)}`,
        prompt: `prompt sk-abcdefghijklmnopqrstuvwxyz0123456789 ${"with a lot more text that should truncate ".repeat(8)}`,
        historyMessages: [
          { role: "system", content: "old system" },
          { role: "user", content: "user one" },
          { role: "assistant", content: "assistant two" },
        ],
        imagesCount: 1,
      },
      {
        agentId: "sophia",
        sessionId: "session-1",
        sessionKey: "telegram:ops",
        trigger: "user",
        channelId: "telegram",
      },
    );

    expect(api.logger.info).toHaveBeenCalledTimes(2);

    const bootstrapPayload = parseLoggedPayload(api, 0);
    expect(bootstrapPayload).toMatchObject({
      event: "prompt_observer.bootstrap_files",
      bootstrapFiles: ["SOUL.md", "tone_skills.md"],
      sessionId: "session-1",
      sessionKey: "telegram:ops",
      agentId: "sophia",
    });

    const llmInputPayload = parseLoggedPayload(api, 1);
    expect(llmInputPayload).toMatchObject({
      event: "prompt_observer.llm_input",
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "telegram:ops",
      agentId: "sophia",
      trigger: "user",
      channelId: "telegram",
      provider: "openai",
      model: "gpt-5",
      imagesCount: 1,
      bootstrapFiles: ["SOUL.md", "tone_skills.md"],
    });
    expect(llmInputPayload.systemPromptChars).toBeGreaterThan(200);
    expect(llmInputPayload.promptChars).toBeGreaterThan(200);
    expect((llmInputPayload.systemPrompt as string) || "").toContain("sk-abc");
    expect((llmInputPayload.systemPrompt as string) || "").toContain("truncated");
    expect((llmInputPayload.prompt as string) || "").toContain("truncated");
    expect(llmInputPayload.history).toMatchObject({
      count: 3,
      roleCounts: {
        system: 1,
        user: 1,
        assistant: 1,
      },
    });
    expect(llmInputPayload.historyMessages).toEqual([
      { role: "user", content: "user one" },
      { role: "assistant", content: "assistant two" },
    ]);
  });

  it("filters tool events by configured tool names and logs sanitized results", () => {
    const api = createTestApi({
      mode: "full",
      toolNames: ["memory_search"],
      maxCharsPerField: 30,
    });
    register.register(api as never);

    const beforeToolHook = getTypedHook(api, "before_tool_call");
    const afterToolHook = getTypedHook(api, "after_tool_call");

    beforeToolHook(
      {
        toolName: "web_search",
        params: { query: "ignored" },
        runId: "run-1",
        toolCallId: "call-1",
      },
      {
        toolName: "web_search",
        runId: "run-1",
        toolCallId: "call-1",
        sessionId: "session-1",
        sessionKey: "session-key",
        agentId: "sophia",
      },
    );

    afterToolHook(
      {
        toolName: "memory_search",
        params: { query: "release plan" },
        runId: "run-1",
        toolCallId: "call-2",
        durationMs: 42,
        result: {
          results: [
            {
              path: "MEMORY.md",
              snippet:
                "sk-abcdefghijklmnopqrstuvwxyz0123456789 very long snippet that should be truncated",
            },
          ],
        },
      },
      {
        toolName: "memory_search",
        runId: "run-1",
        toolCallId: "call-2",
        sessionId: "session-1",
        sessionKey: "session-key",
        agentId: "sophia",
      },
    );

    expect(api.logger.info).toHaveBeenCalledTimes(1);
    const payload = parseLoggedPayload(api, 0);
    expect(payload).toMatchObject({
      event: "prompt_observer.after_tool_call",
      toolName: "memory_search",
      runId: "run-1",
      toolCallId: "call-2",
      durationMs: 42,
      sessionId: "session-1",
      sessionKey: "session-key",
      agentId: "sophia",
      params: {
        query: "release plan",
      },
    });
    const result = payload.result as { results?: Array<{ snippet?: string }> };
    expect(result.results?.[0]?.snippet).toContain("sk-abc");
    expect(result.results?.[0]?.snippet).toContain("truncated");
  });

  it("registers llm_output only when explicitly enabled", () => {
    const api = createTestApi({
      includeLlmOutput: true,
    });
    register.register(api as never);

    expect(api.on).toHaveBeenCalledWith("llm_output", expect.any(Function));
  });
});
