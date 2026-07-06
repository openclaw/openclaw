// Real behavior proof: execDockerRaw handles stdin stream errors without crashing.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

// Patch spawn so the docker child is a real process whose stdin emits an error
// after execDockerRaw attaches listeners.
childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const cmd = args[0] ?? "";
  if (cmd !== "docker" && !cmd.endsWith("/docker")) {
    return originalSpawn.apply(childProcess, args);
  }
  const child = originalSpawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  setTimeout(() => {
    child.stdin?.emit("error", new Error("docker stdin write failed"));
  }, 100);
  return child;
};

const { execDockerRaw } = await import(path.join(repoRoot, "src/agents/sandbox/docker.js"));

console.log("=== Proof: docker sandbox stdin stream error catch ===\n");

try {
  await execDockerRaw(["version"], { input: "test" });
  console.log("FAIL: execDockerRaw resolved unexpectedly.");
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("docker stdin write failed")) {
    console.log("PASS: execDockerRaw rejected with the stdin error instead of crashing.");
  } else {
    console.error("FAIL: unexpected rejection:", error);
    process.exitCode = 1;
  }
}
