// Synthetic Linux process tree: both descendants are spawned by nonleader threads.
const { spawn } = require("node:child_process");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

if (process.argv[2] === "leaf") {
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
