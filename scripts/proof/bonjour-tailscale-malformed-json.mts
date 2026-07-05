// Real behavior proof: malformed `tailscale status --json` does not crash
// wide-area gateway discovery.

import {
  discoverGatewayBeacons,
  type GatewayBonjourBeacon,
} from "../../src/infra/bonjour-discovery.js";
import type { runCommandWithTimeout } from "../../src/process/exec.js";

const WIDE_AREA_DOMAIN = "openclaw.internal.";

const run = async (argv: string[]) => {
  const cmd = argv[0];
  if (cmd === "dns-sd" && argv[1] === "-B") {
    return { stdout: "", stderr: "", code: 0, signal: null, killed: false };
  }
  if (cmd === "tailscale" && argv[1] === "status" && argv[2] === "--json") {
    return { stdout: "not valid json {", stderr: "", code: 0, signal: null, killed: false };
  }
  throw new Error(`unexpected argv: ${argv.join(" ")}`);
};

console.log("=== Proof: bonjour-discovery malformed tailscale status JSON ===\n");
console.log("Discovering gateways with tailscale returning invalid JSON...\n");

const beacons: GatewayBonjourBeacon[] = await discoverGatewayBeacons({
  platform: "darwin",
  timeoutMs: 1200,
  domains: [WIDE_AREA_DOMAIN],
  wideAreaDomain: WIDE_AREA_DOMAIN,
  run: run as unknown as typeof runCommandWithTimeout,
});

console.log(`Discovered beacons: ${JSON.stringify(beacons)}`);

if (beacons.length === 0) {
  console.log("\nPASS: malformed tailscale JSON is tolerated and discovery returns empty list.");
} else {
  console.log("\nFAIL: expected empty beacon list.");
  process.exitCode = 1;
}
