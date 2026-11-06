import type { WorkerConfig } from "./config.js";
import type { ClassificationInput, ClassificationResult } from "./models/types.js";

export type WorkerRequest =
  | { kind: "init"; config: WorkerConfig }
  | { kind: "classify"; model: string; inputs: ClassificationInput[] }
  | { kind: "warm"; models: string[] };

export type WorkerErrorCode =
  | "unsupported-input"
  | "model-missing"
  | "model-integrity"
  | "dependency-unavailable"
  | "runtime";

export type WorkerReply =
  | { kind: "results"; results: ClassificationResult[] }
  | { kind: "warmed" }
  | { kind: "error"; code: WorkerErrorCode };

export class OnnxWorkerError extends Error {
  constructor(readonly code: WorkerErrorCode) {
    super(`ONNX worker: ${code}`);
  }
}
