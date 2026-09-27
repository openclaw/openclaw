import type { AnyMessage, JsonRpcId } from "@agentclientprotocol/sdk";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

const SESSION_ESTABLISHING_METHODS = new Set(["session/load", "session/resume"]);

// Preserve content on overflow: release that session in order, never drop updates.
const MAX_QUEUED_UPDATES_PER_SESSION = 256;

type QueuedUpdate = { sessionId: string; message: AnyMessage };

/** Owns wire order because the SDK serializes results only after handlers return. */
export class AcpSessionNewOrdering {
  private readonly establishedSessionIds = new Set<string>();
  // Retain arrival order until a session can release its own complete backlog.
  private readonly queue: QueuedUpdate[] = [];
  private readonly queuedPerSession = new Map<string, number>();
  // Overlapping loads retire independently; a rejected claim cannot erase a live one.
  private readonly provisionalSessions = new Map<JsonRpcId, string>();
  private readonly provisionalClaims = new Map<string, number>();
  // Only SDK-valid in-flight creations justify holding updates for unknown sessions.
  private readonly pendingNewSessionRequestIds = new Set<JsonRpcId>();

  observeInbound(message: AnyMessage): void {
    const messageObject = asOptionalRecord(message);
    const method = messageObject?.method;
    const requestId = readRequestId(messageObject?.id);
    // Match SDK 1.4 isRequestMessage before recording work. Invalid envelopes
    // receive an uncorrelated null-ID error, not a response to their supplied ID.
    if (messageObject?.jsonrpc !== "2.0" || typeof method !== "string" || requestId === undefined) {
      return;
    }

    if (method === "session/new") {
      this.pendingNewSessionRequestIds.add(requestId);
      return;
    }

    const sessionId = readSessionId(messageObject?.params);
    if (!sessionId) {
      return;
    }

    // Any other method — `session/prompt` above all — may name a session that does
    // not exist. The translator rejects those, so recording them here would let a
    // peer grow this set for the lifetime of the process.
    if (SESSION_ESTABLISHING_METHODS.has(method)) {
      // A load or resume is a claim on the session, recognized immediately so its
      // updates are never delayed, and confirmed or retired by its own response. It
      // never writes to the confirmed set directly: two overlapping claims on one
      // session must resolve independently, so that one failing cannot erase what
      // the other established.
      this.provisionalSessions.set(requestId, sessionId);
      this.provisionalClaims.set(sessionId, (this.provisionalClaims.get(sessionId) ?? 0) + 1);
      return;
    }

    if (method === "session/close") {
      this.forget(sessionId);
    }
  }

  forget(sessionId: string): void {
    this.establishedSessionIds.delete(sessionId);
  }

  transformOutbound(
    message: AnyMessage,
    controller: TransformStreamDefaultController<AnyMessage>,
  ): void {
    const emit = (queued: AnyMessage) => controller.enqueue(queued);
    // Inbound events cannot write to the stream, so anything they unblocked is
    // released here, ahead of this message, which is where it arrived.
    this.drain(emit);

    const messageObject = asOptionalRecord(message);
    const responseId = isJsonRpcResponse(messageObject)
      ? readRequestId(messageObject?.id)
      : undefined;
    if (responseId !== undefined) {
      const claimed = this.provisionalSessions.get(responseId);
      if (claimed !== undefined) {
        this.provisionalSessions.delete(responseId);
        const remaining = (this.provisionalClaims.get(claimed) ?? 1) - 1;
        if (remaining > 0) {
          this.provisionalClaims.set(claimed, remaining);
        } else {
          this.provisionalClaims.delete(claimed);
        }
        if (messageObject?.error === undefined) {
          this.establish(claimed);
        }
        // A rejection retires only this claim. Recognition persists exactly when
        // the session is confirmed or another claim on it is still outstanding.
      }
    }
    if (responseId !== undefined && this.pendingNewSessionRequestIds.delete(responseId)) {
      // The response to `session/new` always goes out first; it is what introduces
      // the session ID to the client. A failed creation carries no ID to establish.
      emit(message);
      const establishedSessionId = readSessionId(messageObject?.result);
      if (establishedSessionId) {
        this.establish(establishedSessionId);
        // Release this session's backlog immediately rather than only the run at the
        // head of the global queue. Sessions are independent streams, so holding one
        // behind another buys no ordering the client can observe, while it does delay
        // this session's updates past frames that never enter the queue at all — a
        // prompt's completion response, above all, which would then arrive before the
        // text it completes.
        this.releaseSession(establishedSessionId, emit);
      }
      this.drain(emit);
      return;
    }

    const sessionId = readSessionId(messageObject?.params);
    if (
      messageObject?.method === "session/update" &&
      sessionId &&
      this.shouldQueue(sessionId) &&
      this.enqueue(sessionId, message, emit)
    ) {
      return;
    }

    emit(message);
  }

