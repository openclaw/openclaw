export type PromptImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PromptVideoContent = {
  type: "video";
  data: string;
  mimeType: string;
};

export type PromptMediaContent = PromptImageContent | PromptVideoContent;

export function isPromptImageContent(block: PromptMediaContent): block is PromptImageContent {
  return block.type === "image";
}
