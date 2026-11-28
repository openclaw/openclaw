import { appendFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

// Admission happens before the Gateway can create descendants. Worker isolates
// inherit this preload but must not move their containing process again.
if (isMainThread && process.ppid === Number(process.env.OPENCLAW_BENCH_PARENT_PID)) {
  writeFileSync(`${process.env.OPENCLAW_BENCH_CGROUP}/cgroup.procs`, String(process.pid));
  const record = (data) =>
    appendFileSync(
      process.env.OPENCLAW_BENCH_WORKERS,
      `${JSON.stringify({ atNs: String(process.hrtime.bigint()), epochMs: performance.timeOrigin + performance.now(), pid: process.pid, ...data })}\n`,
    );
  record({ event: "runtime", execPath: process.execPath, versions: process.versions });
  process.once("exit", (code) => record({ event: "runtime-exit", code }));
  process.on("worker", (worker) => {
    const threadId = worker.threadId;
    record({ event: "worker-created", threadId });
    worker.once("online", () => record({ event: "worker-online", threadId }));
    worker.once("exit", (code) => record({ event: "worker-exit", threadId, code }));
  });
}
