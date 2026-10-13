import { createHash } from "node:crypto";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { ImageContent } from "openclaw/plugin-sdk/llm";

export type CodexComputerContextEpoch = {
  value: number;
  frameToolCallId?: string;
  frameImageIdentity?: string;
};

export function invalidateCodexComputerFrame(contextEpoch: CodexComputerContextEpoch): void {
  contextEpoch.value += 1;
  delete contextEpoch.frameToolCallId;
  delete contextEpoch.frameImageIdentity;
}
export function computerFrameImageIdentity(
  content: AgentToolResult<unknown>["content"] | undefined,
): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const images = content.filter((block): block is ImageContent => block.type === "image");
  if (images.length !== 1) {
    return undefined;
  }
  const image = expectDefined(images[0], "single Codex computer frame image");
  return createHash("sha256")
    .update(JSON.stringify([image.mimeType, image.data]))
    .digest("hex");
}
