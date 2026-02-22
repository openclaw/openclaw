import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, it, expect } from "vitest";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";

function mkSessionsSpawnToolCall(content: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_1",
        name: "sessions_spawn",
        arguments: {
          task: "do thing",
          attachments: [
            {
              name: "README.md",
              encoding: "utf8",
              content,
            },
          ],
        },
      },
    ],
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

describe("sanitizeToolCallInputs redacts sessions_spawn attachments", () => {
  it("replaces attachments[].content with __OPENCLAW_REDACTED__", () => {
    const secret = "SUPER_SECRET_SHOULD_NOT_PERSIST";
    const input = [mkSessionsSpawnToolCall(secret)];
    const out = sanitizeToolCallInputs(input);
    expect(out).toHaveLength(1);
    const msg = out[0] as { content?: unknown[] };
    const tool = (msg.content?.[0] ?? null) as {
      name?: string;
      arguments?: { attachments?: Array<{ content?: string }> };
    } | null;
    expect(tool?.name).toBe("sessions_spawn");
    expect(tool?.arguments?.attachments?.[0]?.content).toBe("__OPENCLAW_REDACTED__");
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("redacts attachments content from tool input payloads too", () => {
    const secret = "INPUT_SECRET_SHOULD_NOT_PERSIST";
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_2",
            name: "sessions_spawn",
            input: {
              task: "do thing",
              attachments: [{ name: "x.txt", content: secret }],
            },
          },
        ],
      },
    ] as unknown as AgentMessage[];

    const out = sanitizeToolCallInputs(input);
    const msg = out[0] as { content?: unknown[] };
    const tool = (msg.content?.[0] ?? null) as {
      // Some providers emit tool calls as `input`/`toolUse`. We normalize to `toolCall` with `arguments`.
      input?: { attachments?: Array<{ content?: string }> };
      arguments?: { attachments?: Array<{ content?: string }> };
    } | null;
    expect(tool?.arguments?.attachments?.[0]?.content).toBe("__OPENCLAW_REDACTED__");
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});
