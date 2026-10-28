import type { AssistantMessage, Context } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import { buildOpenAIResponsesReasoningReplayMetadata } from "./openai-responses-compaction-replay.js";
import * as fixtures from "./openai-responses-prompt-observer.test-support.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";

const model = fixtures.createReplayModel();
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };
const metadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
const thinking = (item: object) => ({
  type: "thinking" as const,
  thinking: "",
  thinkingSignature: JSON.stringify(item),
});

const createAssistant = (content: AssistantMessage["content"]) =>
  fixtures.createAssistant(model, content);

const converter = (convert: typeof convertResponsesMessages) => (context: Context) =>
  convert(model, context, new Set(["openai"]), replayIdentity);
const responseConverters = [
  { name: "transport-owned", convert: converter(convertResponsesMessages) },
  { name: "provider-owned", convert: converter(convertProviderResponsesMessages) },
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
          makeTextToolResult("call_one|fc_one", "probe", "Done", false, 1),
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
        const block = { ...thinking(item), openclawReasoningReplay: metadata };
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
