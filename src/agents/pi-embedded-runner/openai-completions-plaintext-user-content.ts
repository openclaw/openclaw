/**
 * Some OpenAI-compatible chat backends (e.g. strict text-only gateways) reject
 * user messages whose `content` is a multimodal array like
 * `[{ type: "text", text: "..." }]` and only accept a plain string. Pi's
 * openai-completions adapter always uses the array form when the in-memory
 * user message uses structured parts.
 *
 * When the configured model does not declare image input, flatten those
 * payloads to a single string before the HTTP request.
 *
 * @see https://github.com/openclaw/openclaw/issues/38902
 */
export function flattenOpenAiCompletionsTextOnlyUserContentInPayload(
  payload: Record<string, unknown>,
  model: {
    api?: unknown;
    input?: unknown;
    provider?: unknown;
    id?: unknown;
  },
): void {
  if (model.api !== "openai-completions") {
    return;
  }
  const input = model.input;
  if (Array.isArray(input) && input.includes("image")) {
    return;
  }
  // OpenRouter Anthropic routes rely on per-part cache_control breakpoints; keep arrays.
  if (
    model.provider === "openrouter" &&
    typeof model.id === "string" &&
    model.id.startsWith("anthropic/")
  ) {
    return;
  }

  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const role = (msg as { role?: unknown }).role;
    if (role !== "user") {
      continue;
    }
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) {
      continue;
    }
    const textPieces: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        textPieces.length = 0;
        break;
      }
      const p = part as { type?: unknown; text?: unknown };
      if (p.type !== "text" || typeof p.text !== "string") {
        textPieces.length = 0;
        break;
      }
      textPieces.push(p.text);
    }
    if (textPieces.length === 0) {
      continue;
    }
    (msg as { content: unknown }).content = textPieces.join("\n");
  }
}
