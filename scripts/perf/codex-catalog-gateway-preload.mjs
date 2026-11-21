// Isolated proof only: hold the real native Codex spawn at its synchronous boundary.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread, threadId } from "node:worker_threads";

const target = process.env.OPENCLAW_CODEX_GATEWAY_PROOF_COMMAND;
const evidence = process.env.OPENCLAW_CODEX_GATEWAY_PROOF_EVENTS;
if (target && evidence) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    if (args[0] !== target || !Array.isArray(args[1]) || !args[1].includes("app-server")) {
      return Reflect.apply(spawn, childProcess, args);
    }
    const record = (event, childPid) =>
      appendFileSync(
        evidence,
        JSON.stringify({
          event,
          at: Date.now(),
          gatewayPid: process.pid,
          threadId,
          isMainThread,
          childPid,
        }) + "\n",
      );
    record("begin");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    const child = Reflect.apply(spawn, childProcess, args);
    record("returned", child.pid);
    child.once("exit", (code, signal) =>
      appendFileSync(
        evidence,
        JSON.stringify({ event: "exit", at: Date.now(), childPid: child.pid, code, signal }) + "\n",
      ),
    );
    return child;
  };
  syncBuiltinESMExports();
}
