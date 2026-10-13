import { Tensor } from "onnxruntime-node";
import { encodeModelText } from "./tokenize.js";
import { UnsupportedInputError, type ModelAdapter, type ModelContext } from "./types.js";

export function createGliclassAdapter(context: ModelContext): ModelAdapter {
  const labelToken = context.tokenizer.token_to_id("<<LABEL>>");
  const separatorToken = context.tokenizer.token_to_id("<<SEP>>");
  const exampleToken = context.tokenizer.token_to_id("<<EXAMPLE>>");
  if (labelToken === undefined || separatorToken === undefined || labelToken === separatorToken) {
    throw new Error("GLiClass tokenizer is missing its label and separator tokens.");
  }

  return {
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
      const encoded = encodeModelText(context.tokenizer, packed);
      if (encoded.ids.length > context.maxTokens) {
        throw new UnsupportedInputError(
          `GLiClass input exceeds its ${context.maxTokens}-token limit; shorten the state or rubric.`,
        );
      }
      // Normalization can turn Unicode lookalikes into added control tokens.
      if (
        encoded.ids.filter((token) => token === labelToken).length !== labels.length ||
        encoded.ids.filter((token) => token === separatorToken).length !== 1 ||
        (exampleToken !== undefined && encoded.ids.includes(exampleToken))
      ) {
        throw new UnsupportedInputError("GLiClass input changes the number of rubric markers.");
      }

      const shape = [1, encoded.ids.length];
      const output = await context.session.run({
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
}
