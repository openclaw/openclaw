import { spawn } from "node:child_process";

const outputLimit = 64 * 1024;

// A release launcher may respawn: own the entire detached process group, not just Node.
export function startNodeFixture(args, env) {
  let tail = Buffer.alloc(0);
  let spawnError;
  const child = spawn(process.execPath, args, {
    env,
    cwd: env.HOME,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      tail =
        chunk.length >= outputLimit
          ? Buffer.from(chunk.subarray(-outputLimit))
          : Buffer.concat([tail.subarray(-(outputLimit - chunk.length)), chunk]);
    });
  }
  const signalGroup = (signal) => {
    if (!child.pid) {
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  };
  let stopping;
  return {
    child,
    done,
    output: () => tail.toString("utf8"),
    error: () => spawnError,
    stop(initialSignal = "SIGTERM") {
      stopping ??= (async () => {
        signalGroup(initialSignal);
        if (initialSignal !== "SIGKILL") {
          let timer;
          try {
            await Promise.race([
              done,
              new Promise((resolve) => {
                timer = setTimeout(resolve, 2000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          // The parent can exit before its children. Always reap the remaining group.
          signalGroup("SIGKILL");
        }
        return await done;
      })();
      return stopping;
    },
  };
}
