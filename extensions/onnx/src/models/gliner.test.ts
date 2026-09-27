import { Tokenizer } from "@huggingface/tokenizers";
import { Tensor, type InferenceSession } from "onnxruntime-node";
import { describe, expect, it, vi } from "vitest";
import { createGlinerAdapter } from "./gliner.js";
import { UnsupportedInputError } from "./types.js";

function fixture(maxTokens = 128) {
  const vocabulary = [
    "[UNK]",
    "(",
    ")",
    "[P]",
    "[L]",
    "[C]",
    "[SEP_TEXT]",
    "sentiment",
    "positive",
    "negative",
    "great",
    ".",
    "[CLS]",
    "[SEP]",
    ":",
  ];
  const tokenizer = new Tokenizer(
    {
      model: {
        type: "WordPiece",
        vocab: Object.fromEntries(vocabulary.map((token, index) => [token, index])),
        unk_token: "[UNK]",
      },
      normalizer: null,
      pre_tokenizer: { type: "Whitespace" },
      decoder: { type: "WordPiece", prefix: "##", cleanup: true },
      added_tokens: vocabulary.flatMap((content, id) =>
        content.startsWith("[") ? [{ content, id, special: true, normalized: false }] : [],
      ),
      post_processor: {
        type: "BertProcessing",
        cls: ["[CLS]", 12],
        sep: ["[SEP]", 13],
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
      cls_logits: new Tensor("float32", [2, -1], [1, 2]),
    });
  const session = { run };
  return { run, adapter: createGlinerAdapter({ session, tokenizer, maxTokens }) };
}

const input = { text: "Great", labels: ["positive", "negative"], task: "sentiment" };

describe("GLiNER2.5 classification adapter", () => {
  it("packs trained [L] markers and word routes without encoder special tokens", async () => {
    const { run, adapter } = fixture();
    await expect(adapter.classify(input)).resolves.toEqual({ logits: [2, -1], inputTokens: 13 });
    const feeds = run.mock.calls[0]![0];
    expect(Array.from(feeds.input_ids!.data, Number)).toEqual([
      1, 3, 7, 1, 4, 8, 4, 9, 2, 2, 6, 10, 11,
    ]);
    expect(Array.from(feeds.cls_marker_indices!.data, Number)).toEqual([4, 6]);
    expect(Array.from(feeds.text_word_indices!.data, Number)).toEqual([11, 12]);
    expect(Array.from(feeds.query_marker_mask!.data, Number)).toEqual([0]);
    expect(Array.from(feeds.rel_marker_mask!.data, Number)).toEqual([0]);
  });

  it("rejects reserved rubric markers before model inference", async () => {
    const { run, adapter } = fixture();
    await expect(adapter.classify({ ...input, instructions: "[L]" })).rejects.toBeInstanceOf(
      UnsupportedInputError,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects the whole overlength rubric instead of truncating a class or state", async () => {
    const { run, adapter } = fixture(12);
    await expect(adapter.classify(input)).rejects.toBeInstanceOf(UnsupportedInputError);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([new Tensor("float32", [2], [1, 1]), new Tensor("float32", [Number.NaN, 1], [1, 2])])(
    "rejects malformed model output",
    async (cls_logits) => {
      const { run, adapter } = fixture();
      run.mockResolvedValue({ cls_logits });
      await expect(adapter.classify(input)).rejects.toThrow(/classification/);
    },
  );
});
