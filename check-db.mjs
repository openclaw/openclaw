import * as lancedb from "@lancedb/lancedb";
import path from "node:path";

async function check() {
  const dbPath = "/home/vova/OpenPro/workspace/memory/lancedb";
  try {
    const db = await lancedb.connect(dbPath);
    const table = await db.openTable("memories");
    const sch = await table.schema();
    console.log("Schema:", JSON.stringify(sch, null, 2));
  } catch (err) {
    console.error("Error:", err);
  }
}
check();
