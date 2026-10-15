import { Session } from "node:inspector/promises";
import { mock } from "node:test";
import { type MessagePort, workerData } from "node:worker_threads";

const { receipt } = workerData as { receipt: MessagePort };
mock.timers.enable({ apis: ["setTimeout"] });
const post = mock.method(Session.prototype, "post");
receipt.once("message", () => {
  // The parent observed task settlement; advance the worker's idle-GC timer without sleeping.
  mock.timers.tick(1500);
  const collections = post.mock.calls.filter((call) => {
    const method: string = call.arguments[0];
    return method === "HeapProfiler.collectGarbage";
  }).length;
  receipt.postMessage(collections, []);
});
await import("./code-mode-node.worker.js");
