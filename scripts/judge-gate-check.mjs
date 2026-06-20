#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import {
  createJudgeAuditRecord,
  evaluateJudgePacket,
  formatJudgeVerdict,
  parseJudgeVerdict,
} from "./lib/judge-gate.mjs";

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function parseArgs(argv) {
  const args = { mode: "packet", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--packet-file") {
      args.packetFile = argv[++index];
    } else if (arg === "--packet-json") {
      args.packetJson = argv[++index];
    } else if (arg === "--verdict-file") {
      args.verdictFile = argv[++index];
      args.mode = "verdict";
    } else if (arg === "--verdict-text") {
      args.verdictText = argv[++index];
      args.mode = "verdict";
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/judge-gate-check.mjs --packet-file packet.json [--json]",
    "  node scripts/judge-gate-check.mjs --packet-json '{...}' [--json]",
    "  node scripts/judge-gate-check.mjs --verdict-file verdict.txt [--json]",
    "  node scripts/judge-gate-check.mjs --verdict-text 'VERDICT: ...' [--json]",
    "",
    "Without a file/text argument, JSON packet input is read from stdin.",
  ].join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.mode === "verdict") {
    const text = args.verdictText ?? fs.readFileSync(args.verdictFile, "utf8");
    const result = parseJudgeVerdict(text);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log("Judge verdict schema: ok");
    } else {
      console.error(`Judge verdict schema: failed\n- ${result.errors.join("\n- ")}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const rawPacket =
    args.packetJson ?? (args.packetFile ? fs.readFileSync(args.packetFile, "utf8") : readStdin());
  const packet = JSON.parse(rawPacket);
  const verdict = evaluateJudgePacket(packet);
  const audit = createJudgeAuditRecord(packet, verdict);

  if (args.json) {
    console.log(JSON.stringify({ verdict, audit, text: formatJudgeVerdict(verdict) }, null, 2));
  } else {
    console.log(formatJudgeVerdict(verdict));
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
