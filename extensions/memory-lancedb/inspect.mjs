import * as lancedb from "@lancedb/lancedb";

const db = await lancedb.connect("/home/tsukhani/.openclaw/memory/lancedb");
const tables = await db.tableNames();
console.log("Tables:", tables);

if (tables.includes("memories")) {
  const table = await db.openTable("memories");
  const count = await table.countRows();
  console.log("Memory count:", count);

  const all = await table.query().limit(200).toArray();

  const stats = { preference: 0, fact: 0, decision: 0, entity: 0, other: 0, core: 0 };

  all.forEach((e) => {
    stats[e.category] = (stats[e.category] || 0) + 1;
  });

  console.log("\nCategory breakdown:", stats);
  console.log("\nSample entries:");
  all.slice(0, 5).forEach((e, i) => {
    console.log(`${i + 1}. [${e.category}] ${(e.text || "").substring(0, 100)}...`);
    console.log(`   id: ${e.id}, importance: ${e.importance}, vectorDim: ${e.vector?.length}`);
  });
}
