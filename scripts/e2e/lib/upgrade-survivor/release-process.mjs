import { execFileSync, spawn } from "node:child_process";

const outputLimit = 64 * 1024;

export function killFixtureProcessGroup(pid, signal = "SIGKILL") {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

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
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const done = new Promise((resolve) => {
    // A detached child can keep these pipes open after the launcher itself exits.
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
  let stopping;
  return {
    child,
    exited,
    done,
    output: () => tail.toString("utf8"),
    error: () => spawnError,
    stop(initialSignal = "SIGTERM", graceMs = 2000) {
      stopping ??= (async () => {
        const childGroups = new Set();
        let inspectionError;
        if (child.pid && child.exitCode === null && child.signalCode === null && !spawnError) {
          try {
            // Snapshot before signaling: detached children are reparented when the resident exits.
            const listing = execFileSync("ps", ["-axo", "ppid=,pgid="], {
              encoding: "utf8",
              timeout: 2000,
            });
            for (const line of listing.trim().split("\n")) {
              const [parentPid, group] = line.trim().split(/\s+/).map(Number);
              if (parentPid === child.pid && group > 0 && group !== child.pid) {
                childGroups.add(group);
              }
            }
          } catch (error) {
            inspectionError = error;
          }
        }
        killFixtureProcessGroup(child.pid, initialSignal);
        let hardShutdown = initialSignal === "SIGKILL";
        if (!hardShutdown) {
          let timer;
          try {
            hardShutdown = !(await Promise.race([
              done.then(() => true),
              new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), graceMs);
              }),
            ]));
          } finally {
            clearTimeout(timer);
          }
        }
        // Reap the owned group, but leave detached children alone after a graceful close.
        killFixtureProcessGroup(child.pid);
        if (hardShutdown) {
          for (const group of childGroups) {
            killFixtureProcessGroup(group);
          }
          let timer;
          try {
            await Promise.race([
              done,
              new Promise((resolve, reject) => {
                timer = setTimeout(() => {
                  child.stdout.destroy();
                  child.stderr.destroy();
                  if (child.exitCode === null && child.signalCode === null && !spawnError) {
                    reject(new Error("Fixture did not exit within 2 seconds of SIGKILL"));
                  } else {
                    resolve();
                  }
                }, 2000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        const exit = await done;
        if (inspectionError) {
          throw new Error("Could not inspect fixture child process groups", {
            cause: inspectionError,
          });
        }
        return exit;
      })();
      return stopping;
    },
  };
}
