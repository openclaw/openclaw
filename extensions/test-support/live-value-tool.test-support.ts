import type { AssistantMessage, Tool } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { makeTextToolResult, makeUserMessage } from "./message-fixtures.test-support.js";

export function createLiveValueTool(name: string): Tool {
  return {
    name,
    description: "Return the supplied value.",
    parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
  };
}

export function requireLiveToolCall(message: AssistantMessage, missingCallPrefix: string) {
  const toolCall = message.content.find((block) => block.type === "toolCall");
  if (toolCall?.type !== "toolCall") {
    throw new Error(`${missingCallPrefix}${message.stopReason}`);
  }
  return toolCall;
}

export function createLiveToolReplayContext(
  user: ReturnType<typeof makeUserMessage>,
  first: AssistantMessage,
  toolCall: ReturnType<typeof requireLiveToolCall>,
  tool: Tool,
) {
  return {
    messages: [
      user,
      first,
      makeTextToolResult(toolCall.id, toolCall.name, "ok", false, Date.now() - 1),
      makeUserMessage("Reply with exactly: ok", Date.now()),
    ],
    tools: [tool],
  };
}
