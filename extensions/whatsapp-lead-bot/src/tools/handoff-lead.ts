/**
 * Tool: handoff_lead
 *
 * Marks a lead as handed off to a human agent and applies the HUMANO label.
 */

import type { Database } from "../database.js";
import type { LabelService } from "../labels.js";
import type { Runtime } from "../runtime.js";

export const handoffLeadTool = {
  name: "handoff_lead",
  description: "Mark a lead as handed off to a human agent. Logs the handoff event for audit.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      reason: { type: "string" as const, description: "Reason for handoff" },
    },
    required: ["phone"],
  },
  execute: async (
    params: { phone: string; reason?: string },
    context: { db: Database; labelService: LabelService; runtime: Runtime },
  ) => {
    const { db, labelService, runtime } = context;
    const lead = await db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await db.updateLeadStatus(lead.id, "handed_off");
    await db.logHandoffEvent(
      lead.id,
      "manual_handoff",
      "tool",
      params.reason ? { reason: params.reason } : undefined,
    );

    // Apply HUMANO label
    try {
      await labelService.applyStatus(params.phone, "handed_off", runtime);
      console.log(`[handoff_lead] HUMANO label applied: ${params.phone}`);
    } catch (err) {
      console.error(`[handoff_lead] Failed to apply HUMANO label ${params.phone}:`, err);
    }

    const updated = await db.getLeadById(lead.id);
    return { success: true, lead: updated };
  },
};
