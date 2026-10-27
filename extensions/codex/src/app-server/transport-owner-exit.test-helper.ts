import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { closeCodexAppServerTransportAndWait } from "./transport.js";

const [marker = "", exitAt] = process.argv.slice(2);
// Like the native Codex server, exit once the owner's stdin pipe closes.
const nativeSource =
  'process.stdout.write(JSON.stringify({ native: process.pid }) + "\\n"); process.stdin.on("end", () => process.exit(0)).resume()';
const launcherSource = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(nativeSource)}, process.argv[1]], { stdio: "inherit" });
child.on("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code));`;
const kill = process.kill.bind(process);
let current: { launcher: ChildProcess; native: number } | undefined;

function exitNow(target: { launcher: ChildProcess; native: number }): never {
  // process.exit can drop pending asynchronous pipe writes; keep this proof.
  writeSync(
    1,
    execFileSync(
      "ps",
      ["-o", "pid=,ppid=,stat=", "-p", `${target.launcher.pid},${target.native}`],
      {
        encoding: "utf8",
      },
    ),
  );
  process.exit(0);
}

// Exit at a real containment step without changing what containment did before it.
process.kill = (pid, signal) => {
  const target = current;
  if (target && pid === target.native && signal === "SIGKILL") {
    if (exitAt === "hosted-native-stopped") {
      exitNow(target);
    }
    const sent = kill(pid, signal);
    if (exitAt === "native-killed") {
      exitNow(target);
    }
    return sent;
  }
  return kill(pid, signal);
};

// Containment fails closed when process inspection fails, as it can on a loaded
// host. Only a run that reaches the exit step is evidence, so retry that case.
for (let attempt = 0; attempt < 3; attempt += 1) {
  const launcher = spawn(process.execPath, ["-e", launcherSource, marker], {
    // Hosted Gateways keep the launcher in their own process group.
    detached: exitAt !== "hosted-native-stopped",
    stdio: ["pipe", "pipe", "pipe"],
  });
  launcher.stderr.pipe(process.stderr);
  const [line] = await once(createInterface({ input: launcher.stdout }), "line");
  // SAFETY: the launcher's native child writes exactly this JSON line first.
  current = { launcher, native: (JSON.parse(line) as { native: number }).native };
  await closeCodexAppServerTransportAndWait(launcher);
}
process.stderr.write("containment never reached the exit step\n");
process.exit(3);
