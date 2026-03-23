#!/usr/bin/env bun
/**
 * Memory Hybrid Monitor
 *
 * Real-time dashboard for visualizing memory operations (Recall, Store, Summary).
 * Tails ~/.openclaw/memory/traces/thoughts.jsonl
 */

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_FILE = join(homedir(), ".openclaw", "memory", "traces", "thoughts.jsonl");

// ANSI Colors
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";

console.log(`${BOLD}${MAGENTA}🧠 Memory-Hybrid Deep Monitor${RESET}`);
console.log(`${GRAY}Tailing ${LOG_FILE}...${RESET}\n`);

let lastSize = 0;

async function processNewLines() {
  try {
    const content = await readFile(LOG_FILE, "utf-8");
    const lines = content.trim().split("\n");
    const newLines = lines.slice(lastSize);
    lastSize = lines.length;

    for (const line of newLines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        renderEvent(event);
      } catch (e) {
        // Skip malformed lines
      }
    }
  } catch (err) {
    if ((err as any).code !== "ENOENT") {
      console.error("Error reading log:", err);
    }
  }
}

function renderEvent(ev: any) {
  const time = new Date(ev.timestamp).toLocaleTimeString();
  const action = ev.action.toUpperCase();

  let color = BLUE;
  if (ev.action === "memory_store") color = GREEN;
  if (ev.action === "memory_recall") color = CYAN;
  if (ev.action === "conversation_summary") color = YELLOW;
  if (ev.action === "graph_update") color = MAGENTA;
  if (ev.action.includes("error")) color = RED;

  console.log(`${GRAY}[${time}]${RESET} ${BOLD}${color}${action}${RESET} ${ev.message || ""}`);

  if (ev.details) {
    if (ev.action === "memory_recall") {
      console.log(`   ${GRAY}Query: "${ev.details.query}"${RESET}`);
      ev.details.topResults?.forEach((r: any, i: number) => {
        console.log(`   ${GRAY}#${i + 1} [${r.score.toFixed(2)}] ${r.text}${RESET}`);
      });
    } else if (ev.action === "memory_store") {
      console.log(`   ${GRAY}Cat: ${ev.details.category} | ID: ${ev.details.id}${RESET}`);
      console.log(`   ${GRAY}Text: ${ev.details.text}${RESET}`);
    } else if (ev.action === "conversation_summary") {
      console.log(`   ${GRAY}Batch: ${ev.details.batchSize} turns${RESET}`);
      console.log(`   ${GRAY}Summary: ${ev.details.summary}${RESET}`);
    } else if (ev.details.error) {
      console.log(`   ${RED}Error: ${ev.details.error}${RESET}`);
    }
  }
  console.log(""); // Spacing
}

// Initial burst
processNewLines().then(() => {
  // Watch for changes
  watch(LOG_FILE, (event) => {
    if (event === "change") {
      processNewLines();
    }
  });
});

// Keep process alive
process.stdin.resume();
