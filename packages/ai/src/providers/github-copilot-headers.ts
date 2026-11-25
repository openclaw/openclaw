// GitHub Copilot header helpers build request headers for Copilot-backed providers.
import type { Message } from "../types.js";
import { projectCopilotRequestFacts } from "./github-copilot-request-facts.js";

export function buildCopilotDynamicHeaders(messages: Message[]): Record<string, string> {
  const { initiator, hasImages } = projectCopilotRequestFacts(messages, "direct");
  const headers: Record<string, string> = {
    "X-Initiator": initiator,
    "Openai-Intent": "conversation-edits",
  };

  if (hasImages) {
    headers["Copilot-Vision-Request"] = "true";
  }

  return headers;
}
