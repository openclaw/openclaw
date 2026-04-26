#!/usr/bin/env node
/**
 * Agent 42 — Permission Gate
 *
 * EVERY transaction, financial action, or life-affecting decision
 * MUST pass through this gate before execution.
 *
 * Rules:
 *  1. Always prompt the owner (Jared) or the acting user explicitly.
 *  2. Never proceed on assumption — only on confirmed "yes".
 *  3. Log every gate event with timestamp, actor, action, and decision.
 *  4. Deny by default if stdin is not a TTY (non-interactive contexts).
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = path.join(ROOT, ".artifacts", "agent42-permission-log.jsonl");

function logEvent(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + "\n");
}

/**
 * Ask for explicit permission before any transaction or life-affecting action.
 *
 * @param {object} params
 * @param {string} params.actor   - Who is requesting (e.g. "agent42", "user")
 * @param {string} params.action  - Short description of the action
 * @param {string} params.detail  - Full detail so the user can make an informed decision
 * @returns {Promise<boolean>}    - true = approved, false = denied
 */
export async function requestPermission({ actor, action, detail }) {
  // Non-interactive guard — deny automatically, never silently proceed
  if (!process.stdin.isTTY) {
    logEvent({ actor, action, detail, decision: "auto-denied", reason: "non-interactive" });
    console.error(
      `\n[Agent 42 Permission Gate]\n` +
        `  Action  : ${action}\n` +
        `  Detail  : ${detail}\n` +
        `  DENIED  — requires interactive confirmation from Jared / user.\n` +
        `            Run this command in an interactive terminal.\n`,
    );
    return false;
  }

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Agent 42 — Permission Required                      ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
  console.log(`  Actor   : ${actor}`);
  console.log(`  Action  : ${action}`);
  console.log(`  Detail  : ${detail}`);
  console.log(``);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise((resolve) => {
    rl.question(`  Approve? Type YES to confirm, anything else to deny: `, resolve);
  });
  rl.close();

  const approved = answer.trim().toUpperCase() === "YES";
  const decision = approved ? "approved" : "denied";

  logEvent({ actor, action, detail, decision, rawAnswer: answer.trim() });

  if (approved) {
    console.log(`  ✓ Approved. Proceeding.\n`);
  } else {
    console.log(`  ✗ Denied. Action cancelled.\n`);
  }

  return approved;
}

/**
 * Synchronous variant for scripts that cannot use top-level await.
 * Reads a single line from stdin via a child process.
 * Still requires interactive TTY — denies automatically otherwise.
 */
export function requestPermissionSync({ actor, action, detail }) {
  if (!process.stdin.isTTY) {
    logEvent({ actor, action, detail, decision: "auto-denied", reason: "non-interactive-sync" });
    console.error(`[Agent 42] DENIED (non-interactive): ${action}`);
    return false;
  }

  const { execFileSync } = await import("node:child_process").then((m) => m);
  // Prompt via PowerShell on Windows, read from /dev/tty on POSIX
  let answer = "";
  try {
    if (process.platform === "win32") {
      const raw = execFileSync("powershell", [
        "-NoProfile",
        "-Command",
        `Write-Host ""; Write-Host "[Agent 42 Permission Gate]"; Write-Host "  Action  : ${action}"; Write-Host "  Detail  : ${detail}"; $r = Read-Host "  Approve? Type YES"; $r`,
      ], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
      answer = raw.trim();
    }
  } catch {
    answer = "";
  }

  const approved = answer.toUpperCase() === "YES";
  logEvent({ actor, action, detail, decision: approved ? "approved" : "denied", rawAnswer: answer });
  return approved;
}
