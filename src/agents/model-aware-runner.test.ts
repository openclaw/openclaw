import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const runEmbeddedPiAgentMock = vi.hoisted(() => vi.fn());
const runCliAgentMock = vi.hoisted(() => vi.fn());

vi.mock("./pi-embedded.js", () => ({
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("./cli-runner.js", () => ({
  runCliAgent: (params: unknown) => runCliAgentMock(params),
}));

import { runModelAwareAgent } from "./model-aware-runner.js";

describe("runModelAwareAgent", () => {
  const baseParams = {
    sessionId: "session-1",
    sessionFile: "/tmp/oc-session.jsonl",
    workspaceDir: "/tmp/oc-workspace",
    prompt: "hello",
    timeoutMs: 5_000,
    runId: "run-1",
  };

  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
    runCliAgentMock.mockReset();
  });

  it("routes non-CLI providers to runEmbeddedPiAgent", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [{ text: "embedded-ok" }] });

    const result = await runModelAwareAgent({
      ...baseParams,
      provider: "openai",
      model: "gpt-4.1-mini",
      config: {},
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(result).toEqual({ payloads: [{ text: "embedded-ok" }] });
  });

  it("routes CLI providers to runCliAgent and maps streaming callbacks", async () => {
    runCliAgentMock.mockImplementation(async (params: Record<string, unknown>) => {
      (params.onAssistantTurn as ((text: string) => void) | undefined)?.("assistant text");
      (
        (params.onThinkingTurn as
          | ((payload: { text: string; delta?: string }) => void)
          | undefined) ?? (() => {})
      )({
        text: "thinking text",
        delta: "delta",
      });
      (
        (params.onToolUseEvent as
          | ((payload: { name: string; toolUseId?: string; input?: unknown }) => void)
          | undefined) ?? (() => {})
      )({
        name: "web_search",
        toolUseId: "tool_1",
        input: { q: "openclaw" },
      });
      (
        (params.onToolResult as
          | ((payload: { toolUseId?: string; text?: string; isError?: boolean }) => void)
          | undefined) ?? (() => {})
      )({
        toolUseId: "tool_1",
        text: "tool done",
      });
      return { payloads: [{ text: "cli-ok" }] };
    });

    const onPartialReply = vi.fn();
    const onReasoningStream = vi.fn();
    const onToolResult = vi.fn();
    const onAgentEvent = vi.fn();

    const result = await runModelAwareAgent({
      ...baseParams,
      provider: "claude-cli",
      model: "opus",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
              },
            },
          },
        },
      } as OpenClawConfig,
      messageProvider: "feishu",
      disableTools: true,
      extraSystemPrompt: "BASE_SYSTEM",
      onPartialReply,
      onReasoningStream,
      onToolResult,
      onAgentEvent,
    });

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    const cliCallArg = runCliAgentMock.mock.calls[0]?.[0] as
      | { messageChannel?: string; extraSystemPrompt?: string; disableTools?: boolean }
      | undefined;
    expect(cliCallArg?.messageChannel).toBe("feishu");
    expect(cliCallArg?.disableTools).toBe(true);
    expect(cliCallArg?.extraSystemPrompt).toContain("BASE_SYSTEM");
    expect(cliCallArg?.extraSystemPrompt).toContain("Tools are disabled in this session.");

    expect(onPartialReply).toHaveBeenCalledWith({ text: "assistant text" });
    expect(onReasoningStream).toHaveBeenCalledWith({ text: "thinking text" });
    expect(onToolResult).toHaveBeenCalledWith({ text: "tool done", toolCallId: "tool_1" });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "assistant",
      data: { text: "assistant text", delta: "assistant text" },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "thinking",
      data: { text: "thinking text", delta: "delta" },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      data: {
        phase: "start",
        name: "web_search",
        toolUseId: "tool_1",
        input: { q: "openclaw" },
      },
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      data: {
        phase: "result",
        toolUseId: "tool_1",
        result: "tool done",
        partialResult: "tool done",
      },
    });
    expect(result).toEqual({ payloads: [{ text: "cli-ok" }] });
  });

  it("suppresses split NO_REPLY fragments from CLI partial output", async () => {
    runCliAgentMock.mockImplementation(async (params: Record<string, unknown>) => {
      const onAssistantTurn = params.onAssistantTurn as ((text: string) => void) | undefined;
      onAssistantTurn?.("NO");
      onAssistantTurn?.("_REPLY");
      onAssistantTurn?.("Actual answer");
      return { payloads: [{ text: "cli-ok" }] };
    });

    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn();

    await runModelAwareAgent({
      ...baseParams,
      provider: "claude-cli",
      model: "opus",
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
              },
            },
          },
        },
      } as OpenClawConfig,
      onPartialReply,
      onAgentEvent,
    });

    expect(onPartialReply).toHaveBeenCalledTimes(1);
    expect(onPartialReply).toHaveBeenCalledWith({ text: "Actual answer" });
    expect(onAgentEvent).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "assistant",
      data: { text: "Actual answer", delta: "Actual answer" },
    });
  });
});
