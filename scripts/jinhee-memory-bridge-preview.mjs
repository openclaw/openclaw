#!/usr/bin/env node
/**
 * MEMORY-ROUNDTRIP-005 — Read-only preview of the Jinhee memory bridge output.
 *
 * Calls loadJinheeCanonicalMemoryBlock() and prints:
 *   1. The full memory block as injected into agent context
 *   2. Which of the 9 new canonical memory IDs (98–106) appear
 *   3. Which are missing and why
 *
 * DB write: NONE
 * MEMORY.md write: NONE
 * package.json edit: NONE
 */

import { access } from "node:fs/promises";

const DB_PATH = "/home/savit/ai/jinhee_data/jinhee.db";

// Minimal inline re-implementation of the bridge logic
// (same algorithm as jinhee-memory-bridge.ts, no import needed)

const LOW_TRUST_THRESHOLD = 1000;
const SENSITIVE_PATTERNS = [
  /\b(token|api_key|secret|password|refresh_token|authorization|bearer)\b/i,
];

function isSensitiveContent(content) {
  return SENSITIVE_PATTERNS.some((re) => re.test(content));
}

function truncateLine(line, maxChars) {
  if (line.length <= maxChars) return line;
  const truncated = line.slice(0, maxChars - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.7) {
    return truncated.slice(0, lastSpace) + "…";
  }
  return truncated + "…";
}

function sanitizeContent(raw, maxChars) {
  const cleaned = raw.trim().replace(/\r\n/g, "\n").replace(/\n+/g, " │ ");
  return truncateLine(cleaned, maxChars);
}

function formatBlock(rows, opts) {
  const maxRows = opts?.maxRows ?? 12;
  const maxCharsPerMemory = opts?.maxCharsPerMemory ?? 240;
  const maxTotalChars = opts?.maxTotalChars ?? 2400;

  if (!rows || rows.length === 0) return null;

  const lines = ["[JinheeOS Canonical Memory]"];
  let totalChars = lines[0].length;

  for (const row of rows) {
    if (row.truth_confidence >= LOW_TRUST_THRESHOLD) continue;
    if (isSensitiveContent(row.content)) continue;
    const raw = (row.content ?? "").trim();
    if (!raw || raw.length < 2) continue;
    if (raw.startsWith("{") && raw.endsWith("}")) continue;

    const sanitized = sanitizeContent(raw, maxCharsPerMemory);
    const bullet = `- ${sanitized}`;

    if (totalChars + bullet.length + 1 > maxTotalChars) break;

    lines.push(bullet);
    totalChars += bullet.length + 1;

    if (lines.length - 1 >= maxRows) break;
  }

  if (lines.length <= 1) return null;
  return lines.join("\n");
}

// Target IDs to verify
const TARGET_IDS = [98, 99, 100, 101, 102, 103, 104, 105, 106];

async function main() {
  console.log("=".repeat(72));
  console.log("MEMORY-ROUNDTRIP-005  —  Bridge Preview");
  console.log("=".repeat(72));

  // Check DB exists
  try {
    await access(DB_PATH);
  } catch {
    console.error("ERROR: DB not found at", DB_PATH);
    process.exit(1);
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(DB_PATH, { readWrite: false });
  db.exec("PRAGMA busy_timeout = 800");

  // --- 1. Load ALL rows ---
  const allRows = db
    .prepare(
      "SELECT id, content, truth_confidence, source_count, last_confirmed " +
        "FROM canonical_memories ORDER BY id DESC",
    )
    .all();

  console.log(`\n📊 Total canonical memories in DB: ${allRows.length}`);
  console.log(`   IDs: ${allRows.map((r) => r.id).join(", ")}`);

  // --- 2. Check target IDs specifically ---
  console.log(`\n🔍 Target ID check (IDs ${TARGET_IDS[0]}–${TARGET_IDS[TARGET_IDS.length - 1]}):`);
  let foundCount = 0;
  for (const id of TARGET_IDS) {
    const row = allRows.find((r) => r.id === id);
    if (row) {
      // Check if it would pass the filter
      const confidenceOk = row.truth_confidence < LOW_TRUST_THRESHOLD;
      const sensitive = isSensitiveContent(row.content);
      const empty = !(row.content ?? "").trim();
      const isJson = row.content.trim().startsWith("{") && row.content.trim().endsWith("}");

      const status = [];
      if (confidenceOk) status.push("✅ confidence");
      else status.push(`❌ confidence=${row.truth_confidence} >= ${LOW_TRUST_THRESHOLD}`);
      if (!sensitive) status.push("✅ clean");
      else status.push("❌ sensitive content");
      if (!empty) status.push("✅ non-empty");
      else status.push("❌ empty");
      if (!isJson) status.push("✅ plain text");
      else status.push("❌ JSON");

      const passed = confidenceOk && !sensitive && !empty && !isJson;
      console.log(
        `   ID ${id}: ${passed ? "✅ PASS" : "❌ BLOCKED"}  [${row.truth_confidence}/1000] ${status.join(", ")}`,
      );
      if (passed) foundCount++;
    } else {
      console.log(`   ID ${id}: ❌ NOT FOUND in DB`);
    }
  }

  // --- 3. What the bridge actually loads (12 newest that pass filter) ---
  console.log(
    `\n📋 Bridge query: SELECT id FROM canonical_memories ORDER BY id DESC LIMIT ${12 * 2}`,
  );
  console.log("   Raw query would return (top 24 IDs):");
  const queryPreview = db
    .prepare(
      "SELECT id, truth_confidence, substr(content,1,80) AS preview FROM canonical_memories ORDER BY id DESC LIMIT 24",
    )
    .all();
  for (const r of queryPreview) {
    const willPass = r.truth_confidence < LOW_TRUST_THRESHOLD;
    console.log(
      `   ${willPass ? "→" : " "} ID ${r.id} [${r.truth_confidence}] ${r.preview.substring(0, 50)}...`,
    );
  }

  // --- 4. Full formatted block after filter ---
  console.log("\n📄 Formatted memory block (as injected into agent context):");
  const formatted = formatBlock(allRows, {
    maxRows: 12,
    maxCharsPerMemory: 240,
    maxTotalChars: 2400,
  });
  if (formatted) {
    console.log(formatted);
    const lineCount = formatted.split("\n").length - 1; // minus header
    const totalChars = formatted.length;
    console.log(`\n   → ${lineCount} memories, ${totalChars} total chars (limit: 2400)`);
  } else {
    console.log("   (null — no memories passed filter)");
  }

  // --- 5. Summary ---
  console.log(`\n${"=".repeat(72)}`);
  console.log(`SUMMARY: ${foundCount}/9 target IDs would appear in memory block`);
  db.close();
}

main().catch((err) => {
  console.error("Preview failed:", err);
  process.exit(1);
});
