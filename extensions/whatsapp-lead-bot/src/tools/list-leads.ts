/**
 * Tool: list_leads
 *
 * Lists leads with optional status/score filters.
 */

import type { Database } from "../database.js";

export const listLeadsTool = {
  name: "list_leads",
  description:
    "List lead records, optionally filtered by status and/or score. Returns leads ordered by most recent message.",
  inputSchema: {
    type: "object" as const,
    properties: {
      status: {
        type: "string" as const,
        description:
          "Filter by status: new, qualifying, qualified, handed_off, ignored, blocked, rate_limited",
      },
      score: {
        type: "string" as const,
        description: "Filter by score: HOT, WARM, COLD, OUT",
      },
    },
    required: [] as string[],
  },
  execute: async (params: { status?: string; score?: string }, context: { db: Database }) => {
    const leads = await context.db.listLeads(params);
    return { success: true, count: leads.length, leads };
  },
};
