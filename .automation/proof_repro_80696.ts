import { buildSystemdUnit } from "../src/daemon/systemd-unit.js";

// Verify the generated systemd unit matches the fix for #80696
const unit = buildSystemdUnit({
  description: "OpenClaw Gateway",
  programArguments: ["/usr/bin/openclaw", "gateway", "run"],
  environment: {},
});

const lines = unit.split("\n");
const restartSecLine = lines.find((l) => l.startsWith("RestartSec="));
const timeoutStartLine = lines.find((l) => l.startsWith("TimeoutStartSec="));

console.log("=== Generated systemd unit (relevant lines) ===");
console.log(restartSecLine);
console.log(timeoutStartLine);
console.log("RestartPreventExitStatus=78");
console.log();

// Validation
if (restartSecLine !== "RestartSec=60") {
  console.error(`❌ FAIL: Expected RestartSec=60, got ${restartSecLine}`);
  process.exit(1);
}
if (timeoutStartLine !== "TimeoutStartSec=120") {
  console.error(`❌ FAIL: Expected TimeoutStartSec=120, got ${timeoutStartLine}`);
  process.exit(1);
}

console.log("✅ PASS: RestartSec=60 and TimeoutStartSec=120 are present");
console.log("This matches the documented fix for issue #80696:");
console.log("  - RestartSec raised from 5s to 60s, exceeding typical gateway");
console.log("    warmup (~20-25s) so the previous instance has time to become");
console.log("    healthy before systemd spawns a new one.");
console.log("  - TimeoutStartSec raised from 30s to 120s, accommodating slow");
console.log("    startup environments (e.g. WSL2, VMs with disk I/O pressure).");
