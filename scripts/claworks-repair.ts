#!/usr/bin/env node
/**
 * Repair ~/.claworks/claworks.json — unified with @claworks/runtime product-config-repair.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repairClaworksJsonConfig, defaultClaworksStateDir } from "@claworks/runtime";

const stateDir = defaultClaworksStateDir();
const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim() || join(stateDir, "claworks.json");

if (!existsSync(configPath)) {
  console.error(`No config at ${configPath} — run: pnpm claworks:init`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
const repair = repairClaworksJsonConfig(config, { stateDir, seedRobotMd: true });

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

console.log(`Repaired: ${configPath}`);
for (const line of repair.actions) {
  console.log(`  • ${line}`);
}
for (const warn of repair.warnings) {
  console.warn(`  ⚠ ${warn}`);
}

console.log("");
console.log("Restart gateway: pnpm claworks:start");
console.log("Vector KB: CLAWORKS_VECTOR_KB=1 pnpm claworks:repair");
console.log(
  "Personal work (self-hosted Qwen): cp contrib/examples/claworks-personal.env.example ~/.claworks/personal.env && pnpm claworks:repair:personal",
);
console.log("PostgreSQL: CLAWORKS_DATABASE_URL=postgresql://... pnpm claworks:migrate");
console.log('Verify: curl -H "Authorization: Bearer <api_key>" http://127.0.0.1:18800/v1/health');
