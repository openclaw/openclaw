import type { WorkerConfig } from "./config.js";
import type { ModelCache } from "./model-loader.js";
import { UnsupportedInputError } from "./models/types.js";
import { OnnxWorkerError, parseWorkerRequest, type WorkerReply } from "./protocol.js";

let config: WorkerConfig | undefined;
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

function onMessage(value: unknown): void {
  if (stopping) {
    return;
  }
  if (activeTask) {
    stop(1);
    return;
  }
  activeTask = handle(value);
  void activeTask
    .catch(() => stop(1))
    .finally(() => {
      activeTask = undefined;
    });
}
process.on("disconnect", () => stop(0));
process.on("message", onMessage);

async function handle(value: unknown): Promise<void> {
  const request = parseWorkerRequest(value);
  if (request.kind === "init") {
    if (config) {
      throw new Error("Already initialized");
    }
    config = request.config;
    send({ kind: "ready" });
    return;
  }
  if (!config) {
    throw new Error("Invalid worker admission");
  }
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
      send({ kind: "warmed", id: request.id });
    } else {
      const model = await cache.get(request.model);
      const results = [];
      for (const input of request.inputs) {
        if (stopping) {
          return;
        }
        results.push(await model.classify(input));
      }
      send({ kind: "results", id: request.id, results });
    }
  } catch (error) {
    send({
      kind: "error",
      id: request.id,
      code:
        error instanceof UnsupportedInputError
          ? "unsupported-input"
          : error instanceof OnnxWorkerError
            ? error.code
            : "runtime",
    });
  }
}
