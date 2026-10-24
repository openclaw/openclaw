import type { AssistantMessage } from "../types.js";
import { AssistantMessageEventStream } from "./event-stream.js";

export function assistantStream(content: AssistantMessage["content"]) {
  const message: AssistantMessage = {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "synthetic",
    model: "stream-fixture",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return { message, stream: new AssistantMessageEventStream() };
}

export async function collect<T>(stream: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
