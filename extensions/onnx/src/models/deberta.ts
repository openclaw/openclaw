import { Tensor } from "onnxruntime-node";
import { encodeModelText } from "./tokenize.js";
import { UnsupportedInputError, type ModelAdapter, type ModelContext } from "./types.js";

export function createDebertaAdapter({
  session,
  tokenizer,
  maxTokens,
}: ModelContext): ModelAdapter {
  return {
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
