// Orchestrator. Run with `npm run weekly` (or `npm run weekly:dry`).

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExaClient } from "./exa-client.js";
import { sourceProspects } from "./source-prospects.js";
import { detectTools } from "./detect-tools.js";
import { findRecentNews } from "./find-recent-news.js";
import { findContact } from "./find-contact.js";
import { draftEmail } from "./draft-email.js";
import { pushDraftToGmail } from "./push-to-gmail.js";
import { appendContacted, loadContacted } from "./track-contacted.js";
import { sendSummary, buildSummaryText } from "./notify-summary.js";
import type { ProspectRun, RawProspect, RunOptions } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");

// Tiny .env loader. Avoids pulling in dotenv as a dep.
function loadEnv(): void {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function readOptions(): RunOptions {
  const dryRun = process.argv.includes("--dry-run");
  const exaApiKey = process.env.EXA_API_KEY ?? "";
  const gmailAccount = process.env.GMAIL_ACCOUNT ?? "jeff@hypelab.digital";
  const notifyPhone = process.env.NOTIFY_PHONE ?? "+15166334684";
  const prospectsPerRun = Number(process.env.PROSPECTS_PER_RUN ?? "10");
  if (!exaApiKey) throw new Error("EXA_API_KEY not set. Copy .env.example to .env on forge.");
  return { dryRun, exaApiKey, gmailAccount, notifyPhone, prospectsPerRun };
}

async function processProspect(
  exa: ExaClient,
  prospect: RawProspect,
  options: RunOptions,
): Promise<ProspectRun | null> {
  console.log(`[run] ${prospect.name} (${prospect.domain})`);
  try {
    const detected = await detectTools(exa, prospect);
    console.log(`  detected tool: ${detected.tool} (${detected.confidence})`);
    const news = await findRecentNews(exa, prospect);
    console.log(`  news: ${news ? news.headline.slice(0, 60) : "(none)"}`);
    const contact = await findContact(exa, prospect);
    console.log(
      `  contact: ${contact.first_name} ${contact.last_name} <${contact.email}> [${contact.confidence}]`,
    );
    const draft = await draftEmail({
      agency: prospect,
      detected,
      news,
      contact,
    });
    console.log(`  drafted subject: "${draft.subject}"`);

    let gmailDraftId: string | undefined;
    let gmailDraftUrl: string | undefined;
    if (!options.dryRun) {
      const result = await pushDraftToGmail({
        account: options.gmailAccount,
        to: contact.email,
        contact,
        draft,
      });
      gmailDraftId = result.draft_id;
      gmailDraftUrl = result.draft_url;
      console.log(`  gmail draft id: ${gmailDraftId ?? "(unknown)"}`);
    } else {
      console.log("  [dry-run] skipping Gmail push");
    }

    return {
      prospect,
      detected,
      news,
      contact,
      draft,
      gmail_draft_id: gmailDraftId,
      gmail_draft_url: gmailDraftUrl,
    };
  } catch (err) {
    console.error(`[run] failed on ${prospect.name}:`, (err as Error).message);
    return null;
  }
}

async function weekly(): Promise<void> {
  loadEnv();
  const options = readOptions();
  console.log(
    `[runpr-outreach] weekly run starting. dryRun=${options.dryRun} target=${options.prospectsPerRun}`,
  );

  const exa = new ExaClient(options.exaApiKey);
  const contacted = await loadContacted();
  console.log(`[runpr-outreach] ${contacted.prospects.length} agencies already contacted`);

  const fresh = await sourceProspects(exa, contacted, options.prospectsPerRun);
  console.log(`[runpr-outreach] sourced ${fresh.length} fresh prospect candidates`);

  const runs: ProspectRun[] = [];
  for (const prospect of fresh) {
    if (runs.length >= options.prospectsPerRun) break;
    const result = await processProspect(exa, prospect, options);
    if (result) runs.push(result);
  }

  console.log(`[runpr-outreach] ${runs.length} drafts produced`);

  if (!options.dryRun && runs.length > 0) {
    await appendContacted(
      runs.map((r) => ({
        name: r.prospect.name,
        domain: r.prospect.domain,
        contacted_at: new Date().toISOString().slice(0, 10),
        source: "weekly-cron",
      })),
    );
    console.log("[runpr-outreach] tracker updated");
  } else if (options.dryRun) {
    console.log("[runpr-outreach] [dry-run] skipping tracker update");
    console.log("\n--- SUMMARY (would have been sent via imsg) ---");
    console.log(buildSummaryText(runs, true));
    console.log("--- END SUMMARY ---\n");
  }

  if (!options.dryRun) {
    try {
      await sendSummary(options.notifyPhone, runs, false);
      console.log("[runpr-outreach] summary sent via imsg");
    } catch (err) {
      console.error("[runpr-outreach] imsg summary failed:", (err as Error).message);
    }
  }
}

const sub = process.argv[2];
if (sub === "weekly") {
  weekly().catch((err) => {
    console.error("[runpr-outreach] fatal:", err);
    process.exit(1);
  });
} else {
  console.error("usage: node dist/index.js weekly [--dry-run]");
  process.exit(2);
}
