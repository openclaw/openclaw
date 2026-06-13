#!/usr/bin/env node
/**
 * Live proof for #42798. Run: node --import tsx scripts/repro/tailscale-status-json-retry-live-proof.mjs
 */
import assert from "node:assert/strict";

const { getTailnetHostname } = await import("../../src/infra/tailscale.ts");

let statusCalls = 0;
const exec = async (_command, args) => {
  if (args[0] !== "status" || args[1] !== "--json") {
    throw new Error(`unexpected command args: ${JSON.stringify(args)}`);
  }
  statusCalls += 1;
  if (statusCalls === 1) {
    throw new Error("Command failed: tailscale status --json");
  }
  return {
    stdout: JSON.stringify({
      Self: {
        DNSName: "proof-host.tailnet.ts.net.",
        TailscaleIPs: ["100.64.0.20"],
      },
    }),
  };
};

const host = await getTailnetHostname(exec, "tailscale");
assert.equal(host, "proof-host.tailnet.ts.net");
assert.equal(statusCalls, 2);

console.log("status calls:", statusCalls);
console.log("host:", host);
