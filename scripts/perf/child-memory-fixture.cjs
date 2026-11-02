// Synthetic Linux process tree: both descendants are spawned by nonleader threads.
const { spawn } = require("node:child_process");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

if (isMainThread && process.argv[2] === "forest") {
  // Keep the same background processes across crossover arms. The container owns cleanup.
  const fs = require("node:fs");
  const roots = [];
  const cleanup = () => {
    for (const child of roots) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          throw error;
        }
      }
    }
    process.exit(process.exitCode ?? 0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  void (async () => {
    try {
      for (let index = 0; index < Number(process.argv[3]); index++) {
        const child = spawn(process.execPath, [__filename, process.argv[4]], {
          detached: true,
          stdio: ["pipe", "pipe", "inherit"],
        });
        roots.push(child);
        await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", () => reject(new Error("Fixture exited before readiness")));
          child.stdout.on("data", (chunk) => {
            if (chunk.toString().includes('"ready"')) {
              resolve();
            }
          });
        });
      }
      fs.writeFileSync(process.argv[5], JSON.stringify(roots.map((child) => child.pid)));
      console.log("FOREST_READY");
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
      cleanup();
    }
  })();
} else if (process.argv[2] === "leaf") {
  const retained = [Buffer.alloc(16 * 1024 ** 2, 1)];
  process.stdin.on("data", () => {
    process.stdout.write(`${JSON.stringify({ event: "burst", at: Date.now() })}\n`);
    retained.push(Buffer.alloc(768 * 1024 ** 2, 1));
  });
  process.stdout.write(`${JSON.stringify({ event: "leaf", pid: process.pid })}\n`);
  setInterval(() => void retained.length, 60_000);
} else if (!isMainThread) {
  const child = spawn(process.execPath, [__filename, "leaf"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdout.on("data", (chunk) => parentPort.postMessage(chunk.toString(), []));
  parentPort.on("message", () => child.stdin.write("burst\n"));
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  const count = Number(process.argv[2] ?? 2);
  let ready = 0;
  const workers = Array.from({ length: count }, () => new Worker(__filename, { execArgv: [] }));
  for (const worker of workers) {
    worker.on("error", (error) => {
      console.error(error);
      process.exit(1);
    });
    worker.on("exit", () => process.exit(1));
    worker.on("message", (message) => {
      if (message.includes('"leaf"')) {
        if (++ready === count) {
          process.stdout.write(
            `${JSON.stringify({ event: "ready", pid: process.pid, workers: count })}\n`,
          );
        }
      } else {
        process.stdout.write(message);
      }
    });
  }
  process.stdin.on("data", () => workers[0].postMessage("burst", []));
}
