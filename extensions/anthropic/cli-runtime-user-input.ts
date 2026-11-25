import type {
  CliBackendExecuteContext,
  CliBackendInputImage,
} from "openclaw/plugin-sdk/cli-backend";

export function createUserInput(
  context: CliBackendExecuteContext,
  text: string,
  uuid: string,
  hostGenerated = false,
  images: readonly CliBackendInputImage[] = [],
) {
  return {
    type: "user",
    // Same-turn images go to the model as native content blocks; the first prompt uses @paths.
    message: {
      role: "user",
      content: images.length
        ? [
            // Anthropic rejects empty text blocks; an image-only input sends just the images.
            ...(text ? [{ type: "text", text }] : []),
            ...images.map(({ data, mimeType }) => ({
              type: "image",
              source: { type: "base64", media_type: mimeType, data },
            })),
          ]
        : text,
    },
    parent_tool_use_id: null,
    uuid,
    // Claude saves synthetic input as a meta row: the model reads it, history never shows it.
    ...(hostGenerated ? { isSynthetic: true } : {}),
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
  };
}

export function rejectInjectedInputs(
  inputs: Iterable<{ started: { reject(error: Error): void } }>,
  error: Error,
) {
  for (const input of inputs) {
    input.started.reject(error);
  }
}
