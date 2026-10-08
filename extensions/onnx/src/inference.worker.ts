import type { WorkerConfig } from "./config.js";
import type { ModelCache } from "./model-loader.js";
import { UnsupportedInputError } from "./models/types.js";
import { OnnxWorkerError, parseWorkerRequest, type WorkerReply } from "./protocol.js";

let config: WorkerConfig | undefined;
let cache: ModelCache | undefined;
let busy = false;

function send(reply: WorkerReply): void {
  if (!process.connected || !process.send) {
    process.exit(1);
  }
  process.send(reply, (error) => {
    if (error) {
      process.exit(1);
    }
  });
}

process.on("disconnect", () => process.exit(0));
process.on("message", (value: unknown) => {
  void handle(value).catch(() => process.exit(1));
});

async function handle(value: unknown): Promise<void> {
  const request = parseWorkerRequest(value);
  if (request.kind === "init") {
    if (config || busy) {
      throw new Error("Already initialized");
    }
    config = request.config;
    send({ kind: "ready" });
    return;
  }
  if (!config || busy) {
    throw new Error("Invalid worker admission");
  }
  busy = true;
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
        await cache.get(model);
      }
      send({ kind: "warmed", id: request.id });
    } else {
      const model = await cache.get(request.model);
      const results = [];
      for (const input of request.inputs) {
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
  } finally {
    busy = false;
  }
}
