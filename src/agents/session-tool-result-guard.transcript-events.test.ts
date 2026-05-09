import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { SessionManager } from "./transcript/session-transcript-contract.js";

const listeners: Array<() => void> = [];

afterEach(() => {
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
});

describe("guardSessionManager transcript updates", () => {
  it("includes the session key when broadcasting appended non-tool-result messages", () => {
    const updates: SessionTranscriptUpdate[] = [];
    listeners.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const sm = SessionManager.inMemory();
    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionId: "worker",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello from subagent" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      agentId: "main",
      sessionId: "worker",
      sessionKey: "agent:main:worker",
      message: {
        role: "assistant",
      },
    });
    expect(updates[0]?.transcriptLocator).toBeUndefined();
  });
});
