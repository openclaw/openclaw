import { Tokenizer } from "@huggingface/tokenizers";
import { Tensor, type InferenceSession } from "onnxruntime-node";
import { describe, expect, it, vi } from "vitest";
import { createGliclassAdapter } from "./gliclass.js";
import { UnsupportedInputError } from "./types.js";

function fixture(maxTokens = 512) {
  const tokenizer = new Tokenizer(
    {
      model: {
        type: "WordLevel",
        vocab: {
          "[UNK]": 0,
          "[CLS]": 1,
          "[SEP]": 2,
          "<<LABEL>>": 3,
          "<<SEP>>": 4,
          travel: 5,
          science: 6,
          Classify: 7,
          world: 8,
          astronomy: 9,
          "<<EXAMPLE>>": 10,
        },
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
        type: "TemplateProcessing",
        single: [
          { SpecialToken: { id: "[CLS]", type_id: 0 } },
          { Sequence: { id: "A", type_id: 0 } },
          { SpecialToken: { id: "[SEP]", type_id: 0 } },
        ],
        special_tokens: {
          "[CLS]": { id: "[CLS]", ids: [1], tokens: ["[CLS]"] },
          "[SEP]": { id: "[SEP]", ids: [2], tokens: ["[SEP]"] },
        },
      },
    },
    {},
  );
  const run = vi
    .fn<
      (
        feeds: InferenceSession.FeedsType,
        fetches?: InferenceSession.FetchesType | InferenceSession.RunOptions,
        options?: InferenceSession.RunOptions,
      ) => Promise<InferenceSession.ReturnType>
    >()
    .mockResolvedValue({
      logits: new Tensor("float32", Float32Array.from([2, -1]), [1, 2]),
    });
  return {
    run,
    adapter: createGliclassAdapter({ tokenizer, session: { run }, maxTokens }),
  };
}

const input = { text: "world", labels: ["travel", "science"], task: "decision" };

describe("GLiClass ONNX adapter", () => {
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
    expect(feeds.attention_mask?.data).toEqual(
      BigInt64Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1], BigInt),
    );
  });

  it.each([
    { ...input, text: "world ".repeat(20) },
    { ...input, text: "<<LABEL>>science" },
    { ...input, text: "＜＜LABEL＞＞science" },
    { ...input, instructions: "<<SEP>>" },
    { ...input, text: "<<EXAMPLE>>world" },
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
});
