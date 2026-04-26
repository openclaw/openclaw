#!/usr/bin/env node
/**
 * Agent 42 — Subscription Manager
 *
 * PERMISSION GATE: Any action that creates, changes, or cancels a subscription
 * requires explicit approval from Jared / the acting user before execution.
 * Read-only commands (list, validate) do NOT require permission.
 */
import fs from "node:fs";
import { requestPermission } from "./agent42-permission-gate.mjs";

const file = new URL("../agent42-subscriptions.json", import.meta.url);
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const cmd = process.argv[2] || "list";

if (cmd === "list") {
  console.log("Agent 42 Subscription Plans:");
  for (const plan of data.plans) {
    console.log(`  ${plan.id}: $${plan.priceUsdMonthly.toFixed(2)}/mo — ${plan.description}`);
  }
  if (data.ownerOverride?.enabled) {
    console.log(
      `  [owner] ${data.ownerOverride.identifier}: ` +
        `$${data.ownerOverride.priceUsdMonthly.toFixed(2)}/mo (${data.ownerOverride.reason})`,
    );
  }
} else if (cmd === "validate") {
  const invalid = data.plans.filter(
    (p) => !p.id || typeof p.priceUsdMonthly !== "number" || p.priceUsdMonthly < 0,
  );
  if (invalid.length) {
    console.error("Invalid plans detected:", JSON.stringify(invalid, null, 2));
    process.exit(1);
  }
  if (!data.ownerOverride?.enabled) {
    console.error("Owner override must be enabled.");
    process.exit(1);
  }
  if (data.ownerOverride.priceUsdMonthly !== 0) {
    console.error("Owner override price must be 0.");
    process.exit(1);
  }
  console.log("Subscription plans are valid. Owner free top-tier: confirmed.");
} else if (cmd === "activate") {
  // GATED — requires explicit permission
  const planId = process.argv[3];
  const userId = process.argv[4] || "unknown-user";
  if (!planId) {
    console.error("Usage: activate <planId> <userId>");
    process.exit(1);
  }
  const plan = data.plans.find((p) => p.id === planId);
  if (!plan) {
    console.error(`Unknown plan: ${planId}`);
    process.exit(1);
  }
  const isOwner =
    data.ownerOverride?.enabled && userId === data.ownerOverride.identifier;
  const price = isOwner ? data.ownerOverride.priceUsdMonthly : plan.priceUsdMonthly;

  const approved = await requestPermission({
    actor: "agent42",
    action: `Activate subscription: ${plan.name} for ${userId}`,
    detail: `Plan: ${plan.id} | Monthly charge: $${price.toFixed(2)} | Payout: ${data.payout.destination}`,
  });

  if (!approved) {
    process.exit(0);
  }
  console.log(`Subscription activated: ${plan.id} for ${userId} at $${price.toFixed(2)}/mo`);
  console.log("(Wire payment processor integration here to execute the actual charge.)");
} else if (cmd === "cancel") {
  // GATED — requires explicit permission
  const userId = process.argv[3] || "unknown-user";
  const approved = await requestPermission({
    actor: "agent42",
    action: `Cancel subscription for ${userId}`,
    detail: "This will stop billing immediately. Cannot be undone without a new activation.",
  });
  if (!approved) {
    process.exit(0);
  }
  console.log(`Subscription cancelled for ${userId}.`);
  console.log("(Wire payment processor integration here to execute the actual cancellation.)");
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error("Commands: list | validate | activate <planId> <userId> | cancel <userId>");
  process.exit(1);
}
