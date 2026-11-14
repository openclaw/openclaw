import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";

const MAX_ATTACHMENTS = 4096;
type Attachment = { targetId: string; parent: string };
type Pending = { kind: "attach"; attachment: Attachment } | { kind: "detach"; session: string };

/** Restore Kitesurf's missing parent-session routing and page target context. */
export function createKitesurfCdpNormalizer() {
  const pending = new Map<number, Pending>();
  const attached = new Map<string, Attachment>();

  return {
    send(message: object): object {
      const command = asOptionalRecord(message);
      const session = readStringField(command, "sessionId");
      const params = asOptionalRecord(command?.params);
      const targetId = readStringField(params, "targetId");
      const attachment = session ? attached.get(session) : undefined;
      if (command?.method === "Target.getTargetInfo" && attachment && !targetId) {
        // Kitesurf defaults to the browser target, even on a page CDP session.
        return { ...command, params: { ...params, targetId: attachment.targetId } };
      }
      let operation: Pending | undefined;
      if (command?.method === "Target.attachToTarget" && session && targetId) {
        operation = { kind: "attach", attachment: { targetId, parent: session } };
      } else if (command?.method === "Target.detachFromTarget") {
        const child = readStringField(params, "sessionId");
        if (child && attached.has(child)) {
          operation = { kind: "detach", session: child };
        }
      }
      if (operation && typeof command?.id === "number") {
        if (pending.size >= MAX_ATTACHMENTS) {
          throw new Error("Kitesurf has too many unanswered target commands; reconnect.");
        }
        pending.set(command.id, operation);
      }
      return message;
    },
    receive(message: Record<string, unknown>): Record<string, unknown>[] {
      if (typeof message.id === "number") {
        const operation = pending.get(message.id);
        pending.delete(message.id);
        if (operation?.kind === "detach" && !message.error) {
          // Upstream does not emit detachedFromTarget for explicit detach.
          attached.delete(operation.session);
        }
        return [message];
      }
      const params = asOptionalRecord(message.params);
      const session = readStringField(params, "sessionId");
      if (!session) {
        return [message];
      }
      if (message.method === "Target.attachedToTarget") {
        const targetId = readStringField(asOptionalRecord(params?.targetInfo), "targetId");
        const operation = [...pending.values()].find(
          (item) => item.kind === "attach" && item.attachment.targetId === targetId,
        );
        if (operation?.kind === "attach" && !readStringField(message, "sessionId")) {
          if (attached.size >= MAX_ATTACHMENTS) {
            throw new Error("Kitesurf has too many attached child sessions; reconnect.");
          }
          attached.set(session, operation.attachment);
          // Preserve the real event and session; only restore its requesting parent.
          // Otherwise Playwright mistakes this auxiliary CDP session for a new page.
          return [{ ...message, sessionId: operation.attachment.parent }];
        }
      } else if (message.method === "Target.detachedFromTarget") {
        const attachment = attached.get(session);
        attached.delete(session);
        if (attachment && !readStringField(message, "sessionId")) {
          return [{ ...message, sessionId: attachment.parent }];
        }
      }
      return [message];
    },
    clear() {
      pending.clear();
      attached.clear();
    },
  };
}
