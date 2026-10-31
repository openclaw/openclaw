/**
 * Tool-result image placement for Bedrock Converse requests.
 * AWS documents images inside toolResult.content only for Nova and Claude;
 * other routes (GPT Sol, Kimi) reject them but accept user image blocks.
 */
import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";

/**
 * Moves tool-result images after all tool results as labeled user images. Tool
 * outputs stay contiguous and associated by id; stored history is not rewritten.
 */
export function relocateToolResultImages(
  toolResults: ContentBlock.ToolResultMember[],
): ContentBlock[] {
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
