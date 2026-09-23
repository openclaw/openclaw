import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexProjectedImageGroup } from "./context-engine-projection.js";
import { invalidInlineImageText, sanitizeInlineImageDataUrl } from "./image-payload-sanitizer.js";
import type { CodexUserInput } from "./protocol.js";

function prependHistoryProvenance(
  input: CodexUserInput[],
  historyProvenancePrefix: string | undefined,
): CodexUserInput[] {
  if (!historyProvenancePrefix) {
    return input;
  }
  const firstTextIndex = input.findIndex((item) => item.type === "text");
  if (firstTextIndex === -1) {
    return [{ type: "text", text: historyProvenancePrefix, text_elements: [] }, ...input];
  }
  return input.map((item, index) =>
    index === firstTextIndex && item.type === "text"
      ? { ...item, text: `${historyProvenancePrefix}${item.text}` }
      : item,
  );
}

/** Builds ordered Codex user input for both new turns and same-turn steering. */
export function buildCodexUserInput(
  text: string | undefined,
  images?: EmbeddedRunAttemptParams["images"],
  contextImageGroups?: CodexProjectedImageGroup[],
  historyProvenancePrefix?: string,
): CodexUserInput[] {
  if (text !== undefined && contextImageGroups?.length) {
    let offset = 0;
    const input = contextImageGroups.flatMap((group) => {
      const parts = buildCodexUserInput(text.slice(offset, group.end), group.images);
      offset = group.end;
      return parts;
    });
    return prependHistoryProvenance(
      [...input, ...buildCodexUserInput(text.slice(offset), images)],
      historyProvenancePrefix,
    );
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
  return prependHistoryProvenance([...textInput, ...imageInputs], historyProvenancePrefix);
}
