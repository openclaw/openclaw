import { execFileSync, spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { closeCodexAppServerTransport } from "./transport.js";

const [marker, exitAt] = process.argv.slice(2);
const nativeSource =
  'process.stdout.write(JSON.stringify({ native: process.pid }) + "\\n"); setInterval(() => {}, 1000)';
const launcher = spawn(
  process.execPath,
  [
    "-e",
    `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(nativeSource)}, process.argv[1]], { stdio: "inherit" });
child.on("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(code));`,
    marker!,
  ],
  { detached: true, stdio: ["pipe", "pipe", "pipe"] },
);
launcher.stderr.pipe(process.stderr);
process.send?.({ root: launcher.pid });
createInterface({ input: launcher.stdout }).once("line", (line) => {
  // SAFETY: the launcher's native child writes exactly this JSON line first.
  const { native } = JSON.parse(line) as { native: number };
  process.send?.({ root: launcher.pid, native });
  process.once("message", () => {
    const kill = process.kill.bind(process);
    // Exit immediately after a real containment signal, without changing its result.
    process.kill = (pid, signal) => {
      const sent = kill(pid, signal);
      if (
        (exitAt === "root-stopped" && pid === launcher.pid && signal === "SIGSTOP") ||
        (exitAt === "native-killed" && pid === native && signal === "SIGKILL")
      ) {
        // Pipe writes are asynchronous on macOS; process.exit would drop this proof.
        writeSync(
          1,
          execFileSync("ps", ["-o", "pid=,ppid=,stat=", "-p", String(launcher.pid)], {
            encoding: "utf8",
          }),
        );
        process.exit(0);
      }
      return sent;
    };
    closeCodexAppServerTransport(launcher);
  });
});
