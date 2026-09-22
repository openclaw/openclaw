import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexProjectedImageGroup } from "./context-engine-projection.js";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import type { CodexUserInput } from "./protocol.js";

/** Builds ordered Codex user input for both new turns and same-turn steering. */
export function buildCodexUserInput(
  text: string | undefined,
  images?: EmbeddedRunAttemptParams["images"],
  contextImageGroups?: CodexProjectedImageGroup[],
): CodexUserInput[] {
  if (text !== undefined && contextImageGroups?.length) {
    let offset = 0;
    const input = contextImageGroups.flatMap((group) => {
      const parts = buildCodexUserInput(text.slice(offset, group.end), group.images);
      offset = group.end;
      return parts;
    });
    return [...input, ...buildCodexUserInput(text.slice(offset), images)];
  }
  const imageInputs = (images ?? []).map((image): CodexUserInput => {
    const imageUrl = sanitizeInlineImageDataUrl(`data:${image.mimeType};base64,${image.data}`);
    return imageUrl
      ? { type: "image", url: imageUrl }
      : {
          type: "text",
          text: invalidInlineImageText("codex user input"),
          text_elements: [],
        };
  });
  const textInput: CodexUserInput[] =
    text === undefined ? [] : [{ type: "text", text, text_elements: [] }];
  return [...textInput, ...imageInputs];
}
