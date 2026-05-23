import type { AssistantMessage, AssistantMessageEvent } from "openclaw/plugin-sdk/llm";

export interface MutableAssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result: () => Promise<AssistantMessage>;
}
