import type { AssistantMessage } from "../types.js";

export function appendTextDeltaToAssistantMessage(
  message: AssistantMessage,
  contentIndex: number,
  delta: string,
): AssistantMessage {
  const content = [...message.content];
  const currentContent = content[contentIndex];
  content[contentIndex] =
    currentContent?.type === "text"
      ? { ...currentContent, text: currentContent.text + delta }
      : { type: "text", text: delta };
  return { ...message, content };
}
