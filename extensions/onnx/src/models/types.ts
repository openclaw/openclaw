import type { Tokenizer } from "@huggingface/tokenizers";
import type { InferenceSession } from "onnxruntime-node";
import type { WorkerReply, WorkerRequest } from "../protocol.js";

type WorkerClassificationInput = Extract<WorkerRequest, { kind: "classify" }>["inputs"][number];
export type ClassificationInput = Omit<WorkerClassificationInput, "labels" | "descriptions"> & {
  labels: readonly string[];
  descriptions?: Readonly<Record<string, string>>;
};

export type ClassificationResult = Extract<WorkerReply, { kind: "results" }>["results"][number];

export type ModelContext = {
  session: Pick<InferenceSession, "run">;
  tokenizer: Tokenizer;
  maxTokens: number;
};

export interface ModelAdapter {
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}

export class UnsupportedInputError extends Error {}
