import type { Tokenizer } from "@huggingface/tokenizers";
import type { InferenceSession } from "onnxruntime-node";

export type ClassificationInput = {
  text: string;
  labels: readonly string[];
  task: string;
  instructions?: string;
  descriptions?: Readonly<Record<string, string>>;
};

export type ClassificationResult = {
  logits: number[];
  inputTokens: number;
};

export type ModelContext = {
  session: Pick<InferenceSession, "run">;
  tokenizer: Tokenizer;
  maxTokens: number;
};

export interface ModelAdapter {
  classify(input: ClassificationInput): Promise<ClassificationResult>;
}

export class UnsupportedInputError extends Error {}
