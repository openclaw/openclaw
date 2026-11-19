import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  appendAssistantReplyText,
  readAssistantReplyText,
} from "../../packages/gateway-client/src/run-recovery-text.js";
import type { GatewayClient } from "../gateway/client.js";
import type { AcpPendingPrompt } from "./translator.prompt-state.js";

/**
 * Session message subscription of `deliver: true` prompts. Subscribers get a
 * run's committed assistant text as `session.message` transcript messages, and
 * its `chat` frames can then omit that text.
 */
export class AcpTranslatorSessionMessages {
  /** Session key each ACP session subscribed on the current Gateway connection. */
  private readonly subscriptions = new Map<string, string>();

  constructor(
    private readonly gateway: GatewayClient,
    private readonly findPendingBySessionKey: (
      sessionKey: string,
      runId: string,
    ) => AcpPendingPrompt | undefined,
    private readonly isPending: (pending: AcpPendingPrompt) => boolean,
    private readonly emitText: (pending: AcpPendingPrompt, text: string) => Promise<void>,
    private readonly log: (msg: string) => void,
  ) {}

  async subscribe(session: { sessionId: string; sessionKey: string }): Promise<void> {
    if (this.subscriptions.get(session.sessionId) === session.sessionKey) {
      return;
    }
    // Runs that deliver to an external channel are hidden from operator
    // broadcasts; the Gateway streams them only to session message
    // subscribers. A run in flight across a reconnect still settles
    // through disconnect recovery but loses its live text.
    await this.gateway.request("sessions.messages.subscribe", {
      key: session.sessionKey,
      subscriptionId: `acp:${session.sessionId}`,
    });
    this.subscriptions.set(session.sessionId, session.sessionKey);
  }

  handleGatewayDisconnect(): void {
    // The Gateway drops a connection's subscriptions when it closes.
    this.subscriptions.clear();
  }

  async release(sessionId: string): Promise<void> {
    const sessionKey = this.subscriptions.get(sessionId);
    if (sessionKey === undefined) {
      return;
    }
    this.subscriptions.delete(sessionId);
    try {
      await this.gateway.request("sessions.messages.unsubscribe", {
        key: sessionKey,
        subscriptionId: `acp:${sessionId}`,
      });
    } catch (err) {
      // A closed Gateway connection already dropped its subscriptions.
      this.log(`sessions.messages.unsubscribe failed for ${sessionId}: ${String(err)}`);
    }
  }

  async handleSessionMessage(payload: unknown): Promise<void> {
    const sessionKey = isRecord(payload) ? payload.sessionKey : undefined;
    const message = isRecord(payload) ? payload.message : undefined;
    const metadata = isRecord(message) ? message["__openclaw"] : undefined;
    if (
      typeof sessionKey !== "string" ||
      !isRecord(message) ||
      message.role !== "assistant" ||
      !isRecord(metadata) ||
      typeof metadata.runId !== "string"
    ) {
      return;
    }
    const pending = this.findPendingBySessionKey(sessionKey, metadata.runId);
    if (!pending || pending.idempotencyKey !== metadata.runId) {
      return;
    }
    // Terminal `chat` frames wait on this chain before they settle the prompt.
    const sync = (pending.transcriptSync ?? Promise.resolve()).then(() =>
      this.applyTranscriptMessage(pending, sessionKey, message, metadata),
    );
    pending.transcriptSync = sync.catch((err: unknown) => {
      this.log(`session message for ${pending.idempotencyKey} failed: ${String(err)}`);
    });
    await pending.transcriptSync;
  }

  private async applyTranscriptMessage(
    pending: AcpPendingPrompt,
    sessionKey: string,
    message: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const messageId = typeof metadata.id === "string" ? metadata.id : undefined;
    if (messageId) {
      pending.transcriptMessageIds ??= new Set();
      if (pending.transcriptMessageIds.has(messageId)) {
        return;
      }
      pending.transcriptMessageIds.add(messageId);
    }
    let full = message;
    if (metadata.truncated === true) {
      if (!messageId) {
        return;
      }
      // Live transcript messages carry a bounded display copy of long text.
      const fetched = await this.gateway.request<{ ok?: boolean; message?: unknown }>(
        "chat.message.get",
        { sessionKey, messageId },
      );
      if (fetched?.ok !== true || !isRecord(fetched.message)) {
        return;
      }
      full = fetched.message;
    }
    const text = readAssistantReplyText(full);
    if (!text || !this.isPending(pending)) {
      return;
    }
    pending.transcriptText = appendAssistantReplyText(pending.transcriptText ?? "", text);
    const sent = pending.sentText ?? "";
    const fullText = pending.transcriptText.trimEnd();
    if (fullText.length > sent.length && fullText.startsWith(sent)) {
      pending.sentText = fullText;
      await this.emitText(pending, fullText.slice(sent.length));
    }
  }
}
