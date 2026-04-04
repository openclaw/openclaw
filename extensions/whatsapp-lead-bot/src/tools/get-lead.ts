/**
 * Tool: get_lead
 *
 * Retrieves a lead by phone number.
 */

import type { Database } from "../database.js";

export const getLeadTool = {
  name: "get_lead",
  description: "Retrieve a lead record by phone number.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
    },
    required: ["phone"],
  },
  execute: async (params: { phone: string }, context: { db: Database }) => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }
    return { success: true, lead };
  },
};
