#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function usage() {
  console.error(
    "Usage: node scripts/append_operational_ledger.cjs --event <name> --status <status> [--artifact <path>] [--workflow <id>] [--reason <text>]",
  );
}

function parseArgs(argv) {
  const args = {
    artifacts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--event") {
      args.event = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--status") {
      args.status = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--artifact") {
      args.artifacts.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === "--workflow") {
      args.workflow = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--reason") {
      args.reason = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.event || !args.status) {
    usage();
    throw new Error("Both --event and --status are required.");
  }

  return args;
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const ledgerPath = path.join(repoRoot, "ledgers", "operational_ledger.ndjson");
  const { event, status, artifacts, workflow, reason } = parseArgs(process.argv.slice(2));

  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

  const entry = {
    event_id: crypto.randomUUID(),
    event,
    status,
    workflow: workflow ?? null,
    reason: reason ?? null,
    artifacts,
    recorded_at: new Date().toISOString(),
  };

  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
