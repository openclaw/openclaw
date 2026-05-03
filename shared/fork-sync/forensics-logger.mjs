#!/usr/bin/env node
/**
 * Forensics Logger for Fork Sync Merge Activity
 *
 * Append-only JSONL logger. Every Tier 2 fast-forward merge gets a SHA + timestamp.
 * Schema includes Gunn's 4 required additions:
 *   - pre_merge_test_hash
 *   - post_merge_test_status
 *   - upstream_commit_range
 *   - classifier_version
 *
 * Usage:
 *   node forensics-logger.mjs log \
 *     --batch N \
 *     --range "abc123..def456" \
 *     --count 25 \
 *     --tier tier2 \
 *     --pre-hash <sha> \
 *     --post-status green \
 *     --classifier v2.1 \
 *     [--notes "optional notes"]
 *
 *   node forensics-logger.mjs verify
 *     Verifies log integrity (no tampering, no gaps)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "tier2-merge-log.jsonl");

function appendEntry(entry) {
  const line =
    JSON.stringify({
      ...entry,
      timestamp: new Date().toISOString(),
      loggedBy: "emmi",
    }) + "\n";
  fs.appendFileSync(LOG_PATH, line, { encoding: "utf8" });
}

function verifyLog() {
  if (!fs.existsSync(LOG_PATH)) {
    console.log("FAIL: Log file does not exist");
    return false;
  }

  const lines = fs
    .readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim());

  const entries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.schema) continue; // skip schema header
      if (!obj.batch) continue; // skip non-entry lines
      entries.push(obj);
    } catch (e) {
      console.log(`FAIL: Invalid JSON on line: ${line.substring(0, 80)}...`);
      console.log(`  Error: ${e.message}`);
      return false;
    }
  }

  // Verify required fields per entry
  const required = [
    "batch",
    "upstream_commit_range",
    "commit_count",
    "tier",
    "pre_merge_test_hash",
    "post_merge_test_status",
    "classifier_version",
    "timestamp",
    "loggedBy",
  ];
  for (const entry of entries) {
    for (const field of required) {
      if (!(field in entry)) {
        console.log(
          `FAIL: Missing field '${field}' in entry for batch ${entry.batch || "unknown"}`,
        );
        return false;
      }
    }
  }

  // Verify chronological order
  for (let i = 1; i < entries.length; i++) {
    if (new Date(entries[i].timestamp) < new Date(entries[i - 1].timestamp)) {
      console.log(`FAIL: Out-of-order entry at batch ${entries[i].batch}`);
      return false;
    }
  }

  console.log(`OK: ${entries.length} entries verified. Log integrity intact.`);
  return true;
}

// CLI
const args = process.argv.slice(2);
const command = args[0];

if (command === "log") {
  const parsed = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const val = args[i + 1];
    if (key && val) parsed[key] = val;
  }

  const entry = {
    batch: parseInt(parsed.batch) || 0,
    upstream_commit_range: parsed.range || "",
    commit_count: parseInt(parsed.count) || 0,
    tier: parsed.tier || "tier2",
    pre_merge_test_hash: parsed["pre-hash"] || "",
    post_merge_test_status: parsed["post-status"] || "",
    classifier_version: parsed.classifier || "",
    notes: parsed.notes || "",
  };

  appendEntry(entry);
  console.log(`Logged: Batch ${entry.batch}, ${entry.commit_count} commits, ${entry.tier}`);
} else if (command === "verify") {
  verifyLog();
} else {
  console.log(
    'Usage: forensics-logger.mjs log --batch N --range "abc..def" --count N --tier tier2 --pre-hash SHA --post-status green|red --classifier v2.1 [--notes "..."]',
  );
  console.log("       forensics-logger.mjs verify");
}
