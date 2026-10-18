import { zstdDecompressSync } from "node:zlib";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderReplayState,
} from "@openclaw/llm-core";
import { createZeroUsage } from "../usage.test-support.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "./openai-responses-compaction-replay.js";
import { OPENAI_RESPONSES_REASONING_REPLAY_META_KEY } from "./openai-responses-contracts.js";

export const SDK_FULL_HISTORY_PREFIX = "full history before compaction";
export const SDK_REASONING_CIPHERTEXT = "opaque-sdk-reasoning";
export const createReplayModel = () =>
  createModel({ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1_000_000 });
export function createReplayState(
  model: Model,
  identity: { sessionId: string; authProfileId: string },
  state: Pick<ProviderReplayState, "type" | "data"> & Partial<ProviderReplayState>,
): ProviderReplayState {
  const { source: _source, ...metadata } = buildOpenAIResponsesReasoningReplayMetadata(
    model,
    identity,
  );
  if (!metadata.baseUrlHash) {
    throw new Error("test model must have a replayable base URL");
  }
  return { ...metadata, ...state };
}

export const responseUsage = { input_tokens: 5, output_tokens: 3, total_tokens: 8 };
export const userMessage = (content: string, timestamp = 1) => ({
  role: "user" as const,
  content,
  timestamp,
});
export const inputMessage = (text: string, role: "user" | "developer" = "user") => ({
  type: "message" as const,
  role,
  content: [{ type: "input_text" as const, text }],
});
export const outputMessage = (text: string, id?: string) => ({
  type: "message" as const,
  role: "assistant" as const,
  status: "completed" as const,
  ...(id ? { id } : {}),
  content: [{ type: "output_text" as const, text, annotations: [] }],
});
export const completedResponse = (id: string, output: unknown[] = [], extra = {}) => ({
  type: "response.completed",
  response: { id, status: "completed", output, ...extra },
});
export async function* responseEvents(...events: Record<string, unknown>[]) {
  yield* events;
}
export function sseResponse(events: unknown[], headers: Record<string, string> = {}) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}
export async function requestBody(init?: RequestInit): Promise<Record<string, unknown>> {
  const raw = Buffer.from(await new Response(init?.body).arrayBuffer());
  return JSON.parse(
    (new Headers(init?.headers).get("content-encoding") === "zstd"
      ? zstdDecompressSync(raw)
      : raw
    ).toString(),
  );
}
export function createAssistant(
  model: Model,
  content: string | AssistantMessage["content"] = [],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

export function completedSdkResponse(responseId: string): {
  data: AsyncIterable<unknown>;
  response: Response;
} {
  return {
    data: responseEvents(completedResponse(responseId, [], { usage: responseUsage })),
    response: new Response(null, { status: 200 }),
  };
}

export function createCompactionContext(
  model: Model,
  identity: { authProfileId: string; sessionId: string },
  includeReasoning = false,
): Context {
  const prior = createAssistant(
    model,
    includeReasoning
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
    { timestamp: 1 },
  );
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
    messages: [userMessage(SDK_FULL_HISTORY_PREFIX, 0), prior, userMessage("continue", 2)],
  };
}

export function createOrphanedToolOutputCompactionContext(
  model: Model,
  identity: { authProfileId: string; sessionId: string },
): Context {
  const callId = "call_compacted";
  const prior = createAssistant(
    model,
    [{ type: "toolCall", id: callId, name: "lookup", arguments: {} }],
    { timestamp: 1 },
  );
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
      userMessage(SDK_FULL_HISTORY_PREFIX, 0),
      prior,
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "lookup",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 2,
      },
      userMessage("continue", 3),
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
