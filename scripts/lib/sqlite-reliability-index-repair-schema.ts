import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { INDEX_REPAIR_SCHEMA_SQL } from "./sqlite-reliability-contract.js";
import { readSqliteSchemaCatalog } from "./sqlite-schema-catalog.mts";

function buildIndexRepairSchemaCatalog() {
  // Synthetic benchmark DDL is outside the generated runtime schema inventory.
  const database = openNodeSqliteDatabase(":memory:");
  try {
    database.exec(INDEX_REPAIR_SCHEMA_SQL);
    return readSqliteSchemaCatalog(database);
  } finally {
    database.close();
  }
}

export const INDEX_REPAIR_SCHEMA_CATALOG = buildIndexRepairSchemaCatalog();
