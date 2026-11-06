import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { ReadToolDetails } from "./sessions/tools/index.js";

type ImageContentBlock = Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>;

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // session runtime uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

export async function normalizeReadImageResult(
  result: AgentToolResult<ReadToolDetails>,
  filePath: string,
): Promise<AgentToolResult<ReadToolDetails>> {
  const content = result.content;
  const image = content.find((block): block is ImageContentBlock => block.type === "image");
  if (!image) {
    return result;
  }

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) {
    return result;
  }

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) {
    return result;
  }

  const nextContent = content.map((block) => {
    if (block.type === "image") {
      return Object.assign({}, block, { mimeType: sniffed });
    }
    if (block.type === "text") {
      return Object.assign({}, block, { text: rewriteReadImageHeader(block.text, sniffed) });
    }
    return block;
  });

  return { ...result, content: nextContent };
}
