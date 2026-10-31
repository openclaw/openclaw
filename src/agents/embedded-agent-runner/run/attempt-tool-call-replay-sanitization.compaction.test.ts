import type { Context } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../../../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { convertResponsesMessages } from "../../../../packages/ai/src/transports/openai-responses-replay-internal.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./attempt-tool-call-replay-sanitization.js";

const model = makeProviderModelFixture<"openai-responses">({
  id: "gpt-5.2",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
});
const identity = { sessionId: "compaction-replay-test", authProfileId: "test-profile" };
const providers = new Set(["openai"]);

function createCheckpointOwner(rawId: string, replayIndex: number) {
  const owner = makeAgentAssistantMessage({
    model: model.id,
    stopReason: "toolUse",
    timestamp: 1,
    content: [
      ...(replayIndex > 0 ? [{ type: "text" as const, text: "covered owner prefix" }] : []),
      { type: "toolCall", id: rawId, name: "lookup", arguments: {} },
    ],
  });
  captureOpenAIResponsesCompaction(
    owner,
    { type: "compaction", id: "cmp_test", encrypted_content: "synthetic-checkpoint" },
    replayIndex,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, identity),
  );
  return owner;
}

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
    ];
    if (hasResult) {
      messages.push({
        role: "toolResult",
        toolCallId: rawId,
        toolName: "lookup",
        content: [{ type: "text", text: "ready" }],
        isError: false,
        timestamp: 2,
      });
    }
    let sanitized = messages;
    const wrapped = wrapStreamFnSanitizeMalformedToolCalls((_model, context) => {
      sanitized = context.messages as Context["messages"];
      return undefined as never;
    });
    void wrapped(model, { messages });
    const replay = sanitized.filter(
      (message) =>
        message.role === "user" || message.role === "assistant" || message.role === "toolResult",
    );
    expect(replay).toHaveLength(sanitized.length);
    const input = convertResponsesMessages(model, { messages: replay }, providers, identity);
    const callId = expect.stringMatching(/^call_[A-Za-z0-9_-]+$/);

    expect(sanitized[1]).toMatchObject({ providerReplay: owner.providerReplay });
    expect(input).toEqual([
      { type: "compaction", id: "cmp_test", encrypted_content: "synthetic-checkpoint" },
      { type: "function_call", call_id: callId, name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: callId, output: hasResult ? "ready" : "aborted" },
    ]);
    expect(input[1]?.type === "function_call" && input[1].call_id).toBe(
      input[2]?.type === "function_call_output" && input[2].call_id,
    );
    expect(owner.content.at(-1)).toMatchObject({ id: rawId });
  },
);
