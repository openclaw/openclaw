import { createHook } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { mock } from "node:test";
import { GCProfiler, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { type MessagePort, workerData } from "node:worker_threads";

const { receipt } = workerData as { receipt: MessagePort };
mock.timers.enable({ apis: ["setTimeout"] });
const post = mock.method(Session.prototype, "post");
receipt.once("message", (request) => {
  if (request === "observe-idle") {
    mock.timers.reset();
    setFlagsFromString("--expose_gc");
    const collect: () => void = runInNewContext("gc");
    const profile = new GCProfiler();
    profile.start();
    let immediates = 0;
    const hook = createHook({
      init(_id, type) {
        if (type === "Immediate") {
          immediates++;
        }
      },
    }).enable();
    // Seed one real collection after cells finish. Instrumentation must not
    // schedule event-loop work in response and keep an idle isolate collecting.
    collect();
    setTimeout(() => {
      hook.disable();
      const majorCollections = profile
        .stop()
        .statistics.filter((entry) => entry.gcType === "MarkSweepCompact").length;
      receipt.postMessage({ majorCollections, immediates }, []);
    }, 60_000);
    return;
  }
  // The parent observed task settlement; advance the worker's idle-GC timer without sleeping.
  mock.timers.tick(1500);
  const collections = post.mock.calls.filter((call) => {
    const method: string = call.arguments[0];
    return method === "HeapProfiler.collectGarbage";
  }).length;
  receipt.postMessage(collections, []);
});
await import("./code-mode-node.worker.js");
