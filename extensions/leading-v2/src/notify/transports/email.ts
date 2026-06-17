import type { RowDataPacket } from "mysql2/promise";
import { query } from "../../client/db-client.js";
import type { MySqlConfig } from "../../client/types.js";
import { type SmtpConfig, sendEmail } from "../email-client.js";
import type { Notification, NotificationTransport, NotifyAddressing } from "../notification.js";

interface EmailRow extends RowDataPacket {
  email: string;
}

/**
 * T3 — offline delivery via email. Resolves the user's address from
 * feed_report_subscriber (active subscribers only; the only per-user email
 * source in this deployment), then sends through the email proxy. Skips users
 * without a subscriber email.
 */
export class EmailNotificationTransport implements NotificationTransport {
  readonly id = "email";

  constructor(
    private readonly smtp: SmtpConfig,
    private readonly db: MySqlConfig,
  ) {}

  async deliver(n: Notification, _to: NotifyAddressing): Promise<{ ok: boolean; note?: string }> {
    const rows = await query<EmailRow[]>(
      this.db,
      "SELECT email FROM feed_report_subscriber WHERE uid = ? AND active = 1 " +
        "AND email IS NOT NULL AND email != '' LIMIT 1",
      [n.uid],
    );
    const email = rows[0]?.email;
    if (!email) {
      return { ok: false, note: "no subscriber email for user" };
    }
    const text = n.link ? `${n.body}\n\n详情：${n.link}` : n.body;
    await sendEmail(this.smtp, { to: email, subject: n.title, text });
    return { ok: true };
  }
}
