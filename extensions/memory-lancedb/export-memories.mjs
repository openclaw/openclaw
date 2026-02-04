#!/usr/bin/env node
/**
 * Export memories from LanceDB for migration to memory-neo4j
 *
 * Usage:
 *   pnpm exec node export-memories.mjs [output-file.json]
 *
 * Default output: memories-export.json
 */

import * as lancedb from "@lancedb/lancedb";
import { writeFileSync } from "fs";

const LANCEDB_PATH = process.env.LANCEDB_PATH || "/home/tsukhani/.openclaw/memory/lancedb";
const AGENT_ID = process.env.AGENT_ID || "main";
const outputFile = process.argv[2] || "memories-export.json";

console.log("📦 Memory Export Tool (LanceDB)");
console.log(`   LanceDB path: ${LANCEDB_PATH}`);
console.log(`   Output: ${outputFile}`);
console.log("");

// Transform for neo4j format
function transformMemory(lanceEntry) {
  const createdAtISO = new Date(lanceEntry.createdAt).toISOString();

  return {
    id: lanceEntry.id,
    text: lanceEntry.text,
    embedding: lanceEntry.vector,
    importance: lanceEntry.importance,
    category: lanceEntry.category,
    createdAt: createdAtISO,
    updatedAt: createdAtISO,
    source: "import",
    extractionStatus: "skipped",
    agentId: AGENT_ID,
  };
}

async function main() {
  // Load from LanceDB
  console.log("📥 Loading from LanceDB...");
  const db = await lancedb.connect(LANCEDB_PATH);
  const table = await db.openTable("memories");
  const count = await table.countRows();
  console.log(`   Found ${count} memories`);

  const memories = await table
    .query()
    .limit(count + 100)
    .toArray();
  console.log(`   Loaded ${memories.length} memories`);

  // Transform
  console.log("🔄 Transforming...");
  const transformed = memories.map(transformMemory);

  // Stats
  const stats = {};
  transformed.forEach((m) => {
    stats[m.category] = (stats[m.category] || 0) + 1;
  });
  console.log("   Categories:", stats);

  // Export
  console.log(`📤 Exporting to ${outputFile}...`);
  const exportData = {
    exportedAt: new Date().toISOString(),
    sourcePlugin: "memory-lancedb",
    targetPlugin: "memory-neo4j",
    agentId: AGENT_ID,
    vectorDim: transformed[0]?.embedding?.length || 1536,
    count: transformed.length,
    stats,
    memories: transformed,
  };

  writeFileSync(outputFile, JSON.stringify(exportData, null, 2));

  // Also write a preview without embeddings
  const previewFile = outputFile.replace(".json", "-preview.json");
  const preview = {
    ...exportData,
    memories: transformed.map((m) => ({
      ...m,
      embedding: `[${m.embedding?.length} dims]`,
    })),
  };
  writeFileSync(previewFile, JSON.stringify(preview, null, 2));

  console.log(`✅ Exported ${transformed.length} memories`);
  console.log(
    `   Full export: ${outputFile} (${(JSON.stringify(exportData).length / 1024 / 1024).toFixed(2)} MB)`,
  );
  console.log(`   Preview: ${previewFile}`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
