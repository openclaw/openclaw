import { isMainThread, Worker } from "node:worker_threads";

// The benchmark retains numeric task facts only; native cloning still owns each payload.
if (isMainThread && process.send) {
  const dispatches = [];
  const countReads = process.env.OPENCLAW_USAGE_BENCH_COUNT_READS === "1";
  // Install before application imports so even a worker's first task is observed.
  // oxlint-disable-next-line typescript/unbound-method -- Every call below restores the sending Worker as its receiver.
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...args) {
    const task = typeof message?.taskId === "number" ? message.input : undefined;
    const input = task?.kind === undefined ? task : task.input;
    if (countReads && task?.kind === "usage-cost") {
      const operation = task.operation;
      const families = operation?.families;
      dispatches.push({
        kind: "usage-cost:" + operation?.kind,
        rows:
          families?.length ?? operation?.sessions?.length ?? operation?.sessionFiles?.length ?? 0,
        instances: families?.reduce((sum, items) => sum + items.length, 0),
        contextRows: 0,
        packedBytes: 0,
      });
    }
    if (Array.isArray(input?.rows) && (Array.isArray(input.packed) || task.kind === "cohorts")) {
      const packedBytes =
        input.packed?.reduce(
          (sum, { batch }) => sum + batch.values.byteLength + batch.offsets.byteLength,
          0,
        ) ?? 0;
      let contextRows = 0;
      for (const row of input.rows) {
        if (row?.hasContextWeight === true) {
          contextRows++;
        }
      }
      dispatches.push({
        kind: typeof task.kind === "string" ? task.kind : "report",
        rows: input.rows.length,
        contextRows,
        packedBytes,
      });
    }
    return postMessage.call(this, message, ...args);
  };
  process.on("message", (message) => {
    if (message?.channel === "usage-volume-fixture" && message.action === "snapshot") {
      process.send({ channel: "usage-volume-fixture", action: "snapshot", dispatches });
    }
  });
}
