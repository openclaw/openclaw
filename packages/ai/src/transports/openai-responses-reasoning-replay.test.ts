import type { AssistantMessage, Context } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";

const model = createModel({
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  contextWindow: 1_000_000,
});
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };
const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
const thinking = (item: object) => ({
  type: "thinking" as const,
  thinking: "",
  thinkingSignature: JSON.stringify(item),
});

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
              thinking({ type: "reasoning", id, summary: [] }),
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
        ...thinking({ type: "reasoning", id: "rs_tool", summary: [] }),
        openclawReasoningReplay: metadata,
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
      expect(input.filter((item) => item.type === "function_call")).toEqual(
        ["one", "two", "orphan", "invalid", "late"].map((suffix, index) =>
          Object.assign(
            {
              type: "function_call",
              call_id: `call_${suffix}`,
              name: "probe",
              arguments: '{"input":"synthetic"}',
            },
            index < 2 ? { id: `fc_${suffix}` } : {},
          ),
        ),
      );
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
          ...thinking(item),
          openclawReasoningReplay: metadata,
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
          ...thinking(item),
          ...(replayMetadata === undefined ? {} : { openclawReasoningReplay: replayMetadata }),
        };
        const input = convert({ messages: [createAssistant([block])] });
        const preservesUnattributed = name === "provider-owned" && replayMetadata === undefined;
        expect(input).toEqual(preservesUnattributed ? [item] : []);
      }
    },
  );
});
