// NODE_OPTIONS preload for the disposable bulk-unlink workload only.
import fs from "node:fs";
import path from "node:path";
import { getHeapStatistics } from "node:v8";

if (
  process.env.BULK_UNLINK_METRICS &&
  process.argv.some((arg) => /fs-safe-copy\.worker\.[jt]s$/.test(arg))
) {
  process.on("exit", () => {
    const cpu = process.cpuUsage();
    fs.appendFileSync(
      process.env.BULK_UNLINK_METRICS,
      JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        cpuMs: (cpu.user + cpu.system) / 1000,
        allocatedBytes: getHeapStatistics().total_allocated_bytes,
        entry: path.basename(process.argv[1]),
      }) + "\n",
    );
  });
}
