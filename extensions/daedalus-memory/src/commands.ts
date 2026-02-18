/**
 * CLI registration for DAEDALUS trust-scored memory commands.
 *
 * Registers subcommands under the `daedalus` root command using Commander.js.
 * All DB access goes through the DaedalusDb public interface.
 */

import type { Command } from "commander";
import type { DaedalusDb } from "./db.js";
import type { TrustLevel } from "./trust.js";
import { formatFactDetail, formatSearchResultsForTool } from "./retrieval.js";

interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** Registers the `daedalus` CLI command tree on the given Commander program. */
export function registerDaedalusMemoryCli(params: {
  program: Command;
  db: DaedalusDb;
  logger: Logger;
}): void {
  const { program, db, logger } = params;

  const root = program
    .command("daedalus")
    .description("DAEDALUS trust-scored memory commands");

  // -- pending ---------------------------------------------------------------

  root
    .command("pending")
    .description("List AI-suggested facts awaiting human review")
    .option("--limit <n>", "Maximum number of facts to show", "20")
    .action(async (opts: { limit: string }) => {
      try {
        const limit = parseInt(opts.limit, 10);
        const facts = db.listPending(limit);

        if (facts.length === 0) {
          console.log("No pending facts awaiting review.");
          return;
        }

        for (const fact of facts) {
          const ageDays = Math.floor(
            (Date.now() - Date.parse(fact.created_at)) / 86_400_000,
          );
          console.log(`[${fact.id}] (age: ${ageDays} days) ${fact.fact_text}`);
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // -- approve ---------------------------------------------------------------

  root
    .command("approve <id>")
    .description("Approve a suggested fact (green → blue)")
    .option("--notes <text>", "Optional notes for the transition")
    .action(async (id: string, opts: { notes?: string }) => {
      try {
        const fact = db.updateTrustLevel(id, "blue", "human_approve", "user", opts.notes);
        console.log(`Approved: ${fact.id} — trust level is now blue (verified)`);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // -- reject ----------------------------------------------------------------

  root
    .command("reject <id>")
    .description("Reject a fact (green → red or blue → red)")
    .option("--notes <text>", "Optional notes for the transition")
    .action(async (id: string, opts: { notes?: string }) => {
      try {
        const fact = db.updateTrustLevel(id, "red", "human_reject", "user", opts.notes);
        console.log(`Rejected: ${fact.id} — trust level is now red (quarantined)`);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // -- resolve ---------------------------------------------------------------

  root
    .command("resolve <id>")
    .description("Reinstate a quarantined fact (red → blue)")
    .option("--notes <text>", "Optional notes for the transition")
    .action(async (id: string, opts: { notes?: string }) => {
      try {
        const fact = db.updateTrustLevel(id, "blue", "human_resolve", "user", opts.notes);
        console.log(`Resolved: ${fact.id} — trust level is now blue (verified)`);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // -- info ------------------------------------------------------------------

  root
    .command("info <id>")
    .description("Show full detail for a fact including transition history")
    .action(async (id: string) => {
      try {
        const fact = db.getFact(id);
        if (!fact) {
          logger.error(`Fact not found: ${id}`);
          return;
        }

        const transitions = db.getTransitionHistory(id);
        console.log(formatFactDetail(fact, transitions));
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // -- stats -----------------------------------------------------------------

  root
    .command("stats")
    .description("Show memory statistics by trust level")
    .action(async () => {
      try {
        const stats = db.getStats();
        console.log(`Memory Statistics:
  Total:       ${stats.total}
  Verified:    ${stats.blue} (blue)
  Suggested:   ${stats.green} (green)
  Quarantined: ${stats.red} (red)`);
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // -- search ----------------------------------------------------------------

  root
    .command("search <query>")
    .description("Search facts by keyword")
    .option("--limit <n>", "Maximum number of results", "5")
    .option("--trust <levels>", "Comma-separated trust levels", "blue,green")
    .action(async (query: string, opts: { limit: string; trust: string }) => {
      try {
        const limit = parseInt(opts.limit, 10);
        const trust_levels = opts.trust.split(",").map((s) => s.trim()) as TrustLevel[];
        const results = db.searchFacts(query, { limit, trust_levels });
        console.log(formatSearchResultsForTool(results, query));
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  // -- stale -----------------------------------------------------------------

  root
    .command("stale")
    .description("Run staleness check and demote expired green facts")
    .option("--days <n>", "Number of days before a fact is considered stale", "7")
    .action(async (opts: { days: string }) => {
      try {
        const days = parseInt(opts.days, 10);
        const count = db.runStalenessCheck(days);

        if (count === 0) {
          console.log("No stale facts found.");
        } else {
          console.log(`Staleness check complete: ${count} facts demoted to red.`);
        }
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
