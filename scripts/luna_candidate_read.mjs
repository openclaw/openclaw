import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const argPath = process.argv[2] ?? process.env.CANDIDATES_JSON ?? "";
if (!argPath) {
  console.error("Candidates JSON path is required (arg or CANDIDATES_JSON).");
  process.exit(2);
}
if (!existsSync(argPath)) {
  console.error(`Candidates JSON not found: ${argPath}`);
  process.exit(2);
}

const data = JSON.parse(await readFile(argPath, "utf8"));
const light = data.light ?? "";
const fan = data.fan ?? "";
const outlet = data.outlet ?? "";
const vacuum = data.vacuum ?? "";
const climate = data.climate ?? "";
const lock = data.lock ?? "";

process.stdout.write([light, fan, outlet, vacuum, climate, lock].join(" "));
