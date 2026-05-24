import type { ClaworksRuntime } from "../../claworks/runtime.js";

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

export async function recordAssistantTurnIfCompleted(
  runtime: ClaworksRuntime,
  sessionId: string,
  runId: string,
  playbookId?: string,
): Promise<void> {
  const run = await runtime.playbookEngine.getRun(runId);
  if (!run || run.status !== "completed" || !run.output) return;
  const replyText = extractReplyText(run.output);
  if (!replyText) return;
  runtime.contextEngine?.append(sessionId, "assistant", replyText, {
    playbookId,
    runId,
    channel: "rest",
  });
}
