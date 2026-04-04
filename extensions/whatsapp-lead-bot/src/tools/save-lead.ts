/**
 * Tool: save_lead
 *
 * Upserts a lead by phone number. Score is auto-computed from location,
 * bimonthly_bill, and ownership — never set by the LLM agent.
 */

import type { Database } from "../database.js";
import type { LabelService } from "../labels.js";
import type { Runtime } from "../runtime.js";
import { computeScore } from "../scoring.js";

export const saveLeadTool = {
  name: "save_lead",
  description:
    "Create or update a lead record by phone number. If the lead exists, only provided fields are updated. " +
    "Score is auto-computed when location and bimonthly_bill are available — do NOT pass a score.",
  inputSchema: {
    type: "object" as const,
    properties: {
      phone: { type: "string" as const, description: "Phone number (E.164 without +)" },
      name: { type: "string" as const, description: "Lead name" },
      location: { type: "string" as const, description: "City/state" },
      property_type: { type: "string" as const, description: "Casa, Negocio, etc." },
      ownership: { type: "string" as const, description: "Propia, Rentada, etc." },
      bimonthly_bill: { type: "number" as const, description: "Bimonthly electricity bill in MXN" },
      panels_quoted: { type: "number" as const, description: "Number of panels quoted" },
      quote_cash: { type: "number" as const, description: "Cash quote in MXN" },
      quote_financed: { type: "number" as const, description: "Financed quote in MXN" },
      notes: { type: "string" as const, description: "Free-text notes" },
    },
    required: ["phone"],
  },
  execute: async (
    params: {
      phone: string;
      name?: string;
      location?: string;
      property_type?: string;
      ownership?: string;
      bimonthly_bill?: number;
      panels_quoted?: number;
      quote_cash?: number;
      quote_financed?: number;
      notes?: string;
    },
    context: { db: Database; labelService: LabelService; runtime: Runtime },
  ) => {
    const { phone, ...data } = params;
    const { db, labelService, runtime } = context;

    // Strip score if the LLM passes it anyway — score is computed, never accepted
    delete (data as Record<string, unknown>).score;

    // Get previous state before upsert
    const existing = await db.getLeadByPhone(phone);
    const previousScore = existing?.score ?? null;

    const lead = await db.upsertLead(phone, data);

    // Update last_bot_reply_at — if save_lead is called, the bot is interacting with this lead
    if (lead.id) {
      await db.updateLastBotReply(lead.id, Date.now());
    }

    // Auto-compute score from current lead data
    const newScore = computeScore({
      location: lead.location,
      bimonthly_bill: lead.bimonthly_bill,
      ownership: lead.ownership,
    });

    // Write computed score if it changed
    if (newScore !== null && newScore !== lead.score) {
      await db.upsertLead(phone, { score: newScore });
      console.log(
        `[save_lead] Auto-score: ${phone} → ${newScore} (${lead.location}, $${lead.bimonthly_bill})`,
      );

      try {
        await labelService.applyScore(phone, newScore, runtime);
        console.log(
          `[save_lead] Score label applied: ${phone} ${previousScore || "null"} → ${newScore}`,
        );
      } catch (err) {
        console.error(`[save_lead] Failed to apply score label ${phone}:`, err);
      }
    } else if (newScore === null && lead.score !== null) {
      // Data changed in a way that invalidates the score (shouldn't normally happen,
      // but guard against it)
      console.log(
        `[save_lead] Score data incomplete after update, keeping existing score: ${phone} → ${lead.score}`,
      );
    }

    // Apply status label (BOT) for new leads
    const currentStatus = lead.status ?? "new";
    if (!existing) {
      try {
        await labelService.applyStatus(phone, currentStatus, runtime);
        console.log(`[save_lead] Status label applied: ${phone} → ${currentStatus}`);
      } catch (err) {
        console.error(`[save_lead] Failed to apply status label ${phone}:`, err);
      }
    }

    // Return the lead with the latest score
    const updatedLead =
      newScore !== null && newScore !== lead.score ? await db.getLeadByPhone(phone) : lead;

    return { success: true, lead: updatedLead };
  },
};
