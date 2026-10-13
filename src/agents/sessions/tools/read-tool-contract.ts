import type { ImageContent, TextContent } from "../../../llm/types.js";
import type { ReadToolDetails } from "./tool-contracts.js";

export function createReadToolDetails(
  content: (TextContent | ImageContent)[],
  textDetails?: Extract<ReadToolDetails, { kind: "text" | "truncated" }>,
): ReadToolDetails {
  const text = content.find((part): part is TextContent => part.type === "text")?.text ?? "";
  const image = content.find((part): part is ImageContent => part.type === "image");
  if (image) {
    return { kind: "image", content: text, mimeType: image.mimeType };
  }
  if (textDetails) {
    return textDetails;
  }
  return { kind: "text", content: text };
}
