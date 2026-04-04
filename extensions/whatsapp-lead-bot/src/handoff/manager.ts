/**
 * Handoff manager - single entry point for all human agent takeover scenarios.
 *
 * Consolidates handoff logic that was previously scattered across:
 * - message-received.ts (WhatsApp Web handoff)
 * - message-sending.ts (human message detection)
 * - admin/commands.ts (/handoff command)
 */

import type { LeadRepository, HandoffLog } from "../database.js";
import type { Lead } from "../database/schema.js";

export interface HandoffNotifier {
  notifyHandoff(lead: Lead, reason?: string, agentPhone?: string): Promise<void>;
}

export class HandoffManager {
  constructor(
    private db: LeadRepository & HandoffLog,
    private notifier?: HandoffNotifier,
  ) {}

  /** Trigger handoff from a human message sent via WhatsApp Web. */
  async triggerWhatsAppWebHandoff(leadId: number, leadPhone: string): Promise<void> {
    const lead = await this.db.getLeadById(leadId);
    if (!lead || lead.status === "handed_off") return;

    await this.db.updateLeadStatus(leadId, "handed_off");
    await this.db.logHandoffEvent(leadId, "human_detected_whatsapp_web", leadPhone);
    console.log(
      `[lead-bot] 🤝 Handoff triggered for lead ${leadId} - human took over via WhatsApp Web`,
    );
    await this.notifier?.notifyHandoff(lead, "Human took over via WhatsApp Web");
  }

  /** Trigger handoff when a human agent sends a message to a lead. */
  async triggerHumanMessageHandoff(leadId: number): Promise<void> {
    const lead = await this.db.getLeadById(leadId);
    if (!lead || lead.status === "handed_off") return;

    await this.db.updateLeadStatus(leadId, "handed_off");
    await this.db.logHandoffEvent(leadId, "human_detected", "agent");
    console.log(`[lead-bot] 🤝 Handoff triggered for lead ${leadId} - agent took over`);
    await this.notifier?.notifyHandoff(lead, "Human agent sent a message");
  }

  /** Trigger handoff from an admin command. */
  async triggerAdminHandoff(leadId: number): Promise<void> {
    await this.db.updateLeadStatus(leadId, "handed_off");
    await this.db.logHandoffEvent(leadId, "handoff_triggered", "admin", {
      reason: "admin_manual",
    });
  }

  /** Generic handoff for programmatic triggers (tools, etc). */
  async triggerHandoff(leadId: number, reason: string, triggeredBy = "system"): Promise<void> {
    await this.db.updateLeadStatus(leadId, "handed_off");
    await this.db.logHandoffEvent(leadId, "handoff_triggered", triggeredBy, { reason });
  }

  async isHandedOff(leadId: number): Promise<boolean> {
    const lead = await this.db.getLeadById(leadId);
    return lead?.status === "handed_off";
  }
}
