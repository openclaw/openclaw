import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

describe("guardSessionManager integration", () => {
  let savedAbortMode: string | undefined;

  beforeEach(() => {
    savedAbortMode = process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE;
    delete process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE;
  });

  afterEach(() => {
    if (savedAbortMode === undefined) {
      delete process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE;
    } else {
      process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE = savedAbortMode;
    }
  });

  it("persists synthetic toolResult before subsequent assistant message", () => {
    // In synthetic mode, explicitly flushing produces a synthetic toolResult for
    // the pending call_1. The followup assistant message is then written directly.
    process.env.OPENCLAW_TOOL_GUARD_ABORT_MODE = "synthetic";
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    // Explicitly flush in synthetic mode before appending the followup message.
    // A new turn without flushing would discard the incomplete pair in the default
    // (discard) mode; explicit flush with synthetic mode produces the synthetic result.
    sm.flushPendingToolResults?.();
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "followup" }],
    } as AgentMessage);

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: AgentMessage }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(sanitizeToolUseResultPairing(messages).map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });
});
