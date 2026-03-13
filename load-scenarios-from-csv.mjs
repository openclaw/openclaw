// Script to load scenarios from MASTER_INTENT_MAP_1000_UNITS.csv and print as JS array

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parse as csvParse } from "csv-parse/sync";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const csvPath = path.resolve(__dirname, "../asktenant_openclaw/MASTER_INTENT_MAP_1000_UNITS.csv");
const csv = fs.readFileSync(csvPath, "utf8");
const records = csvParse(csv, { columns: true });

const scenarios = records.map((row, i) => ({
  "Scenario ID": row.intent_id ? `SCN-${String(i + 1).padStart(3, "0")}` : "",
  Channel: "SMS",
  "From (Phone)": `305-555-${6000 + i}`,
  Unit: `${101 + i}`,
  Message: row.question,
  "Expected Data (Field)": row.category,
  expected: "", // Placeholder, as CSV does not have expected answer
  Notes: row.intent_slug,
  meta: { persona: row.persona, intent_id: row.intent_id, category: row.category },
}));

console.log(JSON.stringify(scenarios, null, 2));
