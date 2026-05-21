import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { sanitizeCodexRuntimeContextHistoryMessages } from "./session-history.js";

describe("Codex mirrored session history", () => {
  it("removes stale OpenClaw runtime context from user text while preserving the request", () => {
    const result = sanitizeCodexRuntimeContextHistoryMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "OpenClaw runtime context for this turn:",
              "supporting context",
              "",
              "Current user request:",
              "please fix the failing test",
            ].join("\n"),
          },
        ],
        timestamp: Date.now(),
      },
    ] as AgentMessage[]);

    expect(result.sanitizedRuntimeContextUserMessages).toBe(1);
    expect(result.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "please fix the failing test" }],
        timestamp: expect.any(Number),
      },
    ]);
  });

  it("replaces runtime-only history entries that do not contain a user request marker", () => {
    const result = sanitizeCodexRuntimeContextHistoryMessages([
      {
        role: "user",
        content: "OpenClaw runtime context for this turn:\nworkspace memory only",
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: "normal assistant history",
      },
    ] as unknown as AgentMessage[]);

    expect(result.sanitizedRuntimeContextUserMessages).toBe(1);
    expect((result.messages[0] as { content?: unknown } | undefined)?.content).toBe(
      "[codex mirrored history] omitted stale OpenClaw runtime context from prior user turn",
    );
    expect((result.messages[1] as { content?: unknown } | undefined)?.content).toBe(
      "normal assistant history",
    );
  });
});
