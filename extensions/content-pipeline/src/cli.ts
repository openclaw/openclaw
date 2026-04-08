#!/usr/bin/env bun
/**
 * Content Pipeline CLI
 *
 * Usage:
 *   npx tsx src/cli.ts run news                      # Full news pipeline
 *   npx tsx src/cli.ts run tutorial "Docker basics"   # Tutorial pipeline
 *   npx tsx src/cli.ts run news --stage scrape        # Stop after scraping
 *   npx tsx src/cli.ts run news --skip-upload         # No upload
 *   npx tsx src/cli.ts preview                        # Show top articles
 *   npx tsx src/cli.ts bot discord                    # Start Discord bot
 *   npx tsx src/cli.ts bot zalo                       # Start Zalo bot
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config as loadEnv } from "dotenv";

// Load .env from extension root
const __cliDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__cliDir, "..", ".env") });

import { runPipeline, loadConfig, type Stage } from "./pipeline.js";
import { scrapeAll } from "./steps/01-scrape/index.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "run":
      await handleRun(args.slice(1));
      break;
    case "preview":
      await handlePreview();
      break;
    case "list":
      await handleList();
      break;
    case "bot":
      await handleBot(args.slice(1));
      break;
    case "approve":
      await handleApproveReject("approve", args[1]);
      break;
    case "reject":
      await handleApproveReject("reject", args[1]);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function handleRun(args: string[]) {
  const pipelineType = args[0] as "news" | "tutorial";

  if (!pipelineType || !["news", "tutorial"].includes(pipelineType)) {
    console.error("Usage: pipeline run <news|tutorial> [topic] [--stage <stage>] [--skip-upload]");
    process.exit(1);
  }

  let topic: string | undefined;
  let stopAtStage: Stage | undefined;
  let skipUpload = false;

  // Parse remaining args
  let i = 1;
  while (i < args.length) {
    if (args[i] === "--stage" && args[i + 1]) {
      stopAtStage = args[i + 1] as Stage;
      i += 2;
    } else if (args[i] === "--skip-upload") {
      skipUpload = true;
      i++;
    } else if (!topic && pipelineType === "tutorial") {
      topic = args[i];
      i++;
    } else {
      i++;
    }
  }

  if (pipelineType === "tutorial" && !topic) {
    console.error('Tutorial pipeline requires a topic: pipeline run tutorial "Your topic"');
    process.exit(1);
  }

  console.log(`\n🚀 Starting ${pipelineType} pipeline...`);
  if (stopAtStage) console.log(`   Stopping after: ${stopAtStage}`);
  if (skipUpload) console.log("   Skipping upload");
  console.log("");

  await runPipeline({
    pipelineType,
    topic,
    stopAtStage,
    skipUpload,
  });
}

async function handlePreview() {
  const config = loadConfig();
  const articles = await scrapeAll(config.sources, {
    poolSize: config.content.poolSize,
    maxPerSource: config.content.maxPerSource,
  });

  console.log("\n┌────┬────────────────────────────────────────────────┬───────────────┬───────┐");
  console.log("│  # │ Title                                          │ Source        │ Score │");
  console.log("├────┼────────────────────────────────────────────────┼───────────────┼───────┤");

  for (const [i, article] of articles.entries()) {
    const title = article.title.slice(0, 46).padEnd(46);
    const source = article.source.slice(0, 13).padEnd(13);
    const score = String(article.score).padStart(5);
    console.log(`│ ${String(i + 1).padStart(2)} │ ${title} │ ${source} │ ${score} │`);
  }

  console.log("└────┴────────────────────────────────────────────────┴───────────────┴───────┘");

  // Source distribution
  const dist = new Map<string, number>();
  for (const a of articles) dist.set(a.source, (dist.get(a.source) ?? 0) + 1);
  const distLine = [...dist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}: ${n}`)
    .join(", ");

  console.log(`\nTotal: ${articles.length} articles from ${dist.size} sources`);
  console.log(`  ${distLine}`);
}

async function handleList() {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = join(__dirname, "..", "output");

  try {
    const dirs = readdirSync(outputDir)
      .filter((d) => statSync(join(outputDir, d)).isDirectory())
      .sort()
      .reverse()
      .slice(0, 10);

    if (dirs.length === 0) {
      console.log("No pipeline runs found.");
      return;
    }

    console.log("\nRecent pipeline runs:");
    for (const dir of dirs) {
      const resultPath = join(outputDir, dir, "upload_results.json");
      let status = "in-progress";
      try {
        const results = JSON.parse(readFileSync(resultPath, "utf-8"));
        const platforms = results
          .map(
            (r: { platform: string; status: string }) =>
              `${r.platform}:${r.status === "success" ? "✓" : "✗"}`,
          )
          .join(" ");
        status = platforms;
      } catch {
        // No upload results yet
      }
      console.log(`  ${dir}  ${status}`);
    }
  } catch {
    console.log("No output directory found. Run a pipeline first.");
  }
}

async function handleApproveReject(action: string, runId?: string) {
  const { readdirSync, readFileSync: rfs, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const outputBase = resolve(__cliDir, "..", "output");

  // Find pending approvals
  const pending: Array<{ runId: string; outputDir: string; data: Record<string, unknown> }> = [];
  try {
    for (const dir of readdirSync(outputBase)) {
      const f = resolve(outputBase, dir, "approval.json");
      if (existsSync(f)) {
        const data = JSON.parse(rfs(f, "utf-8"));
        if (data.status === "pending")
          pending.push({ runId: dir, outputDir: resolve(outputBase, dir), data });
      }
    }
  } catch {}

  if (pending.length === 0) {
    console.log("No pending approvals.");
    return;
  }

  const target = runId ? pending.find((p) => p.runId === runId) : pending[0];
  if (!target) {
    console.log(`Run "${runId}" not found. Pending: ${pending.map((p) => p.runId).join(", ")}`);
    return;
  }

  const { getAllPendingApprovals, handleApproval, handleRejection } = await import("./approval.js");
  getAllPendingApprovals().set(target.runId, target.data as never);

  if (action === "approve") {
    console.log(
      `✅ Approving "${(target.data as Record<string, string>).videoTitle}" → uploading to platforms...`,
    );
    const results = await handleApproval(target.runId);
    console.log("\nPublish results:", JSON.stringify(results, null, 2));
  } else {
    console.log(`❌ Rejecting "${(target.data as Record<string, string>).videoTitle}"`);
    await handleRejection(target.runId);
  }
}

async function handleBot(args: string[]) {
  const botType = args[0];

  if (botType === "discord") {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.error("Set DISCORD_BOT_TOKEN in .env");
      process.exit(1);
    }
    const { startDiscordBot } = await import("./bot/discord.js");
    startDiscordBot(token);
    // Keep process alive
    await new Promise(() => {});
  } else if (botType === "zalo") {
    const { startBot } = await import("./bot/server.js");
    startBot({
      port: parseInt(process.env.ZALO_BOT_PORT ?? "5000", 10),
      oaAccessToken: process.env.ZALO_OA_ACCESS_TOKEN ?? "",
      oaSecretKey: process.env.ZALO_OA_SECRET_KEY ?? "",
      allowedUserIds: (process.env.ZALO_ALLOWED_USERS ?? "").split(",").filter(Boolean),
    });
    await new Promise(() => {});
  } else {
    console.error("Usage: pipeline bot <discord|zalo>");
    process.exit(1);
  }
}

function readFileSync(path: string, encoding: string): string {
  const { readFileSync: rfs } = require("node:fs");
  return rfs(path, encoding);
}

function printHelp() {
  console.log(`
Content Pipeline CLI

Commands:
  run news                          Run news pipeline (scrape → video → approval)
  run tutorial "topic"              Run tutorial pipeline for a given topic
  preview                           Scrape and preview top articles
  approve [runId]                   Approve pending video → publish to YT/FB/TikTok
  reject [runId]                    Reject pending video
  list                              List recent pipeline runs
  bot discord                       Start Discord bot
  bot zalo                          Start Zalo webhook bot

Options for 'run':
  --stage <scrape|content|slides|video>   Stop after this stage
  --skip-upload                            Skip cloud upload + approval

Workflow:
  1. npx tsx src/cli.ts run news           # Creates video, sends to Discord for approval
  2. Reply "approve" in #published-news    # Or: npx tsx src/cli.ts approve
  3. Video uploads to YouTube/Facebook/TikTok automatically

Examples:
  npx tsx src/cli.ts run news
  npx tsx src/cli.ts approve
  npx tsx src/cli.ts reject
  npx tsx src/cli.ts run tutorial "Getting started with Docker"
  npx tsx src/cli.ts preview
`);
}

main().catch((err) => {
  console.error("\n❌ Pipeline failed:", err.message);
  process.exit(1);
});
