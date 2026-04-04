/**
 * Tool: save_receipt_data
 *
 * Saves parsed CFE receipt data to a lead record.
 */

import type { Database } from "../database.js";

export const saveReceiptDataTool = {
  name: "save_receipt_data",
  description:
    "Save parsed CFE receipt data (tariff, annual kWh, raw JSON) to a lead's database record.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      receipt_data: {
        type: "string" as const,
        description: "JSON string of parsed receipt data",
      },
      tariff: { type: "string" as const, description: "CFE tariff type (e.g. 1, 1A, DAC)" },
      annual_kwh: { type: "number" as const, description: "Annual kWh consumption" },
    },
    required: ["phone", "receipt_data"],
  },
  execute: async (
    params: { phone: string; receipt_data: string; tariff?: string; annual_kwh?: number },
    context: { db: Database },
  ) => {
    const lead = await context.db.getLeadByPhone(params.phone);
    if (!lead) {
      return { success: false, error: "Lead not found" };
    }

    await context.db.updateReceiptData(lead.id, {
      receipt_data: params.receipt_data,
      tariff: params.tariff,
      annual_kwh: params.annual_kwh,
    });

    return {
      success: true,
      leadId: lead.id,
      tariff: params.tariff ?? null,
      annual_kwh: params.annual_kwh ?? null,
    };
  },
};
