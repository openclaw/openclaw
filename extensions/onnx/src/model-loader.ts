import { Tokenizer } from "@huggingface/tokenizers";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { readModelArtifact, resolveModelFiles } from "./artifacts.js";
import { findModel } from "./catalog.js";
import type { WorkerConfig } from "./config.js";
import { encodeModelText } from "./models/tokenize.js";
import { UnsupportedInputError, type ModelAdapter } from "./models/types.js";
import { OnnxWorkerError } from "./protocol.js";

// Matches GLiNER2's WhitespaceTokenSplitter before per-word subword tokenization.
const WORDS =
  /(?:https?:\/\/[^\s]+|www\.[^\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|\S/giu;
const RESERVED = /\[(?:P|L|C|E|R|DESCRIPTION|EXAMPLE|OUTPUT|SEP_TEXT|SEP_STRUCT)\]|[()]/u;

function indices(values: readonly number[]): Tensor {
  return new Tensor("int64", BigInt64Array.from(values, BigInt), [1, values.length]);
}

function mask(length: number, value = 1): Tensor {
  return new Tensor("float32", new Float32Array(length).fill(value), [1, length]);
}

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

  async close(): Promise<void> {
    const models = [...this.models.values()];
    this.models.clear();
    const results = await Promise.allSettled(models.map(({ session }) => session.release()));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((result) => result.reason),
        "ONNX session release failed",
      );
    }
  }

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
      const maxTokens = model.maxTokens;
      let adapter: ModelAdapter;
      if (model.family === "gliclass") {
        const labelToken = tokenizer.token_to_id("<<LABEL>>");
        const separatorToken = tokenizer.token_to_id("<<SEP>>");
        const exampleToken = tokenizer.token_to_id("<<EXAMPLE>>");
        if (
          labelToken === undefined ||
          separatorToken === undefined ||
          labelToken === separatorToken
        ) {
          throw new Error("GLiClass tokenizer is missing its label and separator tokens.");
        }
        adapter = {
          async classify(input) {
            const labels = input.labels.map((label) => input.descriptions?.[label] ?? label);
            const text = input.instructions ? `${input.instructions}\n${input.text}` : input.text;
            if (
              labels.length < 2 ||
              labels.length > 64 ||
              labels.some((label) => !label.trim()) ||
              new Set(labels).size !== labels.length ||
              [text, ...labels].some((value) =>
                /<<LABEL>>|<<SEP>>|<<EXAMPLE>>/.test(value.normalize("NFKC")),
              )
            ) {
              throw new UnsupportedInputError(
                "GLiClass requires 2–64 distinct labels and input without its reserved markers.",
              );
            }

            const packed = `${labels.map((label) => `<<LABEL>>${label}`).join("")}<<SEP>>${text}`;
            const encoded = encodeModelText(tokenizer, packed);
            if (encoded.ids.length > maxTokens) {
              throw new UnsupportedInputError(
                `GLiClass input exceeds its ${maxTokens}-token limit; shorten the state or rubric.`,
              );
            }
            // Normalization can turn Unicode lookalikes into added control tokens.
            if (
              encoded.ids.filter((token) => token === labelToken).length !== labels.length ||
              encoded.ids.filter((token) => token === separatorToken).length !== 1 ||
              (exampleToken !== undefined && encoded.ids.includes(exampleToken))
            ) {
              throw new UnsupportedInputError(
                "GLiClass input changes the number of rubric markers.",
              );
            }

            const shape = [1, encoded.ids.length];
            const output = await session.run({
              input_ids: new Tensor("int64", BigInt64Array.from(encoded.ids, BigInt), shape),
              attention_mask: new Tensor(
                "int64",
                BigInt64Array.from(encoded.attention_mask, BigInt),
                shape,
              ),
            });
            const scores = output.logits;
            if (
              !scores ||
              scores.type !== "float32" ||
              !(scores.data instanceof Float32Array) ||
              scores.dims.length !== 2 ||
              scores.dims[0] !== 1 ||
              scores.dims[1] !== labels.length ||
              scores.data.length !== labels.length
            ) {
              throw new Error("GLiClass returned an invalid label-logit shape.");
            }
            const logits = Array.from(scores.data);
            if (logits.some((value) => !Number.isFinite(value))) {
              throw new Error("GLiClass returned non-finite label logits.");
            }
            return { logits, inputTokens: encoded.ids.length };
          },
        };
      } else if (model.family === "gliner") {
        adapter = {
          async classify({ text, labels, task, instructions, descriptions }) {
            const rubric = [
              task,
              ...labels,
              instructions,
              ...labels.map((label) => descriptions?.[label]),
            ];
            if (
              rubric.some((value) => value !== undefined && (!value.trim() || RESERVED.test(value)))
            ) {
              throw new UnsupportedInputError(
                "GLiNER2.5 rubric contains an empty or reserved schema token.",
              );
            }
            let prompt = instructions ? `${task}: ${instructions}` : task;
            for (const label of labels) {
              if (descriptions?.[label]) {
                prompt += ` [DESCRIPTION] ${label}: ${descriptions[label]}`;
              }
            }
            const inputIds: number[] = [];
            const append = (token: string) => {
              const encoded = encodeModelText(tokenizer, token, { add_special_tokens: false }).ids;
              if (encoded.length === 0 || inputIds.length + encoded.length > maxTokens) {
                throw new UnsupportedInputError(
                  "GLiNER2.5 input exceeds the token limit or is empty.",
                );
              }
              inputIds.push(...encoded);
            };
            for (const token of ["(", "[P]", prompt, "("]) {
              append(token);
            }
            const classificationPositions: number[] = [];
            for (const label of labels) {
              classificationPositions.push(inputIds.length);
              // [L] is the trained classification marker; [C] belongs to choice fields.
              append("[L]");
              append(label);
            }
            for (const token of [")", ")", "[SEP_TEXT]"]) {
              append(token);
            }
            const normalized = /[.!?]$/.test(text) ? text : `${text}.`;
            const wordPositions: number[] = [];
            for (const match of normalized.matchAll(WORDS)) {
              wordPositions.push(inputIds.length);
              append(match[0].toLowerCase());
            }
            const feeds = {
              input_ids: indices(inputIds),
              attention_mask: indices(inputIds.map(() => 1)),
              text_word_indices: indices(wordPositions),
              text_word_mask: mask(wordPositions.length),
              query_marker_indices: indices([0]),
              query_marker_mask: mask(1, 0),
              cls_marker_indices: indices(classificationPositions),
              cls_marker_mask: mask(labels.length),
              rel_marker_indices: indices([0]),
              rel_marker_mask: mask(1, 0),
            };
            const output = (await session.run(feeds, ["cls_logits"])).cls_logits;
            if (
              !output ||
              output.type !== "float32" ||
              output.dims.length !== 2 ||
              output.dims[0] !== 1 ||
              output.dims[1] !== labels.length
            ) {
              throw new Error("GLiNER2.5 returned an invalid classification tensor.");
            }
            const logits = Array.from(output.data, Number);
            if (logits.some((value) => !Number.isFinite(value))) {
              throw new Error("GLiNER2.5 returned non-finite classification logits.");
            }
            return { logits, inputTokens: inputIds.length };
          },
        };
      } else {
        adapter = {
          async classify({ text, labels, instructions, descriptions }) {
            const premise = instructions ? `${instructions}\n${text}` : text;
            const encoded = labels.map((label) => {
              const hypothesis = descriptions?.[label] ?? `This example is ${label}.`;
              const pair = encodeModelText(tokenizer, premise, {
                text_pair: hypothesis,
                add_special_tokens: true,
              });
              if (pair.ids.length > maxTokens) {
                throw new UnsupportedInputError(
                  "DeBERTa input exceeds its token limit; shorten the state or rubric.",
                );
              }
              return pair;
            });
            const logits: number[] = [];
            const pad = tokenizer.token_to_id("[PAD]");
            if (pad === undefined) {
              throw new Error("DeBERTa tokenizer is missing its padding token.");
            }
            for (let offset = 0; offset < encoded.length; offset += 8) {
              const batch = encoded.slice(offset, offset + 8);
              const length = Math.max(...batch.map((pair) => pair.ids.length));
              const ids = new BigInt64Array(batch.length * length).fill(BigInt(pad));
              const attention = new BigInt64Array(ids.length);
              batch.forEach((pair, row) => {
                ids.set(BigInt64Array.from(pair.ids, BigInt), row * length);
                attention.set(BigInt64Array.from(pair.attention_mask, BigInt), row * length);
              });
              const shape = [batch.length, length];
              const output = await session.run({
                input_ids: new Tensor("int64", ids, shape),
                attention_mask: new Tensor("int64", attention, shape),
              });
              const scores = output.logits;
              if (
                !scores ||
                scores.type !== "float32" ||
                scores.dims.length !== 2 ||
                !(scores.data instanceof Float32Array) ||
                scores.dims[0] !== batch.length ||
                scores.dims[1] !== 2 ||
                scores.data.length !== batch.length * 2
              ) {
                throw new Error("DeBERTa returned an invalid entailment tensor.");
              }
              // The pinned checkpoint defines label 0 as entailment. Exclusive zero-shot
              // classification normalizes these logits across the offered hypotheses.
              for (let row = 0; row < batch.length; row++) {
                const entailment = scores.data[row * 2]!;
                if (!Number.isFinite(entailment)) {
                  throw new Error("DeBERTa returned non-finite logits.");
                }
                logits.push(entailment);
              }
            }
            return { logits, inputTokens: encoded.reduce((sum, pair) => sum + pair.ids.length, 0) };
          },
        };
      }
      this.models.set(id, { session, adapter });
      return adapter;
    } catch (error) {
      await session.release();
      throw error;
    }
  }
}
