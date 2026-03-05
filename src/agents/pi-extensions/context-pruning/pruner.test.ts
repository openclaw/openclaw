import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "./pruner.js";
import { DEFAULT_CONTEXT_PRUNING_SETTINGS } from "./settings.js";

function makeAssistantMsg(content: unknown[]): AgentMessage {
  return { role: "assistant", content } as unknown as AgentMessage;
}

function makeToolResultMsg(content: unknown[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "exec",
    content,
  } as unknown as AgentMessage;
}

const defaultCtx = { model: { contextWindow: 100_000 } };

describe("pruneContextMessages — malformed content blocks", () => {
  it("does not crash on assistant message with malformed thinking block (missing thinking string)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as unknown as AgentMessage,
      makeAssistantMsg([{ type: "thinking" }, { type: "text", text: "ok" }]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS, softTrimRatio: 0 },
        ctx: defaultCtx,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with null content entry", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as unknown as AgentMessage,
      makeAssistantMsg([null, { type: "text", text: "ok" }]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS, softTrimRatio: 0 },
        ctx: defaultCtx,
      }),
    ).not.toThrow();
  });

  it("does not crash on toolResult with malformed text block (missing text string)", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as unknown as AgentMessage,
      makeAssistantMsg([{ type: "text", text: "calling tool" }]),
      makeToolResultMsg([{ type: "text" }]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS, softTrimRatio: 0 },
        ctx: defaultCtx,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with text block missing text string", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" } as unknown as AgentMessage,
      makeAssistantMsg([{ type: "text" }]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS, softTrimRatio: 0 },
        ctx: defaultCtx,
      }),
    ).not.toThrow();
  });
});
