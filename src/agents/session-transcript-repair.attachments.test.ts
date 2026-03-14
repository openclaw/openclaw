import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, it, expect } from "vitest";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

function mkSessionsSpawnToolCall(content: string): AgentMessage {
  return castAgentMessage({
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
  });
}

describe("sanitizeToolCallInputs redacts sessions_spawn attachments", () => {
  it("replaces attachments[].content with __OPENCLAW_REDACTED__", () => {
    const secret = "SUPER_SECRET_SHOULD_NOT_PERSIST"; // pragma: allowlist secret
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
    const secret = "INPUT_SECRET_SHOULD_NOT_PERSIST"; // pragma: allowlist secret
    const input = castAgentMessages([
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
    ]);

    const out = sanitizeToolCallInputs(input);
    const msg = out[0] as { content?: unknown[] };
    const tool = (msg.content?.[0] ?? null) as {
      // Some providers emit tool calls as `input`/`toolUse`. We normalize to `toolCall` with `arguments`.
      input?: { attachments?: Array<{ content?: string }> };
      arguments?: { attachments?: Array<{ content?: string }> };
    } | null;
    expect(
      tool?.input?.attachments?.[0]?.content || tool?.arguments?.attachments?.[0]?.content,
    ).toBe("__OPENCLAW_REDACTED__");
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("redacts sessions_spawn attachments even in the last assistant message with thinking blocks", () => {
    const secret = "THINKING_SPAWN_SECRET_MUST_REDACT"; // pragma: allowlist secret
    const input = castAgentMessages([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "some reasoning" },
          {
            type: "toolUse",
            id: "call_spawn",
            name: "sessions_spawn",
            input: {
              task: "do thing",
              attachments: [{ name: "secret.txt", content: secret }],
            },
          },
          { type: "text", text: "done" },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toHaveLength(2);

    const assistant = out[1] as { content?: unknown[] };
    const types = (assistant.content as Array<{ type: string }>).map((b) => b.type);
    // All blocks must be preserved (thinking message structure stays intact)
    expect(types).toEqual(["thinking", "toolUse", "text"]);

    // But the attachment content must be redacted
    const tool = (assistant.content as unknown[])[1] as {
      input?: { attachments?: Array<{ content?: string }> };
      arguments?: { attachments?: Array<{ content?: string }> };
    };
    expect(
      tool?.input?.attachments?.[0]?.content || tool?.arguments?.attachments?.[0]?.content,
    ).toBe("__OPENCLAW_REDACTED__");
    expect(JSON.stringify(out)).not.toContain(secret);
  });
});
