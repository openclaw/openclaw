import { resolveNodeCommandAllowlist } from "../src/gateway/node-command-policy.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";

const cfg = {} as OpenClawConfig;

// Simulate a macOS node that declares canvas commands (as the macOS node app does)
const macNode = {
  platform: "macOS 26.5.0",
  deviceFamily: "Mac",
  commands: [
    "camera.list",
    "canvas.a2ui.push", "canvas.a2ui.pushJSONL", "canvas.a2ui.reset",
    "canvas.eval", "canvas.hide", "canvas.navigate",
    "canvas.present", "canvas.snapshot",
    "location.get", "screen.snapshot",
    "system.notify", "system.run", "system.which"
  ],
};

const allowlist = resolveNodeCommandAllowlist(cfg, macNode);

console.log("=== macOS node canvas command allowlist check ===");
const canvasCommands = [
  "canvas.a2ui.push", "canvas.a2ui.pushJSONL", "canvas.a2ui.reset",
  "canvas.eval", "canvas.hide", "canvas.navigate",
  "canvas.present", "canvas.snapshot"
];

for (const cmd of canvasCommands) {
  console.log(`${cmd}: ${allowlist.has(cmd) ? "ALLOWED" : "BLOCKED"}`);
}

// Also check some commands that SHOULD work
console.log("\n=== Expected working commands ===");
console.log(`camera.list: ${allowlist.has("camera.list") ? "ALLOWED" : "BLOCKED"}`);
console.log(`screen.snapshot: ${allowlist.has("screen.snapshot") ? "ALLOWED" : "BLOCKED"}`);
console.log(`system.run: ${allowlist.has("system.run") ? "ALLOWED" : "BLOCKED"}`);

// Count blocked canvas commands
const blockedCount = canvasCommands.filter(cmd => !allowlist.has(cmd)).length;
console.log(`\nBlocked canvas commands: ${blockedCount} / ${canvasCommands.length}`);

if (blockedCount > 0) {
  console.log("\n❌ FAIL: Some canvas commands are still blocked");
  process.exit(1);
} else {
  console.log("\n✅ PASS: All declared canvas commands are allowed");
}
