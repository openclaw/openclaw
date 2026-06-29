// Core post-turn capture (02-01): durable-id idempotency without runId — replaying
// the same agent_end message array never duplicates turns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { AgentMessage } from "../runtime/index.js";
import { buildCapturedTurns, captureConversationTurns } from "./turns-capture.js";
import { getTurns, listBoxes, listSpans } from "./turns-store.js";

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-turns-capture-"));
}

function turnMessages(): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "set up voice" }], timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "On it." },
        { type: "toolCall", id: "c1", name: "read_file", arguments: {} },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      responseId: "resp-1",
      usage: {} as never,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read_file",
      content: [{ type: "text", text: "body" }],
      isError: false,
      timestamp: 3,
    },
  ] as AgentMessage[];
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("turns-capture", () => {
  it("captures only user/assistant text turns with durable idempotency keys", () => {
    const turns = buildCapturedTurns("agent:main:main", turnMessages());
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]); // toolResult/toolCall skipped
    expect(turns[1]?.content).toBe("On it."); // assistant text extracted, thinking/toolCall excluded
    // idempotency keys are deterministic for the same session + message anchor
    expect(buildCapturedTurns("agent:main:main", turnMessages())[0]?.idempotencyKey).toBe(
      turns[0]?.idempotencyKey,
    );
  });

  it("marks [SILENT] automation turns as suppressed noise", () => {
    const turns = buildCapturedTurns("agent:main:main", [
      { role: "user", content: [{ type: "text", text: "[SILENT] heartbeat" }], timestamp: 9 },
    ] as AgentMessage[]);
    expect(turns[0]?.noiseClass).toBe("suppressed");
  });

  it("is replay-stable WITHOUT runId: re-capturing the same turn appends nothing", () => {
    const env = { OPENCLAW_STATE_DIR: tempStateDir() } as NodeJS.ProcessEnv;
    const opts = { agentId: "main", sessionKey: "agent:main:main", messages: turnMessages(), env };

    expect(captureConversationTurns(opts)).toBe(2); // user + assistant
    expect(captureConversationTurns(opts)).toBe(0); // replay → durable-id dedup, no dupes

    const stored = getTurns({ agentId: "main", sessionKey: "agent:main:main", env });
    expect(stored.map((t) => t.content)).toEqual(["set up voice", "On it."]);
    expect(stored.map((t) => t.seq)).toEqual([1, 2]); // gapless
    expect(listSpans({ agentId: "main", sessionKey: "agent:main:main", env }).length).toBe(2);
    expect(listBoxes({ agentId: "main", sessionKey: "agent:main:main", env }).length).toBe(1);
  });

  it("appends a genuinely new later turn on top of prior capture", () => {
    const env = { OPENCLAW_STATE_DIR: tempStateDir() } as NodeJS.ProcessEnv;
    captureConversationTurns({
      agentId: "main",
      sessionKey: "agent:main:main",
      messages: turnMessages(),
      env,
    });

    const withFollowup = [
      ...turnMessages(),
      { role: "user", content: [{ type: "text", text: "thanks" }], timestamp: 4 },
    ] as AgentMessage[];
    expect(
      captureConversationTurns({
        agentId: "main",
        sessionKey: "agent:main:main",
        messages: withFollowup,
        env,
      }),
    ).toBe(1);

    const stored = getTurns({ agentId: "main", sessionKey: "agent:main:main", env });
    expect(stored.map((t) => t.content)).toEqual(["set up voice", "On it.", "thanks"]);
  });
});
