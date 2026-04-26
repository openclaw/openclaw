#!/usr/bin/env node
import fs from "node:fs";

const file = new URL("../agent42-subscriptions.json", import.meta.url);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const cmd = process.argv[2] || "list";

if (cmd === "list") {
  for (const plan of data.plans) {
    console.log(`${plan.id}: $${plan.priceUsdMonthly}/mo (${plan.seats} seats)`);
  }
} else if (cmd === "validate") {
  const invalid = data.plans.filter(p => !p.id || p.priceUsdMonthly < 0 || p.seats < 1);
  if (invalid.length) {
    console.error("Invalid plans detected:", invalid);
    process.exit(1);
  }
  console.log("Subscription plans are valid.");
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
