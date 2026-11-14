import type { Context } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import * as hash from "../utils/hash.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import * as fixtures from "./openai-responses-prompt-observer.test-support.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";

const model = fixtures.createReplayModel();
const identity = { sessionId: "session-current", authProfileId: "profile-current" };
const item = {
  type: "reasoning",
  id: "rs_synthetic",
  summary: [],
  encrypted_content: "synthetic-encrypted-state",
};
function history(sessionId: string): Context {
  const reasoning = {
    type: "thinking" as const,
    thinking: "",
    thinkingSignature: JSON.stringify(item),
    openclawReasoningReplay: buildOpenAIResponsesReasoningReplayMetadata(model, {
      ...identity,
      sessionId,
    }),
  };
  return {
    messages: [
      fixtures.createAssistant(model, [
        reasoning,
        { type: "text", text: "The earlier answer." },
        { type: "toolCall", id: "call_echo|fc_echo", name: "echo", arguments: { value: 42 } },
      ]),
      makeTextToolResult("call_echo|fc_echo", "echo", "42", false, 2),
    ],
  };
}

describe.each([
  { name: "transport-owned", convert: convertResponsesMessages },
  { name: "provider-owned", convert: convertProviderResponsesMessages },
])("$name stateless reasoning replay", ({ convert }) => {
  it("hashes assistant fallback IDs only when needed and once per message", () => {
    const hashing = vi.spyOn(hash, "shortHash");
    try {
      const message = fixtures.createAssistant(model, [
        {
          type: "thinking",
          thinking: "reason",
          thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_signed", summary: [] }),
        },
        { type: "text", text: "answer", textSignature: "msg_signed" },
      ]);
      message.responseId = "resp_hash_fixture";
      const providers = new Set(["openai"]);
      const input = convert(model, { messages: [message] }, providers);
      expect(input.at(-1)).toMatchObject({ id: "msg_signed", role: "assistant" });
      expect(
        hashing.mock.calls.filter(([value]) => value.includes("resp_hash_fixture")),
      ).toHaveLength(0);
      message.content.push({ type: "text", text: "unsigned" }, { type: "text", text: "second" });
      for (const replayResponsesItemIds of [true, false]) {
        hashing.mockClear();
        convert(model, { messages: [message] }, providers, { replayResponsesItemIds });
        expect(
          hashing.mock.calls.filter(([value]) => value.includes("resp_hash_fixture")),
        ).toHaveLength(replayResponsesItemIds ? 1 : 0);
      }
    } finally {
      hashing.mockRestore();
    }
  });

  it("omits reasoning that has neither a replay ID nor authorized encrypted state", () => {
    const context = history("session-previous");
    const before = structuredClone(context);
    const input = convert(model, context, new Set(["openai"]), {
      ...identity,
      replayResponsesItemIds: false,
    });
    expect(input.map((entry) => entry.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(input[0]).toMatchObject({
      content: [{ type: "output_text", text: "The earlier answer." }],
    });
    expect(input[1]).toMatchObject({ call_id: "call_echo", arguments: '{"value":42}' });
    expect(input[2]).toMatchObject({ call_id: "call_echo", output: "42" });
    expect(context).toEqual(before);
  });

  it("keeps authorized encrypted reasoning when item IDs are omitted", () => {
    const input = convert(model, history(identity.sessionId), new Set(["openai"]), {
      ...identity,
      replayResponsesItemIds: false,
    });
    expect(input[0]).toEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "synthetic-encrypted-state",
    });
  });

  it("retains reference-based reasoning when item IDs are enabled", () => {
    const input = convert(model, history("session-previous"), new Set(["openai"]), {
      ...identity,
      replayResponsesItemIds: true,
    });
    expect(input[0]).toEqual({ type: "reasoning", id: "rs_synthetic", summary: [] });
  });
});
