import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { sanitizeSessionHistory } from "./replay-history.js";

const ONE_PIXEL_GIF = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";

export async function xaiGifReplayMimes(
  replay: (
    messages: AgentMessage[],
    overrides?: Partial<Parameters<typeof sanitizeSessionHistory>[0]>,
  ) => Promise<AgentMessage[]>,
): Promise<[string, string]> {
  const messages: AgentMessage[] = [
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id: "call_gif", name: "view_image", arguments: {} }],
      model: "grok-4.6",
      stopReason: "toolUse",
      timestamp: 1,
    }),
    {
      role: "toolResult",
      toolCallId: "call_gif",
      toolName: "view_image",
      isError: false,
      content: [{ type: "image", data: ONE_PIXEL_GIF, mimeType: "image/gif" }],
      timestamp: 2,
    } satisfies ToolResultMessage,
  ];
  const mime = async (provider: string | undefined) => {
    const history = await replay(
      messages,
      provider ? { provider, modelApi: "openai-responses", modelId: "grok-4.6" } : {},
    );
    const image = history
      .find((message) => message.role === "toolResult")
      ?.content?.find((block) => block.type === "image");
    return image && "data" in image && image.data.startsWith("/9j/")
      ? "image/jpeg"
      : image && "mimeType" in image
        ? image.mimeType
        : "missing";
  };
  const xai = await mime("xai");
  if ((await mime("x-ai")) !== xai) {
    throw new Error("x-ai replay did not match xai");
  }
  return [await mime(undefined), xai];
}
