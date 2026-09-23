// Verifies transcript repair preserves sessions_spawn attachments and ACP routing fields.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, it, expect } from "vitest";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

function mkSessionsSpawnToolCall(content: string): AgentMessage {
  // sessions_spawn attachments are transcript-owned payloads, not redaction targets.
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
    timestamp: 0,
  });
}

describe("sanitizeToolCallInputs preserves sessions_spawn payloads", () => {
  it.each([false, true])(
    "scans 1000 signed tool calls once for attachment presence (attached: %s)",
    (attached) => {
      const thinking = {
        type: "thinking",
        thinking: "Replay the completed work.",
        thinkingSignature: "signed-attachment-fixture",
      };
      const calls = Array.from({ length: 1000 }, (_, index) => ({
        type: "toolUse",
        id: `call_${index}`,
        name: "sessions_spawn",
        input: {
          task: `Recorded task ${index}`,
          attachments:
            attached && index === 999
              ? [{ name: "payload.txt", content: "TRANSCRIPT_ATTACHMENT_CONTENT" }]
              : [],
        },
      }));
      const content = [thinking, ...calls];
      const assistant = { role: "assistant", content, timestamp: 0 };
      const input = castAgentMessages([
        assistant,
        ...calls.map(({ id, name }) => ({
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          content: [{ type: "text", text: "Completed" }],
          timestamp: 0,
        })),
      ]);
      const before = JSON.stringify(input);
      const descriptors = calls.map((call) =>
        Object.getOwnPropertyDescriptor(call.input, "attachments")!,
      );
      let attachmentReads = 0;
      // Count real input reads without changing the values or retaining mock-call histories.
      for (const [index, call] of calls.entries()) {
        const descriptor = descriptors[index]!;
        const attachments = call.input.attachments;
        Object.defineProperty(call.input, "attachments", {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            attachmentReads += 1;
            return attachments;
          },
        });
      }
      const out = (() => {
        try {
          return sanitizeToolCallInputs(input, {
            allowedToolNames: ["sessions_spawn"],
            allowProviderOwnedThinkingReplay: true,
          });
        } finally {
          for (const [index, call] of calls.entries()) {
            Object.defineProperty(call.input, "attachments", descriptors[index]!);
          }
        }
      })();

      expect(out).toBe(input);
      expect(out).toStrictEqual(JSON.parse(before));
      expect(out[0]).toBe(assistant);
      expect(assistant.content).toBe(content);
      expect(assistant.content[0]).toBe(thinking);
      expect(JSON.stringify(input)).toBe(before);
      expect(attachmentReads).toBe(1000);
    },
  );

  it.each(["call_spawn", "call_read"])(
    "drops the whole signed attachment turn when sibling %s has no result",
    (missingId) => {
      const assistant = {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Replay attachment work and its sibling.",
            thinkingSignature: "signed-sibling-fixture",
          },
          {
            type: "toolUse",
            id: "call_spawn",
            name: "sessions_spawn",
            input: {
              task: "Inspect attachment",
              attachments: [{ name: "payload.txt", content: "PRESERVED_ATTACHMENT_CONTENT" }],
            },
          },
          { type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } },
        ],
      };
      const result = {
        role: "toolResult",
        toolCallId: missingId === "call_spawn" ? "call_read" : "call_spawn",
        toolName: missingId === "call_spawn" ? "read" : "sessions_spawn",
        content: [{ type: "text", text: "Completed sibling" }],
      };
      const input = castAgentMessages([assistant, result]);
      const before = JSON.stringify(input);
      const out = sanitizeToolCallInputs(input, {
        allowedToolNames: ["sessions_spawn", "read"],
        allowProviderOwnedThinkingReplay: true,
      });

      expect(out).toStrictEqual([result]);
      expect(out[0]).toBe(result);
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it("keeps attachment content in transcript-owned tool calls", () => {
    const content = "LOCAL_ATTACHMENT_CONTENT";
    const input = [mkSessionsSpawnToolCall(content)];
    const out = sanitizeToolCallInputs(input);

    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(content);
  });

  it("keeps attachment content from tool input payloads too", () => {
    const content = "INPUT_ATTACHMENT_CONTENT";
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
              attachments: [{ name: "x.txt", content }],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(content);
  });

  it("keeps non-content attachment payload fields unchanged", () => {
    const nestedValue = "NESTED_ATTACHMENT_VALUE";
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolUse",
            id: "call_3",
            name: "sessions_spawn",
            input: {
              task: "do thing",
              attachments: [
                {
                  name: "payload.json",
                  mimeType: "application/json",
                  encoding: "utf8",
                  data: nestedValue,
                  nested: { value: nestedValue },
                },
              ],
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
    expect(JSON.stringify(out)).toContain(nestedValue);
  });

  it("keeps ACP routing fields unchanged", () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_4",
            name: "sessions_spawn",
            arguments: {
              task: "do thing",
              resumeSessionId: "argument-session",
              streamTo: "parent",
            },
          },
          {
            type: "toolUse",
            id: "call_5",
            name: "sessions_spawn",
            input: {
              task: "do other thing",
              resumeSessionId: "input-session",
              streamTo: "parent",
            },
          },
        ],
      },
    ]);

    const out = sanitizeToolCallInputs(input);
    expect(out).toStrictEqual(input);
  });
});
