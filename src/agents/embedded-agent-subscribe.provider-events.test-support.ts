import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

export type TestAssistant = Pick<AssistantMessage, "role" | "content"> &
  Partial<Pick<AssistantMessage, "api" | "stopReason" | "openclawDelivery">> & {
    phase?: "commentary" | "final_answer";
  };
export function emitProviderUpdate(
  emit: (evt: unknown) => void,
  message: TestAssistant,
  event: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    partial?: TestAssistant;
  },
) {
  emit({ type: "message_update", message, assistantMessageEvent: event });
}
export function textMessage(
  text: string,
  api: "anthropic-messages" | "openai-completions",
): TestAssistant {
  return { ...textAssistant(text), api };
}
export function toolBlock(id: string, name: string) {
  return { type: "toolCall" as const, id, name, arguments: {} };
}
