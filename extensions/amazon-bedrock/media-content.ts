import { type ContentBlock, ImageFormat } from "@aws-sdk/client-bedrock-runtime";
import {
  sanitizeSurrogates,
  type Context,
  type ProviderContext,
  type ToolResultMessage,
} from "openclaw/plugin-sdk/llm";
import { canonicalizeBase64 } from "openclaw/plugin-sdk/media-runtime";
import { describeToolResultMediaPlaceholder } from "openclaw/plugin-sdk/provider-transport-runtime";

export function bedrockContextMessages(context: ProviderContext): Context["messages"] {
  return context.messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }
    return {
      ...message,
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((block) =>
              block.type === "video"
                ? { type: "text", text: "(video omitted: provider does not support native video)" }
                : block,
            ),
    };
  });
}

export function convertTextImageContent(
  blocks: ToolResultMessage["content"],
  skipEmptyImages: boolean,
): Array<ContentBlock.TextMember | ContentBlock.ImageMember> {
  const content: Array<ContentBlock.TextMember | ContentBlock.ImageMember> = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ text: sanitizeSurrogates(block.text) });
      continue;
    }
    if (
      block.type === "image" &&
      (!skipEmptyImages || describeToolResultMediaPlaceholder([block]))
    ) {
      content.push({ image: createImageBlock(block.mimeType, block.data) });
    }
  }
  return content;
}

const BEDROCK_IMAGE_FORMATS = new Map<string, ImageFormat>([
  ["image/jpeg", ImageFormat.JPEG],
  ["image/jpg", ImageFormat.JPEG],
  ["image/png", ImageFormat.PNG],
  ["image/gif", ImageFormat.GIF],
  ["image/webp", ImageFormat.WEBP],
]);

function createImageBlock(mimeType: string, data: string) {
  const format = BEDROCK_IMAGE_FORMATS.get(mimeType);
  if (!format) {
    throw new Error(`Unknown image type: ${mimeType}`);
  }

  return {
    source: {
      bytes: decodeBedrockBase64(data, "Amazon Bedrock image content has malformed base64"),
    },
    format,
  };
}

export function decodeBedrockBase64(data: string, errorMessage: string): Uint8Array {
  // Validate before portable decoding so browser runtimes keep working without leaking atob errors.
  const canonicalBase64 = canonicalizeBase64(data);
  if (!canonicalBase64) {
    throw new Error(errorMessage);
  }
  const binaryString = atob(canonicalBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
