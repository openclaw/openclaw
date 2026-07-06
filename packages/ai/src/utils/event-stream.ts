/** Assistant message event stream implementation. */
import { AssistantMessageEventStream } from "@openclaw/llm-core/event-stream";
import type { Model } from "../types.js";

export * from "@openclaw/llm-core/event-stream";

export function createMissingApiKeyStream(model: Model<any>): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const output = {
    role: "assistant" as const,
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage: `No API key for provider: ${model.provider}`,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
  });
  return stream;
}
