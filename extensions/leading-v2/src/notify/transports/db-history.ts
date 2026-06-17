import { execute } from "../../client/db-client.js";
import type { MySqlConfig } from "../../client/types.js";
import type { Notification, NotificationTransport, NotifyAddressing } from "../notification.js";

/** Pull the chat sessionId out of an agent sessionKey (…:<sessionId> tail). */
export function sessionIdFromKey(sessionKey?: string): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const tail = sessionKey.split(":").pop();
  return tail && tail.startsWith("session_") ? tail : undefined;
}

/**
 * T2 — durable delivery: persist the notification as an assistant-only row in
 * history_messages, so it shows up in the conversation on next reload even if
 * the user was offline when it fired. The web history loader renders `response`
 * as an assistant bubble and skips the empty `message` (no phantom user bubble).
 */
export class DbHistoryTransport implements NotificationTransport {
  readonly id = "db-history";

  constructor(private readonly db: MySqlConfig) {}

  async deliver(n: Notification, to: NotifyAddressing): Promise<{ ok: boolean; note?: string }> {
    const sessionId = sessionIdFromKey(to.sessionKey);
    if (!sessionId) {
      return { ok: false, note: "no session id in sessionKey" };
    }
    const body = n.title ? `**${n.title}**\n\n${n.body}` : n.body;
    const text = n.link ? `${body}\n\n[查看详情](${n.link})` : body;
    await execute(
      this.db,
      "INSERT INTO history_messages (session_id, user_id, message, response, tools_used, metadata, created_at) " +
        "VALUES (?, ?, '', ?, NULL, NULL, NOW())",
      [sessionId, n.uid, text],
    );
    return { ok: true };
  }
}
