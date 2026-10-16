import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../../../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { convertResponsesMessages } from "../../../../packages/ai/src/transports/openai-responses-replay-internal.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { sanitizeOpenAIResponsesReplayForStream } from "./attempt-tool-call-replay-sanitization.js";

const model = {
  id: "gpt-5.2",
  name: "GPT-5.2",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 400_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const identity = { sessionId: "compaction-replay-test", authProfileId: "test-profile" };

function createCheckpointOwner(rawId: string, replayIndex: number): AssistantMessage {
  const owner: AssistantMessage = {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsageFixture(),
    stopReason: "toolUse",
    timestamp: 1,
    content: [
      ...(replayIndex > 0 ? [{ type: "text" as const, text: "covered owner prefix" }] : []),
      { type: "toolCall", id: rawId, name: "lookup", arguments: {} },
    ],
  };
  captureOpenAIResponsesCompaction(
    owner,
    { type: "compaction", id: "cmp_test", encrypted_content: "synthetic-checkpoint" },
    replayIndex,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, identity),
  );
  return owner;
}

describe("OpenAI compaction replay through the stream sanitizer", () => {
  it.each([
    { rawId: "call_lookup|fc_lookup", replayIndex: 0, hasResult: true },
    { rawId: "call_lookup|fc_lookup", replayIndex: 1, hasResult: true },
    { rawId: "functions.lookup:0|fc_lookup", replayIndex: 0, hasResult: true },
    { rawId: "functions.lookup:0|fc_lookup", replayIndex: 1, hasResult: true },
    { rawId: "call_lookup|fc_lookup", replayIndex: 0, hasResult: false },
  ])(
    "replays the checkpoint and repaired tool pair for $rawId at $replayIndex (result: $hasResult)",
    ({ rawId, replayIndex, hasResult }) => {
      const owner = createCheckpointOwner(rawId, replayIndex);
      const messages: Context["messages"] = [
        { role: "user", content: "covered source history", timestamp: 0 },
        owner,
        ...(hasResult
          ? [
              {
                role: "toolResult" as const,
                toolCallId: rawId,
                toolName: "lookup",
                content: [{ type: "text" as const, text: "ready" }],
                isError: false,
                timestamp: 2,
              },
            ]
          : []),
      ];
      const sanitized = sanitizeOpenAIResponsesReplayForStream(messages);
      const replayMessages = sanitized.map((message) => {
        if (
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult"
        ) {
          return message;
        }
        throw new Error(`Unexpected provider replay role: ${message.role}`);
      });
      const input = convertResponsesMessages(
        model,
        { messages: replayMessages },
        new Set(["openai"]),
        identity,
      );

      expect(sanitized[1]).toMatchObject({ providerReplay: owner.providerReplay });
      expect(input).toEqual([
        { type: "compaction", id: "cmp_test", encrypted_content: "synthetic-checkpoint" },
        {
          type: "function_call",
          call_id: expect.stringMatching(/^call_[A-Za-z0-9_-]+$/),
          name: "lookup",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: expect.stringMatching(/^call_[A-Za-z0-9_-]+$/),
          output: hasResult ? "ready" : "aborted",
        },
      ]);
      expect(input[1]?.type === "function_call" && input[1].call_id).toBe(
        input[2]?.type === "function_call_output" && input[2].call_id,
      );
      expect(owner.content.at(-1)).toMatchObject({ id: rawId });
    },
  );
});
