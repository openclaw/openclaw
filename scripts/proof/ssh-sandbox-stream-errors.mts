// Real behavior proof: runSshSandboxCommand handles stdout/stderr stream errors without crashing.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

// Patch spawn so the ssh child is a real process whose stdout and stderr emit
// errors after runSshSandboxCommand attaches listeners.
childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const cmd = args[0] ?? "";
  if (cmd === "ssh" || cmd.endsWith("/ssh")) {
    const child = originalSpawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
    setTimeout(() => {
      child.stdout?.emit("error", new Error("ssh stdout read failed"));
    }, 100);
    return child;
  }
  return originalSpawn.apply(childProcess, args);
};

const { runSshSandboxCommand } = await import(path.join(repoRoot, "src/agents/sandbox/ssh.js"));

function fakeSession() {
  return {
    command: "ssh",
    configPath: "/tmp/ssh-config",
    host: "remote-host",
  };
}

console.log("=== Proof: ssh sandbox stream error catch ===\n");

try {
  await runSshSandboxCommand({
    session: fakeSession() as never,
    remoteCommand: "echo hi",
    allowFailure: false,
  });
  console.log("FAIL: runSshSandboxCommand resolved unexpectedly.");
  process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ssh stdout read failed")) {
    console.log("PASS: runSshSandboxCommand rejected with the stream error instead of crashing.");
  } else {
    console.error("FAIL: unexpected rejection:", error);
    process.exitCode = 1;
  }
}
