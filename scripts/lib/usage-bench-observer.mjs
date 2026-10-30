import { isMainThread, Worker } from "node:worker_threads";

// The benchmark retains numeric task facts only; native cloning still owns each payload.
if (isMainThread && process.send) {
  const dispatches = [];
  // Node emits process's worker event on nextTick, after a pool can send its first task.
  const postMessage = Worker.prototype.postMessage.call.bind(Worker.prototype.postMessage);
  Worker.prototype.postMessage = function (message, ...args) {
    const task = typeof message?.taskId === "number" ? message.input : undefined;
    const input = task?.kind === undefined ? task : task.input;
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
    return postMessage(this, message, ...args);
  };
  process.on("message", (message) => {
    if (message?.channel === "usage-volume-fixture" && message.action === "snapshot") {
      process.send({ channel: "usage-volume-fixture", action: "snapshot", dispatches });
    }
  });
}
