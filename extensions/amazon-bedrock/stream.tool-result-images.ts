import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";

/** Bedrock routes whose Converse validation rejects `toolResult.content[].image` (#149332, #186753). */
const TOOL_RESULT_IMAGE_REJECTING_MODELS = [
  "openai.gpt-5.6-sol",
  "openai.gpt-6-sol",
  "openai.gpt-6.1-sol",
  "moonshotai.kimi-k3",
];

/**
 * Builds the user content for one tool-result group. Routes that accept user
 * images but reject images nested in tool results get every tool output first,
 * then the lifted images labeled by tool call; stored history is not rewritten.
 */
export function buildBedrockToolResultUserContent(
  modelId: string,
  toolResults: ContentBlock.ToolResultMember[],
): ContentBlock[] {
  if (!TOOL_RESULT_IMAGE_REJECTING_MODELS.some((id) => modelId.includes(id))) {
    return toolResults;
  }
  const attachedImages: ContentBlock[] = [];
  const userContent = toolResults.map((block): ContentBlock => {
    const images: ContentBlock[] = [];
    const content = (block.toolResult.content ?? []).filter((part) => {
      if (part.image) {
        images.push({ image: part.image });
        return false;
      }
      return true;
    });
    if (images.length === 0) {
      return block;
    }
    const label = `Images from tool result ${block.toolResult.toolUseId}`;
    attachedImages.push({ text: `${label}:` }, ...images);
    return {
      toolResult: {
        ...block.toolResult,
        content: [...content, { text: `(see attached images labeled "${label}")` }],
      },
    };
  });
  return [...userContent, ...attachedImages];
}
