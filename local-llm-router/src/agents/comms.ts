/**
 * Comms agent — handles email, messaging, and drafting.
 * Uses local model for speed on simple tasks, cloud for complex composition.
 */

import type { Task } from "../types.js";
import { BaseAgent, type AgentResult } from "./base-agent.js";
import { fetchEmails, searchEmails, sendEmail } from "../tools/email.js";
import { sanitiseUntrustedInput } from "../security/guards.js";

export class CommsAgent extends BaseAgent {
  async execute(task: Task): Promise<AgentResult> {
    return this.runWithTracking(task, async () => {
      const { intent } = task.classification;

      switch (intent) {
        case "email_draft":
          return this.draftEmail(task);
        case "email_send":
          return this.sendEmailAction(task);
        case "email_read":
          return this.readEmail(task);
        case "general_chat":
          return this.chat(task);
        default:
          return this.chat(task);
      }
    });
  }

  private async draftEmail(task: Task): Promise<string> {
    const prompt = [
      "Draft an email based on the following request.",
      "Return ONLY the email in this format:",
      "TO: <recipient>",
      "SUBJECT: <subject>",
      "BODY:",
      "<email body>",
      "",
      `Request: ${task.input}`,
    ].join("\n");

    const draft = await this.callModel(task, prompt);

    await this.audit({
      action: "email_draft",
      tool: "email",
      output: draft.slice(0, 200),
    });

    return draft;
  }

  private async sendEmailAction(task: Task): Promise<string> {
    const draft = await this.draftEmail(task);

    const toMatch = draft.match(/^TO:\s*(.+)$/m);
    const subjectMatch = draft.match(/^SUBJECT:\s*(.+)$/m);
    const bodyMatch = draft.match(/BODY:\s*([\s\S]+)$/m);

    if (!toMatch || !subjectMatch || !bodyMatch) {
      return `Draft composed but could not parse for sending. Please review:\n\n${draft}`;
    }

    const smtpHost = process.env.SMTP_HOST;
    if (!smtpHost) {
      return `Draft ready for review (SMTP not configured):\n\n${draft}`;
    }

    const smtpConfig = {
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT ?? "587", 10),
      auth: {
        user: process.env.SMTP_USER ?? "",
        pass: process.env.SMTP_PASS ?? "",
      },
      secure: process.env.SMTP_SECURE === "true",
    };

    const result = await sendEmail(smtpConfig, {
      to: toMatch[1].trim(),
      subject: subjectMatch[1].trim(),
      body: bodyMatch[1].trim(),
    });

    await this.audit({
      action: "email_send",
      tool: "email",
      output: `Sent: ${result.messageId}`,
    });

    return `Email sent successfully.\nMessage ID: ${result.messageId}\n\n${draft}`;
  }

  private async readEmail(task: Task): Promise<string> {
    const imapHost = process.env.IMAP_HOST;
    if (!imapHost) {
      return "IMAP not configured. Set IMAP_HOST, IMAP_USER, IMAP_PASS in .env";
    }

    const imapConfig = {
      host: imapHost,
      port: parseInt(process.env.IMAP_PORT ?? "993", 10),
      auth: {
        user: process.env.IMAP_USER ?? "",
        pass: process.env.IMAP_PASS ?? "",
      },
      tls: process.env.IMAP_TLS !== "false",
    };

    const isSearch = task.input.toLowerCase().includes("search") ||
      task.input.toLowerCase().includes("find") ||
      task.input.toLowerCase().includes("from ");

    let emailSummary: string;

    if (isSearch) {
      const queryPrompt = `Extract the email search query from this request. Return ONLY the search term, nothing else.\n\nRequest: ${task.input}`;
      const searchQuery = await this.callModel(task, queryPrompt, { maxTokens: 100 });

      const emails = await searchEmails(imapConfig, searchQuery.trim(), { limit: 5 });
      emailSummary = emails.length === 0
        ? "No emails found matching your search."
        : emails.map((e) => {
            const { sanitised, flagged } = sanitiseUntrustedInput(
              `From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}`,
              `email:${e.from}`,
              "untrusted",
            );
            if (flagged) {
              return `- [FLAGGED INJECTION ATTEMPT] From: ${e.from} | Subject: ${e.subject}`;
            }
            return `- ${sanitised}${e.isRead ? "" : " [UNREAD]"}`;
          }).join("\n");
    } else {
      const emails = await fetchEmails(imapConfig, { limit: 10, unseen: true });
      emailSummary = emails.length === 0
        ? "No unread emails."
        : emails.map((e) => {
            const { sanitised, flagged } = sanitiseUntrustedInput(
              `From: ${e.from} | Subject: ${e.subject} | Date: ${e.date}`,
              `email:${e.from}`,
              "untrusted",
            );
            if (flagged) {
              return `- [FLAGGED INJECTION ATTEMPT] From: ${e.from} | Subject: ${e.subject}`;
            }
            return `- ${sanitised}`;
          }).join("\n");
    }

    const summaryPrompt = [
      "Summarise these emails concisely for the user. Highlight anything important or time-sensitive.",
      "",
      `User asked: ${task.input}`,
      "",
      "Emails:",
      emailSummary,
    ].join("\n");

    return this.callModel(task, summaryPrompt);
  }

  private async chat(task: Task): Promise<string> {
    return this.callModel(task, task.input);
  }
}
