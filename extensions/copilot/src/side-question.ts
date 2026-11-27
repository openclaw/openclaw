import {
  normalizeUsage,
  type AgentHarnessSideQuestionParamsV2,
  type AgentHarnessSideQuestionResult,
  type AgentHarnessSideQuestionRequest,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ImageContent, Message } from "openclaw/plugin-sdk/llm";
import { runCopilotIsolatedCompletion } from "./isolated-completion.js";
import type { CopilotClientPool } from "./runtime.js";

function buildSideQuestionMessage(
  messages: Message[],
  question: string,
  images: ImageContent[],
): AgentHarnessSideQuestionRequest {
  const requestImages: NonNullable<AgentHarnessSideQuestionRequest["images"]> = [];
  const attach = (image: ImageContent) => {
    const displayName = `context-image-${requestImages.length + 1}`;
    requestImages.push({ ...image, displayName });
    return `[Attached image: ${displayName}]`;
  };
  const history = messages.map((message) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((part) => {
              if (part.type === "text") {
                return part.text;
              }
              if (part.type === "image") {
                return attach(part);
              }
              return [];
            })
            .join("\n");
    return `${message.role === "assistant" ? "Assistant" : "User"}:\n${text}`;
  });
  return {
    prompt: [
      "Use this sanitized conversation history as background context only.",
      "<conversation_history>",
      ...history,
      "</conversation_history>",
      question,
      ...images.map(attach),
    ].join("\n\n"),
    images: requestImages,
  };
}

export async function runCopilotSideQuestion(
  params: AgentHarnessSideQuestionParamsV2,
  getPool: () => Promise<CopilotClientPool>,
): Promise<AgentHarnessSideQuestionResult> {
  params.hostCapabilities.assertActive();
  if (!params.prepareIsolatedSideQuestion) {
    throw new Error("[copilot] Update OpenClaw to use native Copilot side questions.");
  }
  const prepared = await params.prepareIsolatedSideQuestion();
  params.hostCapabilities.assertActive();
  if (prepared.kind === "handled") {
    return prepared.result;
  }
  const result = await runCopilotIsolatedCompletion(
    prepared.params,
    getPool,
    buildSideQuestionMessage(prepared.messages, prepared.params.prompt, prepared.images),
    prepared.prepareRequest,
  );
  const assistant = result.assistant;
  if (
    (assistant.stopReason !== "stop" && assistant.stopReason !== "length") ||
    assistant.content.some((part) => part.type !== "text" && part.type !== "thinking")
  ) {
    throw new Error("[copilot] Side question did not return a tool-free answer.");
  }
  const text = assistant.content
    .flatMap((part) => (part.type === "text" ? part.text : []))
    .join("")
    .trim();
  if (!text) {
    throw new Error("[copilot] Side question returned no visible answer.");
  }
  return {
    text,
    usage: normalizeUsage(assistant.usage),
  };
}
