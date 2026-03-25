#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function printUsage() {
  console.log(`Usage: node scripts/reset-agent-main-session.mjs [options] <agent-id> [agent-id...]

Reset the persisted agent:<agent-id>:main session entry and its transcript so the
next direct role turn starts from a fresh main-session state.

Options:
  --dry-run            Show what would be reset without changing disk state
  --json               Print machine-readable output
  --state-dir <path>   Override the OpenClaw state dir (default: ~/.openclaw)
  -h, --help           Show this help

Examples:
  node scripts/reset-agent-main-session.mjs coder-bot
  node scripts/reset-agent-main-session.mjs toolsmith-bot coder-bot reviewer-bot
  node scripts/reset-agent-main-session.mjs --dry-run --json coder-bot
`);
}

function expandHome(inputPath) {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }
  return path.join(os.homedir(), inputPath.slice(1));
}

function parseArgs(argv) {
  const roles = [];
  let dryRun = false;
  let json = false;
  let stateDir = path.join(os.homedir(), ".openclaw");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--state-dir") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--state-dir requires a value");
      }
      stateDir = path.resolve(expandHome(next));
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    roles.push(arg);
  }

  if (roles.length === 0) {
    throw new Error("At least one agent id is required");
  }

  return { dryRun, json, roles, stateDir };
}

async function readStore(storePath) {
  const raw = await fs.readFile(storePath, "utf8");
  return JSON.parse(raw);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resetAgentMainSession({ stateDir, role, dryRun }) {
  const sessionsDir = path.join(stateDir, "agents", role, "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = `agent:${role}:main`;

  if (!(await fileExists(storePath))) {
    return {
      role,
      sessionKey,
      storePath,
      changed: false,
      reason: "store-missing",
    };
  }

  const store = await readStore(storePath);
  const entry = store?.[sessionKey];
  if (!entry || typeof entry !== "object") {
    return {
      role,
      sessionKey,
      storePath,
      changed: false,
      reason: "session-missing",
    };
  }

  const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : null;
  const configuredSessionFile =
    typeof entry.sessionFile === "string" && entry.sessionFile.trim()
      ? entry.sessionFile.trim()
      : null;
  const transcriptPath = configuredSessionFile
    ? path.resolve(sessionsDir, expandHome(configuredSessionFile))
    : sessionId
      ? path.join(sessionsDir, `${sessionId}.jsonl`)
      : null;
  const transcriptExists = transcriptPath ? await fileExists(transcriptPath) : false;

  if (!dryRun) {
    delete store[sessionKey];
    await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    if (transcriptPath && transcriptExists) {
      await fs.rm(transcriptPath);
    }
  }

  return {
    role,
    sessionKey,
    storePath,
    sessionId,
    transcriptPath,
    transcriptExisted: transcriptExists,
    changed: true,
    dryRun,
  };
}

function printHuman(results, { dryRun, stateDir }) {
  console.log(`${dryRun ? "Previewing" : "Resetting"} agent main sessions under ${stateDir}`);
  for (const result of results) {
    if (!result.changed) {
      console.log(`- ${result.role}: no change (${result.reason})`);
      continue;
    }
    console.log(`- ${result.role}: cleared ${result.sessionKey}`);
    console.log(`  store: ${result.storePath}`);
    if (result.sessionId) {
      console.log(`  sessionId: ${result.sessionId}`);
    }
    if (result.transcriptPath) {
      console.log(
        `  transcript: ${result.transcriptPath}${result.transcriptExisted ? "" : " (missing)"}`,
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = [];
  for (const role of options.roles) {
    results.push(await resetAgentMainSession({ ...options, role }));
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          stateDir: options.stateDir,
          dryRun: options.dryRun,
          results,
        },
        null,
        2,
      ),
    );
    return;
  }
  printHuman(results, options);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
