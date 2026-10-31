import { it, expect } from "vitest";
import { sanitizeToolCallInputs } from "./session-transcript-repair.js";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

const thinking = {
  type: "thinking",
  thinking: "Replay completed work.",
  thinkingSignature: "signed-fixture",
};
const attachments = [{ name: "payload.txt", content: "TRANSCRIPT_ATTACHMENT_CONTENT" }];
const spawn = (id: string, input: object) => ({
  type: "toolUse",
  id,
  name: "sessions_spawn",
  input,
});
const toolResult = (toolCallId: string, toolName = "sessions_spawn") => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text: "Completed" }],
  timestamp: 0,
});
const sanitize = (
  input: ReturnType<typeof castAgentMessages>,
  allowedToolNames = ["sessions_spawn"],
) => sanitizeToolCallInputs(input, { allowedToolNames, allowProviderOwnedThinkingReplay: true });

it("scans 1000 signed tool calls once for attachment presence", () => {
  let attachmentReads = 0;
  const calls = Array.from({ length: 1000 }, (_, index) => {
    const value = index === 999 ? attachments : [];
    return spawn(`call_${index}`, {
      task: `Recorded task ${index}`,
      get attachments() {
        attachmentReads += 1;
        return value;
      },
    });
  });
  const content = [thinking, ...calls];
  const assistant = { role: "assistant", content, timestamp: 0 };
  const input = castAgentMessages([
    assistant,
    ...calls.map(({ id, name }) => toolResult(id, name)),
  ]);
  const before = JSON.stringify(input);
  attachmentReads = 0;
  const out = sanitize(input);
  expect(attachmentReads).toBe(1000);
  expect(out).toBe(input);
  expect(out).toStrictEqual(JSON.parse(before));
  expect(out[0]).toBe(assistant);
  expect(assistant.content).toBe(content);
  expect(assistant.content[0]).toBe(thinking);
  expect(JSON.stringify(input)).toBe(before);
});

it("drops the whole signed attachment turn when the read sibling has no result", () => {
  const assistant = {
    role: "assistant",
    content: [
      thinking,
      spawn("call_spawn", { task: "Inspect attachment", attachments }),
      { type: "toolCall", id: "call_read", name: "read", arguments: { path: "README.md" } },
    ],
  };
  const result = toolResult("call_spawn");
  const input = castAgentMessages([assistant, result]);
  const before = JSON.stringify(input);
  const out = sanitize(input, ["sessions_spawn", "read"]);
  expect(out).toStrictEqual([result]);
  expect(out[0]).toBe(result);
  expect(JSON.stringify(input)).toBe(before);
});
