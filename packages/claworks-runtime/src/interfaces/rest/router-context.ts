export function extractReplyText(
  output: Record<string, unknown> | undefined | null,
): string | null {
  if (!output) return null;
  if (typeof output.text === "string") return output.text;
  if (typeof output.reply === "string") return output.reply;
  if (typeof output.message === "string") return output.message;
  return null;
}

export function extractEventSessionAndText(
  body: Record<string, unknown>,
  payload: Record<string, unknown>,
): { sessionId: string | null; text: string | null } {
  const sessionRaw = payload.session_id ?? payload.sessionId ?? body.session_id ?? body.sessionId;
  const textRaw =
    payload.text ?? payload.message ?? payload.content ?? body.text ?? body.message ?? body.content;
  const sessionId = typeof sessionRaw === "string" && sessionRaw.trim() ? sessionRaw.trim() : null;
  const text = typeof textRaw === "string" && textRaw.trim() ? textRaw.trim() : null;
  return { sessionId, text };
}
