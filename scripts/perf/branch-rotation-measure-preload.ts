import { channel } from "node:diagnostics_channel";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { getTrackedWorkerLifecycleSnapshot } from "../../src/infra/worker-cpu.ts";

const memoryPressure = channel("openclaw.memory.critical");

// The private benchmark IPC descriptor is the only control surface. Use the real
// pressure owner to retire idle readers; measured requests still use Gateway RPC.
if (isMainThread) {
  if (!process.send) {
    throw new Error("Branch rotation measurement requires the benchmark IPC channel");
  }
  process.on("message", (message: unknown) => {
    if (!isRecord(message) || message.channel !== "branch-rotation-measure") {
      return;
    }
    if (message.action === "retire-idle") {
      memoryPressure.publish({});
    } else if (message.action !== "sample") {
      return;
    }
    process.send?.({
      channel: "branch-rotation-measure",
      id: message.id,
      ...getTrackedWorkerLifecycleSnapshot(),
    });
  });
  process.channel?.unref();
}
