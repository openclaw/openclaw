import type { Api, AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { createZeroUsage } from "../usage.test-support.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "./openai-responses-compaction-replay.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_META_KEY } from "./openai-responses-contracts.js";

export const SDK_FULL_HISTORY_PREFIX = "full history before compaction";
export const SDK_REASONING_CIPHERTEXT = "opaque-sdk-reasoning";

export function completedSdkResponse(responseId: string): {
  data: AsyncIterable<unknown>;
  response: Response;
} {
  return {
    data: (async function* () {
      yield {
        type: "response.completed",
        response: {
          id: responseId,
          status: "completed",
          output: [],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      };
    })(),
    response: new Response(null, { status: 200 }),
  };
}

export function createCompactionContext(
  model: Model,
  identity: { authProfileId: string; sessionId: string },
  includeReasoning = false,
): Context {
  const prior: AssistantMessage = {
    role: "assistant",
    content: includeReasoning
      ? [
          {
            type: "thinking",
            thinking: "prior reasoning",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_sdk_retry",
              encrypted_content: SDK_REASONING_CIPHERTEXT,
              summary: [],
              [OPENAI_RESPONSES_REASONING_REPLAY_META_KEY]:
                buildOpenAIResponsesReasoningReplayMetadata(model, identity),
            }),
          },
        ]
      : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
  captureOpenAIResponsesCompaction(
    prior,
    {
      type: "compaction",
      id: "cmp_azure_rejected",
      encrypted_content: "opaque-azure-compaction",
    },
    0,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, identity),
  );
  return {
    systemPrompt: "PRIVATE-AZURE-RECOVERY-PROMPT",
    messages: [
      { role: "user", content: SDK_FULL_HISTORY_PREFIX, timestamp: 0 },
      prior,
      { role: "user", content: "continue", timestamp: 2 },
    ],
  };
}

export function createOrphanedToolOutputCompactionContext(
  model: Model,
  identity: { authProfileId: string; sessionId: string },
): Context {
  const callId = "call_compacted";
  const prior: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: callId, name: "lookup", arguments: {} }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
  captureOpenAIResponsesCompaction(
    prior,
    { type: "compaction", id: "cmp_orphaned_output", encrypted_content: "opaque-compaction" },
    1,
    model,
    buildOpenAIResponsesReasoningReplayMetadata(model, identity),
  );
  return {
    systemPrompt: "PRIVATE-ORPHANED-OUTPUT-RECOVERY-PROMPT",
    messages: [
      { role: "user", content: SDK_FULL_HISTORY_PREFIX, timestamp: 0 },
      prior,
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "lookup",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      },
      { role: "user", content: "continue", timestamp: 3 },
    ],
  };
}

export function createModel<TApi extends Api = "openai-responses">(
  overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } as Model<TApi>;
}

export function createContext(systemPrompt: string, overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt,
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools: [],
    ...overrides,
  } as Context;
}
