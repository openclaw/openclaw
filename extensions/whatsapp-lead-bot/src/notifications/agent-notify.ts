/**
 * Agent notification system - sends WhatsApp messages to configured agent numbers
 */

import type { WhatsAppLeadBotConfig } from "../config/schema.js";
import type { Lead } from "../database/schema.js";
import type { Runtime } from "../runtime.js";
import { formatTimeAgo } from "../utils/format.js";

export type { Runtime };

export class AgentNotifier {
  constructor(
    private runtime: Runtime,
    private config: WhatsAppLeadBotConfig,
  ) {}

  async notifyNewLead(lead: Lead): Promise<void> {
    if (!this.config.notifyNewLeads || this.config.agentNumbers.length === 0) {
      return;
    }

    const message = this.formatNewLeadNotification(lead);
    await this.sendToAgents(message);
  }

  async notifyQualified(lead: Lead): Promise<void> {
    if (!this.config.notifyQualified || this.config.agentNumbers.length === 0) {
      return;
    }

    const message = this.formatQualifiedNotification(lead);
    await this.sendToAgents(message);
  }

  async notifyHandoff(lead: Lead, reason?: string, agentPhone?: string): Promise<void> {
    if (!this.config.notifyHandoff || this.config.agentNumbers.length === 0) {
      return;
    }

    const message = this.formatHandoffNotification(lead, reason, agentPhone);
    await this.sendToAgents(message);
  }

  async notifyRateLimit(lead: Lead, reason: string): Promise<void> {
    if (!this.config.rateLimit.notifyOnLimit || this.config.agentNumbers.length === 0) {
      return;
    }

    const message = `⚠️ **Rate Limit Hit**\n\nLead: ${lead.phone_number}\nReason: ${reason}\n\nBot has stopped responding. Use /clear-limit ${lead.phone_number} to reset.`;
    await this.sendToAgents(message);
  }

  async notifyHandoffCapture(
    lead: Lead,
    type: "receipt" | "media",
    detail?: string,
  ): Promise<void> {
    if (this.config.agentNumbers.length === 0) return;

    const name = lead.name || lead.phone_number;
    const msg =
      type === "receipt"
        ? `📄 ${name} envió su recibo CFE${detail ? ` (${detail})` : ""}`
        : `📎 ${name} envió un archivo durante el handoff`;
    await this.sendToAgents(msg);
  }

  async notifyCircuitTripped(reason: string): Promise<void> {
    if (this.config.agentNumbers.length === 0) return;

    const message = `🚨 **CIRCUIT BREAKER TRIPPED**\n\nReason: ${reason}\n\nAll bot responses are SUSPENDED. Use /reset-breaker to restore service.`;
    await this.sendToAgents(message);
  }

  async notifyCircuitReset(): Promise<void> {
    if (this.config.agentNumbers.length === 0) return;

    const message = `✅ **Circuit Breaker Reset**\n\nBot responses have been restored.`;
    await this.sendToAgents(message);
  }

  private formatNewLeadNotification(lead: Lead): string {
    const timeAgo = formatTimeAgo(Date.now() - lead.first_contact_at);

    return `🆕 **New Lead**\n\nPhone: ${lead.phone_number}\nFirst contact: ${timeAgo}\nStatus: ${lead.status}`;
  }

  private formatQualifiedNotification(lead: Lead): string {
    return `✅ **Lead Qualified**\n\nPhone: ${lead.phone_number}\nName: ${lead.name || "N/A"}\nScore: ${lead.score || "N/A"}\n\nLocation: ${lead.location || "N/A"}\nProperty: ${lead.property_type || "N/A"}\nOwnership: ${lead.ownership || "N/A"}\nBill: ${lead.bimonthly_bill ?? "N/A"}`;
  }

  private formatHandoffNotification(lead: Lead, reason?: string, agentPhone?: string): string {
    const reasonLine = reason ? `\nReason: ${reason}` : "";
    return `🤝 Handoff: ${lead.phone_number}${reasonLine}\nUn vendedor respondió a este lead. El bot dejó de responder.\nPara regresar al bot: /takeback ${lead.phone_number}`;
  }

  private async sendToAgents(message: string): Promise<void> {
    for (const agentNumber of this.config.agentNumbers) {
      try {
        await this.runtime.sendMessage(agentNumber, {
          text: message,
          metadata: { openclawInitiated: true },
        });
      } catch (err) {
        console.error(`[agent-notify] Failed to send to ${agentNumber}:`, err);
      }
    }
  }
}
