/**
 * Send Outlook emails to self for human checkpoints.
 */

import type { BridgeClient } from "./bridge-client.js";
import type { Contract } from "./db.js";

export type NotifierConfig = {
  selfEmail: string;
  selfAccount: string;
  replyPrefix: string;
};

export class Notifier {
  constructor(
    private bridge: BridgeClient,
    private config: NotifierConfig,
  ) {}

  /** Checkpoint 1: New contract ready for review. */
  async notifyCheckpoint1(contract: Contract): Promise<string | null> {
    const subject = `${this.config.replyPrefix}${contract.id} — Review: ${contract.intent.slice(0, 80)}`;
    const body = [
      `${this.config.replyPrefix}${contract.id}`,
      "",
      `Intent: ${contract.intent}`,
      contract.qa_doc ? `QA: ${contract.qa_doc.slice(0, 300)}` : null,
      `Project: ${contract.project_id ?? "unassigned"}`,
      `Owner VM: ${contract.owner}`,
      `From: ${contract.sender_name ?? ""} <${contract.sender_email ?? "unknown"}>`,
      "",
      "Reply to this email with one of:",
      "  approve",
      "  reject",
      "  edit: <new intent>",
    ].filter((s) => s !== null).join("\n");

    return this.sendToSelf(subject, body);
  }

  /** Checkpoint 2: Contract done, reply draft ready for review. */
  async notifyCheckpoint2(contract: Contract): Promise<string | null> {
    const subject = `${this.config.replyPrefix}${contract.id} — Reply Draft: ${contract.intent.slice(0, 80)}`;
    const body = [
      `${this.config.replyPrefix}${contract.id}`,
      "",
      `DONE: ${contract.intent}`,
      contract.reply_content ? `Draft reply: ${contract.reply_content.slice(0, 500)}` : null,
      contract.qa_results ? `QA: ${JSON.stringify(contract.qa_results).slice(0, 300)}` : null,
      "",
      "Reply to this email with one of:",
      "  approve",
      "  revise",
    ].filter((s) => s !== null).join("\n");

    return this.sendToSelf(subject, body);
  }

  /** Notify about a stuck contract. */
  async notifyStuck(contract: Contract): Promise<void> {
    const subject = `STUCK: ${this.config.replyPrefix}${contract.id} — ${contract.intent.slice(0, 80)}`;
    const body = [
      `STUCK: ${this.config.replyPrefix}${contract.id}`,
      "",
      `Intent: ${contract.intent}`,
      `Attempts: ${contract.attempt_count}/${contract.max_attempts}`,
      contract.execution_log ? `Log: ${contract.execution_log.slice(0, 500)}` : null,
    ].filter((s) => s !== null).join("\n");

    await this.sendToSelf(subject, body);
  }

  /** Notify about low confidence or needs_review messages. */
  async notifyReview(subject: string, body: string, senderEmail: string, reason: string): Promise<void> {
    const emailSubject = `NEEDS REVIEW — From: ${senderEmail}${subject ? ` — ${subject}` : ""}`;
    const emailBody = [
      "NEEDS REVIEW",
      "",
      `From: ${senderEmail}`,
      subject ? `Subject: ${subject}` : null,
      `Reason: ${reason}`,
      `Preview: ${body.slice(0, 300)}`,
    ].filter((s) => s !== null).join("\n");

    await this.sendToSelf(emailSubject, emailBody);
  }

  private async sendToSelf(subject: string, body: string): Promise<string | null> {
    const result = await this.bridge.createEmailDraft(
      this.config.selfEmail,
      subject,
      body,
      this.config.selfAccount,
    );

    const data = result.result as Record<string, unknown> | undefined;
    const draftId = data?.draft_id as string | undefined;
    if (!draftId) return null;

    // Send the draft immediately
    const sendResult = await this.bridge.sendDraft(draftId, this.config.selfAccount);
    const sendData = sendResult.result as Record<string, unknown> | undefined;
    if (sendData?.pending_id) {
      const confirmed = await this.bridge.confirmSend(sendData.pending_id as string);
      const confirmedData = confirmed.result as Record<string, unknown> | undefined;
      return (confirmedData?.message_id as string) ?? draftId;
    }
    return draftId;
  }
}
