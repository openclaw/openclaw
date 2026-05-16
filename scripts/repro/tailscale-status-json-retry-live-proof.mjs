#!/usr/bin/env node
/**
 * Live repro helper for tailscale status --json retry (#42798).
 * Simulates the startup race: first status call fails, second succeeds.
 *
 * Run: pnpm exec tsx scripts/repro/tailscale-status-json-retry-live-proof.mjs
 */
import { getTailnetHostname } from "../../src/infra/tailscale.js";

let calls = 0;
const exec = async (bin, args) => {
  calls += 1;
  if (args[0] === "status" && args[1] === "--json" && calls === 1) {
    throw new Error("Command failed: tailscale status --json");
  }
  return {
    stdout: JSON.stringify({
      Self: { DNSName: "proof-host.tailnet.ts.net.", TailscaleIPs: ["100.64.0.1"] },
    }),
  };
};

const host = await getTailnetHostname(exec, "tailscale");
console.log("status calls:", calls);
console.log("host:", host);
