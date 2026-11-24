export type OpenAiCompatibleVideoPayload = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
      reasoning_content?: string;
    };
  }>;
};

export function resolveMediaUnderstandingString(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

export function coerceOpenAiCompatibleVideoText(
  payload: OpenAiCompatibleVideoPayload,
): string | null {
  const message = payload.choices?.[0]?.message;
  if (!message) {
    return null;
  }
  const text = Array.isArray(message.content)
    ? message.content
        .map((part) => part.text?.trim() ?? "")
        .filter(Boolean)
        .join("\n")
    : message.content;
  return (
    (typeof text === "string" && text.trim()) ||
    (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) ||
    null
  );
}

export function buildOpenAiCompatibleVideoRequestBody(params: {
  model: string;
  prompt: string;
  mime: string;
  buffer: Buffer;
}) {
  return {
    model: params.model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: params.prompt },
          {
            type: "video_url",
            video_url: {
              url: `data:${params.mime};base64,${params.buffer.toString("base64")}`,
            },
          },
        ],
      },
    ],
  };
}
