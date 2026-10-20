import { describe, it, expect } from "vitest";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

const thinking = {
  type: "thinking",
  thinking: "Replay completed work.",
  thinkingSignature: "signed-fixture",
};
const attachments = [{ name: "payload.txt", content: "TRANSCRIPT_ATTACHMENT_CONTENT" }];
const toolResult = (toolCallId: string, toolName: string) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text: "Completed" }],
  timestamp: 0,
});

describe("sanitizeToolCallInputs preserves sessions_spawn payloads", () => {
  it("scans 1000 signed tool calls once for attachment presence", () => {
    const calls = Array.from({ length: 1000 }, (_, index) => ({
      type: "toolUse",
      id: `call_${index}`,
      name: "sessions_spawn",
      input: {
        task: `Recorded task ${index}`,
        attachments: index === 999 ? attachments : [],
      },
    }));
    const content = [thinking, ...calls];
    const assistant = { role: "assistant", content, timestamp: 0 };
    const input = castAgentMessages([
      assistant,
      ...calls.map(({ id, name }) => toolResult(id, name)),
    ]);
    const before = JSON.stringify(input);
    const descriptors = calls.map((call) =>
      Object.getOwnPropertyDescriptor(call.input, "attachments")!,
    );
    let attachmentReads = 0;
    // Count real input reads without changing the values or retaining mock-call histories.
    for (const [index, call] of calls.entries()) {
      const descriptor = descriptors[index]!;
      const value = call.input.attachments;
      Object.defineProperty(call.input, "attachments", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
          attachmentReads += 1;
          return value;
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
  });

  it("drops the whole signed attachment turn when the read sibling has no result", () => {
    const assistant = {
      role: "assistant",
      content: [
        thinking,
        {
          type: "toolUse",
          id: "call_spawn",
          name: "sessions_spawn",
          input: {
            task: "Inspect attachment",
            attachments,
          },
        },
        { type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } },
      ],
    };
    const result = toolResult("call_spawn", "sessions_spawn");
    const input = castAgentMessages([assistant, result]);
    const before = JSON.stringify(input);
    const out = sanitizeToolCallInputs(input, {
      allowedToolNames: ["sessions_spawn", "read"],
      allowProviderOwnedThinkingReplay: true,
    });

    expect(out).toStrictEqual([result]);
    expect(out[0]).toBe(result);
    expect(JSON.stringify(input)).toBe(before);
  });
});
