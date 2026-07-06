// Real behavior proof: probeLocalCommand handles stdout/stderr stream errors without crashing.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

// Patch spawn so any local command probe becomes a real process whose stdout and
// stderr emit errors after probeLocalCommand attaches listeners.
childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const child = originalSpawn.apply(childProcess, args);
  setTimeout(() => {
    child.stdout?.emit("error", new Error("probe stdout read failed"));
    child.stderr?.emit("error", new Error("probe stderr read failed"));
  }, 100);
  return child;
};

const { probeLocalCommand } = await import(path.join(repoRoot, "src/crestodian/probes.js"));

console.log("=== Proof: crestodian probe stream error catch ===\n");

try {
  const result = await probeLocalCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeoutMs: 1_000,
  });
  if (result.error?.includes("probe stdout read failed") || result.error?.includes("probe stderr read failed")) {
    console.log("PASS: probeLocalCommand resolved with a stream error instead of crashing.");
  } else {
    console.log("FAIL: expected stream error in result:", result);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("FAIL: probeLocalCommand rejected with:");
  console.error(err);
  process.exitCode = 1;
}
