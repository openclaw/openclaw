import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";

const PASS = "OK";
const FAIL = "FAIL";
let passed = 0,
  failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  " + PASS + " " + msg);
  } else {
    failed++;
    console.log("  " + FAIL + " " + msg);
  }
}

console.log("=== Real Behavior Proof: PR #95253 ===");
console.log("Host: " + hostname());
console.log("Node: " + process.version);
console.log("");

const tmp = mkdtempSync(join(tmpdir(), "proof-95253-"));
const stateDir = join(tmp, "state");
const homeDir = join(tmp, "home");
mkdirSync(join(stateDir, "service-env"), { recursive: true });
mkdirSync(join(homeDir, ".openclaw"), { recursive: true });

writeFileSync(
  join(homeDir, ".openclaw", "openclaw.json"),
  JSON.stringify({ gateway: { port: 18789 } }),
);
writeFileSync(join(stateDir, "openclaw.json"), JSON.stringify({ gateway: { port: 24680 } }));
writeFileSync(
  join(stateDir, "service-env", "openclaw-gateway.env"),
  "export OPENCLAW_GATEWAY_PORT='19003'\n",
);
writeFileSync(join(stateDir, "gateway.systemd.env"), "OPENCLAW_GATEWAY_PORT=13579\n");

const { resolveGatewayPort, warnIfGatewayNeedsRestart } =
  await import("./scripts/postinstall-bundled-plugins.mjs");

console.log("--- Port resolution ---");
const p1 = resolveGatewayPort({ env: { HOME: homeDir } });
assert(p1 === 18789, "default port (no sources): " + p1);

const p2 = resolveGatewayPort({ env: { HOME: homeDir, OPENCLAW_GATEWAY_PORT: "12345" } });
assert(p2 === 12345, "env var only: " + p2);

const p3 = resolveGatewayPort({ env: { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir } });
assert(p3 === 19003, "service-env via state dir: " + p3);

const p4 = resolveGatewayPort({
  env: { HOME: homeDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_PORT: "33333" },
});
assert(p4 === 33333, "precedence: env wins over all: " + p4);

console.log("\n--- Gateway restart warning with active listener ---");
const server = net.createServer((s) => s.end());
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
server.unref();

let warned = false;
await warnIfGatewayNeedsRestart({
  env: { HOME: homeDir, OPENCLAW_GATEWAY_PORT: String(port) },
  warn: (msg) => {
    warned = true;
    console.log("  " + msg);
  },
});
server.close();
assert(warned, "restart warning printed when gateway is listening on port " + port);

console.log("\n--- No warning when no gateway ---");
let silent = true;
await warnIfGatewayNeedsRestart({
  env: { HOME: homeDir, OPENCLAW_GATEWAY_PORT: "65535" },
  warn: (msg) => {
    silent = false;
  },
});
assert(silent, "no warning when port 65535 has no listener");

console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===");
