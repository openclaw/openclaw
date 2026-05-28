#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

const COMMAND_MAP = Object.freeze({
  status: "capital-hft:quote:status",
  "quote-read": "capital-hft:quote:read",
  "quote-pump": "capital-hft:quote:pump",
  "quote-ui": "capital-hft:quote:ui",
  "stock-list": "capital-hft:hft:stock-list",
  "paper-loop": "capital-hft:paper-loop",
  "paper-loop-check": "capital-hft:paper-loop:check",
  "paper-trigger": "capital-hft:paper-hft:trigger",
  "paper-trigger-check": "capital-hft:paper-hft:trigger:check",
  "capital-overseas-rotation": "capital-hft:capital:overseas-rotation",
  "capital-overseas-rotation-check": "capital-hft:capital:overseas-rotation:check",
  "capital-master-checklist": "capital-hft:capital:master-flow-checklist",
});

function printHelp() {
  console.log(`OpenClaw CapitalHftService CLI wrapper

Usage:
  pnpm capital-hft:cli <command> [-- <args...>]

Commands:
  status              -> capital-hft:quote:status
  quote-read          -> capital-hft:quote:read
  quote-pump          -> capital-hft:quote:pump
  quote-ui            -> capital-hft:quote:ui
  stock-list          -> capital-hft:hft:stock-list
  paper-loop          -> capital-hft:paper-loop
  paper-loop-check    -> capital-hft:paper-loop:check
  paper-trigger       -> capital-hft:paper-hft:trigger
  paper-trigger-check -> capital-hft:paper-hft:trigger:check
  capital-overseas-rotation       -> capital-hft:capital:overseas-rotation
  capital-overseas-rotation-check -> capital-hft:capital:overseas-rotation:check
  capital-master-checklist        -> capital-hft:capital:master-flow-checklist

Example:
  pnpm capital-hft:cli stock-list -- --json --market 2
`);
}

function splitForwardArgs(argv) {
  const sep = argv.indexOf("--");
  if (sep < 0) {
    return { head: argv, tail: [] };
  }
  return { head: argv.slice(0, sep), tail: argv.slice(sep + 1) };
}

const { head, tail } = splitForwardArgs(args);
const command = head[0];
const dryRun = head.includes("--dry-run");

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

const scriptName = COMMAND_MAP[command];
if (!scriptName) {
  console.error(`[capital-hft:cli] unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

const runArgs = ["run", scriptName, ...(tail.length > 0 ? ["--", ...tail] : [])];
if (dryRun) {
  console.log(`pnpm ${runArgs.join(" ")}`);
  process.exit(0);
}

const result = spawnSync("pnpm", runArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
