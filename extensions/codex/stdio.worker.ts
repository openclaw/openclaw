import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parentPort } from "node:worker_threads";
import type { CodexStdioWorkerRequest } from "./src/app-server/stdio-worker.js";

const port = parentPort!;
let child: ChildProcessWithoutNullStreams | undefined;
const fail = (error: NodeJS.ErrnoException) => {
  port.postMessage({
    type: "error",
    error: { message: error.message, code: error.code, errno: error.errno, syscall: error.syscall },
  });
};
port.on("message", (message: CodexStdioWorkerRequest) => {
  if (message.type === "close") {
    port.close();
    return;
  }
  if (message.type === "kill") {
    child?.kill(message.signal);
    return;
  }
  try {
    // uv_spawn can block on its exec-status pipe. Only this thread waits for exec.
    child = spawn(message.command, message.args, { ...message.options, stdio: "pipe" });
    child.on("error", fail);
    child.once("spawn", () => port.postMessage({ type: "spawn", pid: child!.pid }));
    child.once("exit", (code, signal) => port.postMessage({ type: "exit", code, signal }));
    child.once("close", () => {
      // Worker stdin releases its port reference on end, not destroy. The native
      // consumer is gone; finish this reader even if the caller left input open.
      process.stdin.unpipe(child!.stdin);
      process.stdin.push(null);
      process.stdin.resume();
      port.close();
    });
    child.stdin.on("error", fail);
    process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    port.close();
  }
});
port.postMessage({ type: "ready" });