  private isRecognized(sessionId: string): boolean {
    return this.establishedSessionIds.has(sessionId) || this.provisionalClaims.has(sessionId);
  }

  private shouldQueue(sessionId: string): boolean {
    // A session with updates still queued keeps queuing, recognized or not, so a
    // newer update can never pass an older one from the same session. The backlog is
    // released whole when the session is introduced, so this holds only for as long
    // as the session has genuinely not reached the client.
    if (this.queuedPerSession.has(sessionId)) {
      return true;
    }
    if (this.isRecognized(sessionId)) {
      return false;
    }
    return this.pendingNewSessionRequestIds.size > 0;
  }

  private establish(sessionId: string): void {
    this.establishedSessionIds.add(sessionId);
  }

  private enqueue(
    sessionId: string,
    message: AnyMessage,
    emit: (message: AnyMessage) => void,
  ): boolean {
    const queued = this.queuedPerSession.get(sessionId) ?? 0;
    if (queued >= MAX_QUEUED_UPDATES_PER_SESSION) {
      // Fail open, but never out of order within the session: release everything
      // this session has queued, in order, before the caller writes this one through.
      // Cross-session order degrades here; intra-session order does not.
      this.releaseSession(sessionId, emit);
      return false;
    }
    this.queue.push({ sessionId, message });
    this.queuedPerSession.set(sessionId, queued + 1);
    return true;
  }

  private releaseSession(sessionId: string, emit: (message: AnyMessage) => void): void {
    if (!this.queuedPerSession.delete(sessionId)) {
      return;
    }
    let kept = 0;
    for (const entry of this.queue) {
      if (entry.sessionId === sessionId) {
        emit(entry.message);
        continue;
      }
      this.queue[kept] = entry;
      kept += 1;
    }
    this.queue.length = kept;
  }

  private drain(emit: (message: AnyMessage) => void): void {
    if (this.queue.length === 0) {
      return;
    }
    const nothingOutstanding = this.pendingNewSessionRequestIds.size === 0;
    let released = 0;
    for (const entry of this.queue) {
      if (!nothingOutstanding && !this.isRecognized(entry.sessionId)) {
        break;
      }
      emit(entry.message);
      const remaining = this.queuedPerSession.get(entry.sessionId) ?? 1;
      if (remaining <= 1) {
        this.queuedPerSession.delete(entry.sessionId);
      } else {
        this.queuedPerSession.set(entry.sessionId, remaining - 1);
      }
      released += 1;
    }
    if (released > 0) {
      this.queue.splice(0, released);
    }
  }
}

function isJsonRpcResponse(value: Record<string, unknown> | undefined): boolean {
  if (value === undefined || "method" in value) {
    return false;
  }
  // SDK invalid-envelope errors have null IDs but are not replies to an admitted
  // null-ID request. The bridge's handler/parameter errors use other error codes.
  if (value.id === null && asOptionalRecord(value.error)?.code === -32600) {
    return false;
  }
  return value.result !== undefined || value.error !== undefined;
}

// SDK IDs are native Map keys: null/empty strings are valid; absence is not.
function readRequestId(value: unknown): JsonRpcId | undefined {
  return value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? value
    : undefined;
}

function readSessionId(value: unknown): string | undefined {
  const sessionId = asOptionalRecord(value)?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
