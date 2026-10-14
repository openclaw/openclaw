import { Session } from "node:inspector/promises";
import { mock } from "node:test";
import { type MessagePort, workerData } from "node:worker_threads";

const { receipt } = workerData as { receipt: MessagePort };
mock.timers.enable({ apis: ["setTimeout"] });
let collections = 0;
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the inspector session receiver.
const post = Session.prototype.post;
Object.defineProperty(Session.prototype, "post", {
  value(this: Session, method: string, ...params: unknown[]) {
    if (method === "HeapProfiler.collectGarbage") {
      collections++;
    }
    return Reflect.apply(post, this, [method, ...params]);
  },
});
receipt.once("message", () => {
  // The parent observed task settlement; advance the worker's idle-GC timer without sleeping.
  mock.timers.tick(1500);
  receipt.postMessage(collections, []);
});
await import("./code-mode-node.worker.js");
