import { Tokenizer } from "@huggingface/tokenizers";
import { InferenceSession } from "onnxruntime-node";
import { readModelArtifact, resolveModelFiles } from "./artifacts.js";
import { findModel } from "./catalog.js";
import type { WorkerConfig } from "./config.js";
import { createDebertaAdapter } from "./models/deberta.js";
import { createGliclassAdapter } from "./models/gliclass.js";
import { createGlinerAdapter } from "./models/gliner.js";
import { UnsupportedInputError, type ModelAdapter } from "./models/types.js";
import { OnnxWorkerError } from "./protocol.js";

function jsonObject(data: Buffer): object {
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OnnxWorkerError("model-integrity");
  }
  return parsed;
}

export class ModelCache {
  private readonly models = new Map<string, { session: InferenceSession; adapter: ModelAdapter }>();
  constructor(private readonly config: WorkerConfig) {}

  async get(id: string): Promise<ModelAdapter> {
    const existing = this.models.get(id);
    if (existing) {
      this.models.delete(id);
      this.models.set(id, existing);
      return existing.adapter;
    }
    const model = findModel(id);
    if (!model) {
      throw new UnsupportedInputError("Unknown ONNX model.");
    }
    const files = await resolveModelFiles(this.config.modelDir, model);
    const buffers = new Map<string, Buffer>();
    for (const file of files) {
      buffers.set(file.name, await readModelArtifact(this.config.modelDir, model, file));
    }
    const modelBytes = buffers.get("model.onnx");
    const tokenizerBytes = buffers.get("tokenizer.json");
    if (!modelBytes || !tokenizerBytes) {
      throw new OnnxWorkerError("model-integrity");
    }
    const tokenizerConfig = buffers.get("tokenizer_config.json");
    const tokenizer = new Tokenizer(
      jsonObject(tokenizerBytes),
      tokenizerConfig ? jsonObject(tokenizerConfig) : {},
    );
    if (this.models.size >= this.config.maxLoadedModels) {
      const first = this.models.entries().next().value;
      if (first) {
        this.models.delete(first[0]);
        await first[1].session.release();
      }
    }
    // An in-memory graph cannot implicitly follow external-data filesystem paths.
    const session = await InferenceSession.create(modelBytes, {
      executionProviders: ["cpu"],
      intraOpNumThreads: this.config.threads,
      interOpNumThreads: 1,
      logSeverityLevel: 3,
    });
    try {
      const context = { session, tokenizer, maxTokens: model.maxTokens };
      const adapter =
        model.family === "gliclass"
          ? createGliclassAdapter(context)
          : model.family === "gliner"
            ? createGlinerAdapter(context)
            : createDebertaAdapter(context);
      this.models.set(id, { session, adapter });
      return adapter;
    } catch (error) {
      await session.release();
      throw error;
    }
  }
}
