import { asRecord } from "@openclaw/normalization-core/record-coerce";

export type RecoveryRequest = (
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export async function recoverTerminalReply(params: {
  runId: string;
  scope: { sessionKey?: string; agentId?: string; sessionId?: string };
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
      asRecord(message.openclawStreamFallback).source !== "segment" &&
      (metadata.runId === runId ||
        (idempotencyKey !== undefined && metadata.idempotencyKey === idempotencyKey))
    );
  };
  const target = {
    sessionKey: scope.sessionKey,
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
  };
  let offset: number | undefined;
  let sessionId = expectedSessionId;
  const pages: Record<string, unknown>[][] = [];
  let complete = false;
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
      pages.unshift(messages.filter(matches));
      if (page.hasMore !== true) {
        complete = true;
        break;
      }
      if (
        typeof page.nextOffset !== "number" ||
        !Number.isSafeInteger(page.nextOffset) ||
        page.nextOffset <= (offset ?? 0)
      ) {
        break;
      }
      offset = page.nextOffset;
    }
    if (!complete) {
      return { unavailable: "history-limit-reached" };
    }
    const messages = pages.flat();
    if (
      messages.length === 0 ||
      (idempotencyKey !== undefined &&
        !messages.some(
          (message) => asRecord(message["__openclaw"]).idempotencyKey === idempotencyKey,
        ))
    ) {
      return { unavailable: "reply-not-found" };
    }
    let outputText = "";
    const seen = new Set<string>();
    for (let message of messages) {
      signal.throwIfAborted();
      const metadata = asRecord(message["__openclaw"]);
      if (typeof metadata.id === "string") {
        if (seen.has(metadata.id)) {
          continue;
        }
        seen.add(metadata.id);
      }
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
      const text = readAssistantReplyText(message);
      if (text === undefined) {
        return { unavailable: "reply-text-unavailable" };
      }
      outputText = appendAssistantReplyText(outputText, text);
    }
    return { outputText };
  } catch {
    signal.throwIfAborted();
    return { unavailable: "history-request-failed" };
  }
}

/** Text of one transcript assistant message; undefined when it has no readable content. */
export function readAssistantReplyText(message: Record<string, unknown>): string | undefined {
  const content = typeof message.text === "string" ? message.text : message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .flatMap((block) => {
      const part = asRecord(block);
      return (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string"
        ? [part.text]
        : [];
    })
    .join("\n");
}

/** Joins a run's assistant messages the way the live stream joins its items. */
export function appendAssistantReplyText(outputText: string, text: string): string {
  // Match the live item boundary: existing provider newlines supply the padding.
  if (!outputText || !text) {
    return outputText + text;
  }
  const trailing = outputText.endsWith("\n\n") ? 2 : outputText.endsWith("\n") ? 1 : 0;
  const leading = text.startsWith("\n\n") ? 2 : text.startsWith("\n") ? 1 : 0;
  return outputText + "\n".repeat(Math.max(0, 2 - trailing - leading)) + text;
}
