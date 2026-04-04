/**
 * Tool: block_lead
 *
 * Blocks a lead from further bot interaction.
 */

import type { Database } from "../database.js";

export const blockLeadTool = {
  name: "block_lead",
  description: "Block a lead from further bot interaction.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      reason: { type: "string" as const, description: "Reason for blocking" },
    },
    required: ["phone"],
  },
  execute: async (params: { phone: string; reason?: string }, context: { db: Database }) => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await context.db.blockLead(lead.id, params.reason || "Blocked via tool");

    const updated = await context.db.getLeadById(lead.id);
    return { success: true, lead: updated };
  },
};
