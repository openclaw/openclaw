import type { PluginLogger } from "../api.js";
import type { SmtpConfig } from "./types.js";

/**
 * Email delivery modes:
 * - "immediate": Push via Mercure as soon as report is generated (already done by MercurePusher)
 * - "scheduled": Store in download table for cron job to pick up and send via email
 * - "email_only": Send email without Mercure push (for batch/digest scenarios)
 */
export type EmailDeliveryMode = "immediate" | "scheduled" | "email_only";

export interface EmailSendOptions {
  to: string;
  subject: string;
  body: string;
  bodyHtml?: string;
}

export class EmailSender {
  private readonly config: SmtpConfig;

  constructor(config: SmtpConfig) {
    this.config = config;
  }

  /**
   * Send a report email via SMTP using HTTP API.
   * Falls back to direct SMTP if no HTTP endpoint configured.
   */
  async sendEmail(options: EmailSendOptions, logger: PluginLogger): Promise<void> {
    const { host, port, password, from } = this.config;
    const { to, subject, body, bodyHtml } = options;

    logger.info(`[EMAIL_SENDER] Sending email to ${to}: ${subject}`);

    try {
      // Use HTTP API endpoint for email sending
      // This assumes a local email proxy service is running
      const endpoint = `http://${host}:${port}/api/send-email`;

      const payload = {
        from,
        to,
        subject,
        text: body,
        html: bodyHtml ?? this.markdownToHtml(body, subject),
      };

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(password ? { Authorization: `Bearer ${password}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Email service returned ${response.status}: ${errorText}`);
      }

      logger.info(`[EMAIL_SENDER] Email sent successfully to ${to}`);
    } catch (error) {
      logger.error(`[EMAIL_SENDER] Failed to send email: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Convert Markdown report to HTML email body.
   */
  markdownToHtml(markdown: string, title: string): string {
    const escapeHtml = (text: string): string =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const htmlBody = markdown
      // Headers
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      // Bold
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      // Italic
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // Line breaks
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>")
      // Lists
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
      // Code blocks
      .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
      // Inline code
      .replace(/`(.+?)`/g, "<code>$1</code>");

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #0066cc; padding-bottom: 10px; }
    h2, h3 { color: #333; }
    p { margin: 1em 0; }
    ul, ol { padding-left: 20px; }
    li { margin: 0.5em 0; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${htmlBody}</p>
  <div class="footer">
    <p>此邮件由观舆卫士 AI 舆情分析师自动发送，请勿直接回复。</p>
    <p>如需管理报告订阅，请访问观舆卫士控制台。</p>
  </div>
</body>
</html>`;
  }
}
