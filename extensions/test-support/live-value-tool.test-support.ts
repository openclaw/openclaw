import type { AssistantMessage, Tool } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";

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
