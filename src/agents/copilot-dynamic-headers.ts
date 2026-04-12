import type { Context } from "@mariozechner/pi-ai";

export const COPILOT_EDITOR_VERSION = "vscode/1.96.2";
export const COPILOT_USER_AGENT = "GitHubCopilotChat/0.26.7";
export const COPILOT_GITHUB_API_VERSION = "2025-04-01";

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

export function buildCopilotIdeHeaders(
  params: {
    includeApiVersion?: boolean;
  } = {},
): Record<string, string> {
  return {
    "Editor-Version": COPILOT_EDITOR_VERSION,
    "User-Agent": COPILOT_USER_AGENT,
    ...(params.includeApiVersion ? { "X-Github-Api-Version": COPILOT_GITHUB_API_VERSION } : {}),
  };
}

export function buildCopilotDynamicHeaders(params: {
  messages: Context["messages"];
  hasImages: boolean;
}): Record<string, string> {
  return {
    ...buildCopilotIdeHeaders(),
    "X-Initiator": inferCopilotInitiator(params.messages),
    "Openai-Intent": "conversation-edits",
    ...(params.hasImages ? { "Copilot-Vision-Request": "true" } : {}),
  };
}
