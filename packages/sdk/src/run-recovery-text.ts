import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { readChatProjectionText } from "./chat-projection.js";
import type { ReplaySessionScope } from "./replay-scope.js";

export type RecoveryRequest = (
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export async function recoverTerminalReply(params: {
  runId: string;
  scope: ReplaySessionScope;
  result: unknown;
  request: RecoveryRequest;
  signal: AbortSignal;
}): Promise<{ outputText?: string; unavailable?: string }> {
  const { runId, scope, request, signal } = params;
  const result = asRecord(params.result);
  const disposition = asRecord(result.terminalReply).disposition;
  if (disposition === "silent" || disposition === "empty") {
    return { outputText: "" };
  }
  if (!scope.sessionKey) {
    return { unavailable: "session-unavailable" };
  }
  const receipt = asRecord(result.terminalReceipt);
  if (receipt.runId !== undefined && receipt.runId !== runId) {
    return { unavailable: "terminal-receipt-mismatch" };
  }
  const expectedSessionId =
    typeof receipt.sessionId === "string" ? receipt.sessionId : scope.sessionId;
  const idempotencyKey =
    typeof receipt.assistantTranscriptIdempotencyKey === "string"
      ? receipt.assistantTranscriptIdempotencyKey
      : undefined;
  const matches = (message: Record<string, unknown>) => {
    const metadata = asRecord(message["__openclaw"]);
    return (
      message.role === "assistant" &&
      (idempotencyKey !== undefined
        ? metadata.idempotencyKey === idempotencyKey
        : metadata.runId === runId)
    );
  };
  const target = {
    sessionKey: scope.sessionKey,
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
  };
  let offset: number | undefined;
  let sessionId = expectedSessionId;
  try {
    // Bound reconnect work; a missing exact occurrence must not become another run's answer.
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      signal.throwIfAborted();
      const page = asRecord(
        await request(
          "chat.history",
          { ...target, limit: 200, ...(offset !== undefined ? { offset } : {}) },
          signal,
        ),
      );
      if (sessionId !== undefined && page.sessionId !== sessionId) {
        return { unavailable: "session-changed" };
      }
      if (typeof page.sessionId === "string") {
        sessionId = page.sessionId;
      }
      const messages = Array.isArray(page.messages) ? page.messages.map(asRecord) : [];
      let message = messages.findLast(matches);
      if (message) {
        const metadata = asRecord(message["__openclaw"]);
        if (metadata.truncated === true) {
          if (typeof metadata.id !== "string") {
            return { unavailable: "message-identity-unavailable" };
          }
          const full = asRecord(
            await request("chat.message.get", { ...target, messageId: metadata.id }, signal),
          );
          message = asRecord(full.message);
          if (
            full.ok !== true ||
            asRecord(message["__openclaw"]).id !== metadata.id ||
            !matches(message) ||
            asRecord(message["__openclaw"]).truncated === true
          ) {
            return { unavailable: "full-message-unavailable" };
          }
        }
        const outputText = readChatProjectionText({ message });
        return outputText === undefined
          ? { unavailable: "reply-text-unavailable" }
          : { outputText };
      }
      if (
        page.hasMore !== true ||
        typeof page.nextOffset !== "number" ||
        !Number.isSafeInteger(page.nextOffset) ||
        page.nextOffset <= (offset ?? 0)
      ) {
        break;
      }
      offset = page.nextOffset;
    }
    return { unavailable: "reply-not-found" };
  } catch {
    signal.throwIfAborted();
    return { unavailable: "history-request-failed" };
  }
}
