import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "./embedded-agent-helpers.js";
import {
  castAgentMessages,
  makeAgentAssistantMessage,
} from "./test-helpers/agent-message-fixtures.js";

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: {} });
const assistant = (
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
) => makeAgentAssistantMessage({ content, model: "gpt-5.4", ...overrides });
const replay = {
  v: 1,
  type: "openai-responses-compaction",
  data: "opaque-checkpoint",
  replayIndex: 1,
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.4",
} as const;

describe("sanitizeSessionMessagesImages", () => {
  it("sanitizes legacy tool-use IDs alongside tool-call IDs", async () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call_abc|item:123", name: "test", input: {} },
          call("call_abc|item:456"),
        ],
      },
      { role: "toolResult", toolUseId: "call_abc|item:123", content: [text("ok")] },
    ]);
    expect(
      await sanitizeSessionMessagesImages(input, "test", {
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
      }),
    ).toEqual([
      {
        role: "assistant",
        content: [
          { type: "toolUse", id: "callabcitem123", name: "test", input: {} },
          call("callabcitem456"),
        ],
      },
      { ...input[1], toolUseId: "callabcitem123", toolCallId: "callabcitem123" },
    ]);
  });

  it("reindexes checkpoints after dropping empty text without inventing tool input", async () => {
    const message = assistant([text(""), call("call_1")], { providerReplay: replay });
    expect(await sanitizeSessionMessagesImages([message], "test")).toEqual([
      { ...message, content: [call("call_1")], providerReplay: { ...replay, replayIndex: 0 } },
    ]);
  });

  it("strips an exact checkpoint when its owner content becomes empty", async () => {
    const message = assistant([text("")], { providerReplay: { ...replay, replayIndex: 0 } });
    expect(await sanitizeSessionMessagesImages([message], "test")).toEqual([
      { ...message, content: [], providerReplay: undefined },
    ]);
  });

  it.each(["error"] as const)("preserves an opaque replay owner after %s", async (stopReason) => {
    const message = assistant([text("")], {
      stopReason,
      providerReplay: { ...replay, type: "opaque-checkpoint", replayIndex: undefined },
    });
    expect(await sanitizeSessionMessagesImages([message], "test")).toEqual([
      { ...message, content: [] },
    ]);
  });

  it("drops empty assistant turns while preserving the user turn", async () => {
    const user = { role: "user" as const, content: "hello", timestamp: 0 };
    expect(
      await sanitizeSessionMessagesImages(
        [user, assistant([text(" ")]), assistant([], { stopReason: "error" })],
        "test",
      ),
    ).toEqual([user]);
  });

  it.each([{ visible: "", expected: "[empty content omitted]" }])(
    "keeps user and tool-result content nonempty: $visible",
    async ({ visible, expected }) => {
      const input = castAgentMessages([
        { role: "user", content: [text(""), text(visible)] },
        { role: "toolResult", toolCallId: "tool-1", content: [text("   "), text(visible)] },
      ]);
      expect(await sanitizeSessionMessagesImages(input, "test")).toEqual([
        { ...input[0], content: [text(expected)] },
        { ...input[1], content: [text(expected)] },
      ]);
    },
  );

  it("strips message-id signatures but retains provider signatures", async () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          { ...text("hello"), thought_signature: "msg_abc123" },
          { type: "thinking", thinking: "reasoning", thought_signature: "AQID" },
        ],
      },
    ]);
    expect(await sanitizeSessionMessagesImages(input, "test")).toEqual([
      {
        role: "assistant",
        content: [
          text("hello"),
          { type: "thinking", thinking: "reasoning", thought_signature: "AQID" },
        ],
      },
    ]);
  });

  it("applies explicit signature policy in images-only mode", async () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal", thought_signature: "msg_abc123" },
          text(" "),
          text("visible"),
        ],
      },
    ]);
    expect(
      await sanitizeSessionMessagesImages(input, "test", {
        sanitizeMode: "images-only",
        sanitizeThoughtSignatures: { allowBase64Only: true, includeCamelCase: true },
      }),
    ).toEqual([
      { role: "assistant", content: [{ type: "thinking", thinking: "internal" }, text("visible")] },
    ]);
  });

  it("preserves signed thinking order when removing empty text", async () => {
    const first = { type: "thinking", thinking: "first", thought_signature: "sig-1" };
    const redacted = { type: "redacted_thinking", data: "opaque", thought_signature: "sig-2" };
    const input = castAgentMessages([
      { role: "assistant", content: [first, text(""), text("visible"), redacted, text("tail")] },
    ]);
    expect(
      await sanitizeSessionMessagesImages(input, "test", { preserveSignatures: true }),
    ).toEqual([{ role: "assistant", content: [first, text("visible"), redacted, text("tail")] }]);
  });
});

describe("sanitizeGoogleTurnOrdering", () => {
  it("prepends a user turn before assistant-first history", () => {
    const message = assistant([call("call_1")]);
    expect(sanitizeGoogleTurnOrdering([message])).toEqual([
      expect.objectContaining({ role: "user" }),
      message,
    ]);
  });
});
