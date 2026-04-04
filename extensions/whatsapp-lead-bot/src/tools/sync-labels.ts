/**
 * Tool: sync_labels
 *
 * Synchronizes WhatsApp labels with lead scores and statuses in the database.
 * Recomputes scores from lead data before applying labels.
 */

import type { Database } from "../database.js";
import type { LabelService } from "../labels.js";
import type { Runtime } from "../runtime.js";
import { computeScore } from "../scoring.js";

export const syncLabelsTool = {
  name: "sync_labels",
  description:
    "Recompute scores for all leads from their data (location, bimonthly_bill, ownership) " +
    "and synchronize WhatsApp labels. Use after bulk DB changes or to fix label/score drift.",
  inputSchema: {
    type: "object" as const,
    properties: {
      dry_run: {
        type: "boolean" as const,
        description:
          "If true, report what would change without applying labels or updating scores.",
      },
    },
    required: [] as string[],
  },
  execute: async (
    params: { dry_run?: boolean },
    context: { db: Database; labelService: LabelService; runtime: Runtime },
  ) => {
    const { db, labelService, runtime } = context;
    const dryRun = params.dry_run ?? false;

    const allLeads = await db.listLeads();

    const results = {
      synced: [] as {
        phone: string;
        name: string | null;
        previousScore: string | null;
        computedScore: string | null;
        status: string;
        scoreChanged: boolean;
      }[],
      errors: [] as { phone: string; error: string }[],
    };

    const BATCH_SIZE = 10;
    const BATCH_PAUSE_MS = 15_000; // 15s pause between batches of 10

    for (let i = 0; i < allLeads.length; i++) {
      const lead = allLeads[i];
      const phone = lead.phone_number;

      // Skip invalid phone numbers
      if (!phone || phone.startsWith("+") || phone.startsWith("0") || phone.length < 10) {
        continue;
      }

      const previousScore = lead.score ?? null;
      const status = lead.status ?? "new";

      // Recompute score from data
      const computedScore = computeScore({
        location: lead.location,
        bimonthly_bill: lead.bimonthly_bill,
        ownership: lead.ownership,
      });

      const scoreChanged = computedScore !== null && computedScore !== previousScore;

      try {
        if (!dryRun) {
          // Update score in DB if it changed
          if (scoreChanged) {
            await db.upsertLead(phone, { score: computedScore });
            console.log(
              `[sync_labels] Recomputed: ${phone} ${previousScore || "null"} → ${computedScore} (${lead.location}, $${lead.bimonthly_bill})`,
            );
          }

          // Apply labels (use computed score, or keep existing if data is incomplete)
          const effectiveScore = computedScore ?? previousScore;
          await labelService.syncAll(phone, effectiveScore, status, runtime);

          // Pause between batches to avoid WhatsApp rate limits (429)
          if ((i + 1) % BATCH_SIZE === 0 && i + 1 < allLeads.length) {
            console.log(
              `[sync_labels] Batch ${Math.floor(i / BATCH_SIZE) + 1} done (${i + 1}/${allLeads.length}), pausing ${BATCH_PAUSE_MS / 1000}s...`,
            );
            await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
          }
        }

        results.synced.push({
          phone,
          name: lead.name ?? null,
          previousScore,
          computedScore,
          status,
          scoreChanged,
        });
      } catch (err: any) {
        results.errors.push({ phone, error: err.message ?? String(err) });
      }
    }

    const recomputedCount = results.synced.filter((r) => r.scoreChanged).length;

    return {
      success: true,
      dry_run: dryRun,
      summary: {
        total_processed: results.synced.length,
        scores_recomputed: recomputedCount,
        errors: results.errors.length,
      },
      details: results,
    };
  },
};
