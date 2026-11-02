import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_PENDING_TARGET_COMMANDS = 4096;
const MAX_ATTACHED_PAGE_SESSIONS = 4096;
const ROOT_REPLIES = new Set([
  "Target.getTargetInfo",
  "Target.getTargets",
  "Target.getBrowserContexts",
]);

/** Normalize the session-routing omissions observed in Lightpanda 0.4.1. */
export function createLightpandaCdpNormalizer() {
  const pendingSessions = new Map<number, string>();
  const targetBySession = new Map<string, string>();

  return {
    send(message: object): object {
      const command = asOptionalRecord(message);
      const method = readStringField(command, "method");
      const sessionId = readStringField(command, "sessionId");
      if (!command || !sessionId || !ROOT_REPLIES.has(method ?? "")) {
        return message;
      }
      if (typeof command.id === "number") {
        if (pendingSessions.size >= MAX_PENDING_TARGET_COMMANDS) {
          throw new Error("Lightpanda has too many unanswered target commands; reconnect.");
        }
        pendingSessions.set(command.id, sessionId);
      }
      const params = asOptionalRecord(command.params);
      const targetId = targetBySession.get(sessionId);
      // Lightpanda treats an omitted targetId as the startup browser target,
      // even when the command is sent on an attached page session.
      if (method === "Target.getTargetInfo" && !readStringField(params, "targetId") && targetId) {
        return { ...command, params: { ...params, targetId } };
      }
      return message;
    },
    receive(message: Record<string, unknown>): Record<string, unknown> | undefined {
      const params = asOptionalRecord(message.params);
      const sessionId = readStringField(params, "sessionId");
      if (message.method === "Target.attachedToTarget" && sessionId) {
        const target = asOptionalRecord(params?.targetInfo);
        const targetId = readStringField(target, "targetId");
        // Lightpanda emits this non-existent page to unblock clients that wait
        // for an initial target. Playwright connects without it; exposing it
        // creates a tab whose CDP session and document cannot be accessed.
        if (
          sessionId === "STARTUP" &&
          targetId === "TID-STARTUP" &&
          readStringField(target, "browserContextId") === "BID-STARTUP"
        ) {
          return undefined;
        }
        if (readStringField(target, "type") === "page" && targetId) {
          if (targetBySession.size >= MAX_ATTACHED_PAGE_SESSIONS) {
            throw new Error("Lightpanda has too many attached page sessions; reconnect.");
          }
          targetBySession.set(sessionId, targetId);
        }
      } else if (message.method === "Target.detachedFromTarget" && sessionId) {
        targetBySession.delete(sessionId);
      }
      if (typeof message.id === "number") {
        const expectedSessionId = pendingSessions.get(message.id);
        pendingSessions.delete(message.id);
        // Never replace an engine-provided session or infer routing for an
        // unsolicited response. Responses retire the request even on errors.
        if (expectedSessionId && !readStringField(message, "sessionId")) {
          return { ...message, sessionId: expectedSessionId };
        }
      }
      return message;
    },
    clear() {
      pendingSessions.clear();
      targetBySession.clear();
    },
  };
}
