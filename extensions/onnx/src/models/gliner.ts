import { Tensor } from "onnxruntime-node";
import { encodeModelText } from "./tokenize.js";
import { UnsupportedInputError, type ModelAdapter, type ModelContext } from "./types.js";

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

export function createGlinerAdapter({ session, tokenizer, maxTokens }: ModelContext): ModelAdapter {
  return {
    async classify({ text, labels, task, instructions, descriptions }) {
      const rubric = [
        task,
        ...labels,
        instructions,
        ...labels.map((label) => descriptions?.[label]),
      ];
      if (rubric.some((value) => value !== undefined && (!value.trim() || RESERVED.test(value)))) {
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
          throw new UnsupportedInputError("GLiNER2.5 input exceeds the token limit or is empty.");
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
}
