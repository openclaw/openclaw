// Real behavior proof: `runSshSandboxCommand` handles stdout/stderr/stdin
// stream errors without crashing and terminates the SSH child.
//
// The proof creates a temporary SSH sandbox session, then patches
// `child_process.spawn` so the `ssh` child is replaced by a long-lived Node
// process whose stdout/stderr/stdin streams emit `error` events after the
// listeners are attached. With the fix each stream error rejects the command
// and kills the child; without the stream error listeners the unhandled
// errors would terminate the process. The same fix also moves the `fail`
// helper in `uploadDirectoryToSshTarget` before its first use, clearing a
// temporal dead zone that prevented the upload pipeline from registering
// stream error listeners.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

let killed = false;
let streamToFail: "stdout" | "stderr" | "stdin" = "stdout";

childProcess.spawn = (...args: Parameters<typeof originalSpawn>) => {
  const cmd = path.basename(args[0] ?? "");
  if (cmd !== "ssh") {
    return originalSpawn.apply(childProcess, args);
  }

  const child = originalSpawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
  const originalKill = child.kill.bind(child);
  child.kill = (signal?: string) => {
    killed = true;
    return originalKill(signal);
  };

  setTimeout(() => {
    if (streamToFail === "stdout") {
      child.stdout?.emit("error", new Error("stdout read failed"));
    } else if (streamToFail === "stderr") {
      child.stderr?.emit("error", new Error("stderr read failed"));
    } else {
      child.stdin?.emit("error", new Error("stdin write failed"));
    }
  }, 50);

  return child;
};

const {
  createSshSandboxSessionFromConfigText,
  runSshSandboxCommand,
  disposeSshSandboxSession,
} = await import(path.join(repoRoot, "src/agents/sandbox/ssh.js"));

const session = await createSshSandboxSessionFromConfigText({
  configText: `Host testhost
  HostName 127.0.0.1
  User testuser
`,
  host: "testhost",
  command: "ssh",
});

console.log("=== Proof: ssh sandbox stream error catch ===\n");

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);

async function runCase(name: "stdout" | "stderr" | "stdin", expected: string): Promise<boolean> {
  streamToFail = name;
  killed = false;
  try {
    await runSshSandboxCommand({
      session,
      remoteCommand: "echo hi",
      allowFailure: false,
    });
    console.log(`FAIL [${name}]: command resolved unexpectedly`);
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes(expected) && killed && unhandled.length === 0) {
      console.log(`PASS [${name}]: rejected with "${expected}" and killed the child.`);
      return true;
    }
    console.log(`FAIL [${name}]: message=${message} killed=${String(killed)} unhandled=${String(unhandled.length)}`);
    return false;
  }
}

try {
  const results = [
    await runCase("stdout", "stdout read failed"),
    await runCase("stderr", "stderr read failed"),
    await runCase("stdin", "stdin write failed"),
  ];
  if (!results.every(Boolean)) {
    process.exitCode = 1;
  }
} finally {
  process.off("unhandledRejection", onUnhandled);
  await disposeSshSandboxSession(session);
}
