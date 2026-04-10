#!/usr/bin/env -S node --import tsx

import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  clampOneLine,
  extractTraceMessagesFromSessionLine,
  parseFeishuSessionTraceArgs,
  redactTraceText,
  type FeishuSessionTraceArgs,
} from "../src/scripts/feishu-session-trace-shared.js";

async function sendFeishuMessage(text: string, args: FeishuSessionTraceArgs): Promise<void> {
  const command = [
    "openclaw",
    "message",
    "send",
    "--channel",
    "feishu",
    "--target",
    args.target,
    "--message",
    text,
  ];
  if (args.account) {
    command.push("--account", args.account);
  }
  if (args.dryRun) {
    command.push("--dry-run");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`openclaw message send failed (exit ${code}): ${stderr || stdout}`));
    });
  });
}

async function main() {
  const args = parseFeishuSessionTraceArgs(process.argv.slice(2));
  const tail = spawn("tail", ["-n", "0", "-F", args.sessionFile], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  tail.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      console.error(text);
    }
  });

  const lines = readline.createInterface({
    input: tail.stdout,
    crlfDelay: Infinity,
  });

  let lastSentAt = 0;
  for await (const line of lines) {
    for (const summary of extractTraceMessagesFromSessionLine(line)) {
      const now = Date.now();
      if (now - lastSentAt < args.minIntervalMs) {
        continue;
      }
      const safe = clampOneLine(redactTraceText(summary), args.maxLen);
      await sendFeishuMessage(safe, args);
      lastSentAt = now;
    }
  }
}

void main().catch((error) => {
  console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
  process.exitCode = 1;
});
