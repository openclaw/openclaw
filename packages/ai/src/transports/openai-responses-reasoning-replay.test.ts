import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };

function createAssistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
  };
}

const responseConverters = [
  {
    name: "transport-owned",
    convert: (context: Context) =>
      convertResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
  {
    name: "provider-owned",
    convert: (context: Context) =>
      convertProviderResponsesMessages(model, context, new Set(["openai"]), replayIdentity),
  },
] as const;

describe("OpenAI Responses reasoning replay", () => {
  it.each(responseConverters)(
    "$name omits function item ids when preceding reasoning has no rs_* identity",
    ({ convert }) => {
      for (const id of [undefined, null, 42, "msg_wrong"]) {
        const input = convert({
          messages: [
            createAssistant([
              {
                type: "thinking",
                thinking: "",
                thinkingSignature: JSON.stringify({ type: "reasoning", id, summary: [] }),
              },
              { type: "toolCall", id: "call_probe|fc_probe", name: "probe", arguments: {} },
            ]),
          ],
        });
        expect(input.find((item) => item.type === "function_call")).toEqual({
          type: "function_call",
          call_id: "call_probe",
          name: "probe",
          arguments: "{}",
        });
      }
    },
  );

  it.each(responseConverters)(
    "$name omits orphan function item ids without changing paired transcript ids",
    ({ convert }) => {
      const reasoning = {
        type: "thinking" as const,
        thinking: "",
        thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_tool", summary: [] }),
        openclawReasoningReplay: buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
      };
      const toolCall = {
        type: "toolCall" as const,
        id: "call_one|fc_one",
        name: "probe",
        arguments: { input: "synthetic" },
      };
      const context: Context = {
        messages: [
          createAssistant([
            reasoning,
            { type: "text", text: "Before calls" },
            toolCall,
            { type: "text", text: "Between calls" },
            { ...toolCall, id: "call_two|fc_two" },
          ]),
          {
            role: "toolResult",
            toolCallId: "call_one|fc_one",
            toolName: "probe",
            content: [{ type: "text", text: "Done" }],
            isError: false,
            timestamp: 1,
          },
          createAssistant([{ ...toolCall, id: "call_orphan|fc_orphan" }]),
          createAssistant([
            { ...reasoning, thinkingSignature: "malformed" },
            { ...toolCall, id: "call_invalid|fc_invalid" },
          ]),
          createAssistant([{ ...toolCall, id: "call_late|fc_late" }, reasoning]),
        ],
      };
      const original = structuredClone(context);
      const input = convert(context);
      expect(input.filter((item) => item.type === "function_call")).toEqual([
        {
          type: "function_call",
          id: "fc_one",
          call_id: "call_one",
          name: "probe",
          arguments: '{"input":"synthetic"}',
        },
        {
          type: "function_call",
          id: "fc_two",
          call_id: "call_two",
          name: "probe",
          arguments: '{"input":"synthetic"}',
        },
        {
          type: "function_call",
          call_id: "call_orphan",
          name: "probe",
          arguments: '{"input":"synthetic"}',
        },
        {
          type: "function_call",
          call_id: "call_invalid",
          name: "probe",
          arguments: '{"input":"synthetic"}',
        },
        {
          type: "function_call",
          call_id: "call_late",
          name: "probe",
          arguments: '{"input":"synthetic"}',
        },
      ]);
      expect(input.find((item) => item.type === "function_call_output")).toMatchObject({
        call_id: "call_one",
        output: "Done",
      });
      expect(context).toEqual(original);
    },
  );

  it.each(responseConverters)(
    "$name preserves encrypted reasoning and removes bare orphan tails after payload preparation",
    ({ convert }) => {
      for (const encryptedContent of [undefined, null, "", "synthetic-completed-reasoning"]) {
        const item = {
          type: "reasoning",
          id: "rs_standalone",
          summary: [],
          ...(encryptedContent === undefined ? {} : { encrypted_content: encryptedContent }),
        };
        const block = {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: JSON.stringify(item),
          openclawReasoningReplay: buildOpenAIResponsesReasoningReplayMetadata(
            model,
            replayIdentity,
          ),
        };
        const input = convert({ messages: [createAssistant([block])] });
        expect(input).toEqual(encryptedContent ? [item] : []);

        const paired = convert({
          messages: [createAssistant([block, { type: "text", text: "Following answer" }])],
        });
        expect(paired.map((entry) => entry.type)).toEqual(["reasoning", "message"]);
      }
    },
  );

  it.each(responseConverters)(
    "$name removes standalone reasoning when replay identity strips its ciphertext",
    ({ name, convert }) => {
      const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
      const item = {
        type: "reasoning",
        id: "rs_foreign",
        summary: [],
        encrypted_content: "synthetic-foreign-reasoning",
      };
      for (const replayMetadata of [
        undefined,
        null,
        { ...metadata, v: 2 },
        { ...metadata, provider: "other-provider" },
        { ...metadata, model: "other-model" },
        { ...metadata, baseUrlHash: "other-endpoint" },
        { ...metadata, sessionHash: "other-session" },
        { ...metadata, authProfileHash: "other-auth" },
      ]) {
        const block = {
          type: "thinking" as const,
          thinking: "",
          thinkingSignature: JSON.stringify(item),
          ...(replayMetadata === undefined ? {} : { openclawReasoningReplay: replayMetadata }),
        };
        const input = convert({ messages: [createAssistant([block])] });
        const preservesUnattributed = name === "provider-owned" && replayMetadata === undefined;
        expect(input).toEqual(preservesUnattributed ? [item] : []);
      }
    },
  );
});
