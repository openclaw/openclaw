import type { WorkerConfig } from "./config.js";
import type { ModelCache } from "./model-loader.js";
import { UnsupportedInputError } from "./models/types.js";
import { OnnxWorkerError, type WorkerReply, type WorkerRequest } from "./protocol.js";

let config: WorkerConfig;
let cache: ModelCache | undefined;
let stopping = false;
let finalExitCode = 0;
let activeTask: Promise<void> | undefined;

function stop(code: number): void {
  if (code !== 0) {
    finalExitCode = code;
  }
  if (stopping) {
    return;
  }
  stopping = true;
  process.off("message", onMessage);
  // Native inference is synchronous inside its async API. Let admitted work
  // settle before releasing its sessions; the parent owns forced cancellation.
  void Promise.resolve(activeTask)
    .catch(() => undefined)
    .then(() => cache?.close())
    .catch(() => {
      finalExitCode = 1;
    })
    .finally(() => {
      if (process.connected && typeof process.disconnect === "function") {
        process.disconnect();
      }
      process.exitCode = finalExitCode;
    });
}

function send(reply: WorkerReply): void {
  if (stopping) {
    return;
  }
  if (!process.connected || !process.send) {
    stop(1);
    return;
  }
  process.send(reply, (error) => {
    if (error) {
      stop(1);
    }
  });
}

function onMessage(request: WorkerRequest): void {
  if (stopping) {
    return;
  }
  if (request.kind === "init") {
    // The private parent sends initialization before operations on the same FIFO IPC channel.
    config = request.config;
    return;
  }
  activeTask = handle(request);
  void activeTask
    .catch(() => stop(1))
    .finally(() => {
      activeTask = undefined;
    });
}
process.on("disconnect", () => stop(0));
process.on("message", onMessage);

async function handle(request: Exclude<WorkerRequest, { kind: "init" }>): Promise<void> {
  try {
    if (!cache) {
      let implementation;
      try {
        implementation = await import("./model-loader.js");
      } catch {
        throw new OnnxWorkerError("dependency-unavailable");
      }
      cache = new implementation.ModelCache(config);
    }
    if (request.kind === "warm") {
      for (const model of request.models) {
        if (stopping) {
          return;
        }
        await cache.get(model);
      }
      send({ kind: "warmed" });
    } else {
      const model = await cache.get(request.model);
      const results = [];
      for (const input of request.inputs) {
        if (stopping) {
          return;
        }
        results.push(await model.classify(input));
      }
      send({ kind: "results", results });
    }
  } catch (error) {
    send({
      kind: "error",
      code:
        error instanceof UnsupportedInputError
          ? "unsupported-input"
          : error instanceof OnnxWorkerError
            ? error.code
            : "runtime",
    });
  }
}
