import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { mergeChatStreamMessage } from "./chat-stream-message.js";

type ChatStreamScope = { sessionKey: string; agentId: unknown };
type ChatStreamEvent = { event: string; payload?: unknown };

/** Connection-owned chat baselines, independent of the selected local view. */
export class GatewayChatStreamProjection {
  private readonly runs = new Map<string, ChatStreamScope & { message: unknown }>();

  project<T extends ChatStreamEvent>(event: T): { event: T; missingBaseline: boolean } {
    if (event.event !== "chat") {
      return { event, missingBaseline: false };
    }
    const payload = asNullableRecord(event.payload);
    if (!payload || typeof payload.runId !== "string" || typeof payload.sessionKey !== "string") {
      return { event, missingBaseline: false };
    }
    if (payload.state === "delta") {
      const previous = this.runs.get(payload.runId);
      const message = mergeChatStreamMessage(
        previous?.sessionKey === payload.sessionKey && previous.agentId === payload.agentId
          ? previous.message
          : undefined,
        payload,
      );
      if (message !== undefined) {
        this.runs.set(payload.runId, {
          sessionKey: payload.sessionKey,
          agentId: payload.agentId,
          message,
        });
      }
      return {
        event: { ...event, payload: { ...payload, message } },
        missingBaseline: message === undefined,
      };
    }
    if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
      this.runs.delete(payload.runId);
    }
    return { event, missingBaseline: false };
  }

  retire(isRetired: (scope: ChatStreamScope) => boolean): void {
    for (const [runId, scope] of this.runs) {
      if (isRetired(scope)) {
        this.runs.delete(runId);
      }
    }
  }

  clear(): void {
    this.runs.clear();
  }
}
