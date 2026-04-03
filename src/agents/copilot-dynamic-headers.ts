import type { Context } from "@mariozechner/pi-ai";

function inferCopilotInitiator(messages: Context["messages"]): "agent" | "user" {
  const last = messages[messages.length - 1];
  return last && last.role !== "user" ? "agent" : "user";
}

export function hasCopilotVisionInput(messages: Context["messages"]): boolean {
  return messages.some((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return message.content.some((item) => item.type === "image");
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
      return message.content.some((item) => item.type === "image");
    }
    return false;
  });
}

export function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string> {
  return {
    "X-Initiator": inferCopilotInitiator(params.messages),
    "Openai-Intent": "conversation-edits",
    ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}
