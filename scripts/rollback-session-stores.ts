#!/usr/bin/env -S node --import tsx

import path from "node:path";
import { listAgentSessionDirs } from "../src/commands/cleanup-utils.js";
import { loadConfig } from "../src/config/config.js";
import { STATE_DIR } from "../src/config/paths.js";
import { resolveStorePath } from "../src/config/sessions/paths.js";
import { isDirectorySessionStoreActive } from "../src/config/sessions/store-directory.js";
import { migrateSessionStoreToLegacy } from "../src/config/sessions/store.js";

type Args = {
  dryRun: boolean;
  help: boolean;
  storePaths: string[];
};

function printUsage(): void {
  console.log(`Usage: node --import tsx scripts/rollback-session-stores.ts [options]

Restore migrated session stores back to legacy sessions.json snapshots.

Options:
  --store <path>   Roll back a specific sessions.json path. Repeatable.
  --dry-run        Show what would be restored without changing disk state.
  --help           Show this help message.

If no --store arguments are provided, the script targets the same session stores
that gateway startup migration scans: each agent sessions.json under ${STATE_DIR}
plus the configured session.store path, when present.`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    help: false,
    storePaths: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--store") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--store requires a path");
      }
      args.storePaths.push(path.resolve(next));
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

async function resolveDefaultStoreTargets(): Promise<string[]> {
  const targets = new Set<string>();
  for (const sessionsDir of await listAgentSessionDirs(STATE_DIR)) {
    targets.add(path.join(sessionsDir, "sessions.json"));
  }
  const cfg = loadConfig();
  if (cfg.session?.store) {
    targets.add(resolveStorePath(cfg.session.store));
  }
  return [...targets].toSorted();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const targets =
    args.storePaths.length > 0 ? [...new Set(args.storePaths)] : await resolveDefaultStoreTargets();
  if (targets.length === 0) {
    console.log("No session stores found.");
    return;
  }

  let restored = 0;
  let skipped = 0;

  for (const storePath of targets) {
    const active = isDirectorySessionStoreActive(storePath);
    if (args.dryRun) {
      console.log(`${active ? "would restore" : "would skip"} ${storePath}`);
      if (active) {
        restored += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const changed = await migrateSessionStoreToLegacy(storePath);
    console.log(`${changed ? "restored" : "skipped"} ${storePath}`);
    if (changed) {
      restored += 1;
    } else {
      skipped += 1;
    }
  }

  console.log(`Summary: restored ${restored}, skipped ${skipped}`);
}

void main().catch((err) => {
  console.error(`rollback-session-stores: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
