import { Tokenizer } from "@huggingface/tokenizers";
import { Tensor, type InferenceSession } from "onnxruntime-node";
import { expect, it, vi } from "vitest";
import { createGliclassAdapter } from "./gliclass.js";
import { UnsupportedInputError } from "./types.js";

function fixture(maxTokens = 512) {
  const vocabulary =
    "[UNK] [CLS] [SEP] <<LABEL>> <<SEP>> travel science Classify world astronomy <<EXAMPLE>>";
  const tokenizer = new Tokenizer(
    {
      model: {
        type: "WordLevel",
        vocab: Object.fromEntries(vocabulary.split(" ").map((token, id) => [token, id])),
        unk_token: "[UNK]",
      },
      added_tokens: [
        { id: 3, content: "<<LABEL>>", normalized: true, special: false },
        { id: 4, content: "<<SEP>>", normalized: true, special: false },
        { id: 10, content: "<<EXAMPLE>>", normalized: true, special: false },
      ],
      decoder: null,
      normalizer: { type: "NFKC" },
      pre_tokenizer: { type: "Whitespace" },
      post_processor: {
        type: "BertProcessing",
        cls: ["[CLS]", 1],
        sep: ["[SEP]", 2],
      },
    },
    {},
  );
  const run = vi
    .fn<(feeds: InferenceSession.FeedsType) => Promise<InferenceSession.ReturnType>>()
    .mockResolvedValue({
      logits: new Tensor("float32", Float32Array.from([2, -1]), [1, 2]),
    });
  return { run, adapter: createGliclassAdapter({ tokenizer, session: { run }, maxTokens }) };
}

const input = { text: "world", labels: ["travel", "science"], task: "decision" };

it("packs the documented rubric and preserves unnormalized logits in label order", async () => {
  const { adapter, run } = fixture();
  const result = await adapter.classify({
    ...input,
    instructions: "Classify",
    descriptions: { travel: "astronomy" },
  });

  expect(result).toEqual({ logits: [2, -1], inputTokens: 9 });
  const feeds = run.mock.calls[0]![0];
  expect(feeds.input_ids?.data).toEqual(BigInt64Array.from([1, 3, 9, 3, 6, 4, 7, 8, 2], BigInt));
  expect(feeds.attention_mask?.data).toEqual(new BigInt64Array(9).fill(1n));
});

it.each([
  { ...input, text: "world ".repeat(20) },
  { ...input, text: "＜＜LABEL＞＞science" },
  { ...input, instructions: "<<SEP>>" },
  { ...input, text: "＜＜EXAMPLE＞＞world" },
  { ...input, descriptions: { travel: "science" } },
  { ...input, descriptions: { travel: " " } },
  { ...input, labels: ["travel"] },
])("rejects unrepresentable rubrics before inference: %j", async (request) => {
  const { adapter, run } = fixture(16);
  await expect(adapter.classify(request)).rejects.toBeInstanceOf(UnsupportedInputError);
  expect(run).not.toHaveBeenCalled();
});

it.each([
  new Tensor("float32", Float32Array.from([2]), [1, 1]),
  new Tensor("float32", Float32Array.from([2, -1]), [2, 1]),
  new Tensor("float32", Float32Array.from([2, Number.NaN]), [1, 2]),
])("rejects missing, misaligned, or non-finite logits", async (logits) => {
  const { adapter, run } = fixture();
  run.mockResolvedValue({ logits });
  await expect(adapter.classify(input)).rejects.toThrow(/GLiClass returned/);
});
