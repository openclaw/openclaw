import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
type StreamModel = Parameters<StreamFn>[0];

export function listedModel(
  key: string,
  max_context_length: number,
  loaded_instances = [{ id: key, config: { context_length: 4096 } }],
) {
  return { models: [{ type: "llm", key, max_context_length, loaded_instances }] };
}

export function streamModel(baseUrl: string, overrides: Partial<StreamModel> = {}): StreamModel {
  return {
    id: "qwen3.5-0.8b",
    name: "Test model",
    provider: "lmstudio",
    api: "openai-completions",
    baseUrl,
    contextWindow: 262144,
    contextTokens: 16384,
    maxTokens: 8192,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

export function messagesTextResponse(text: string): string {
  const events = [
    {
      type: "message_start",
      message: { id: "msg_test", usage: { input_tokens: 11, output_tokens: 0 } },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 17 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
