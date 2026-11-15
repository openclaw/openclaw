import { Tensor, type InferenceSession } from "onnxruntime-node";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { readModelArtifact } from "./artifacts.js";
import { findModel } from "./catalog.js";
import { ModelCache } from "./model-loader.js";
import { UnsupportedInputError } from "./models/types.js";
import { OnnxWorkerError } from "./protocol.js";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("onnxruntime-node", async (importOriginal) => ({
  ...(await importOriginal<typeof import("onnxruntime-node")>()),
  InferenceSession: { create },
}));
vi.mock("./artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./artifacts.js")>()),
  readModelArtifact: vi.fn(),
}));

vi.mock("./catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog.js")>();
  return { ...actual, findModel: vi.fn(actual.findModel) };
});

async function classificationFixture(
  id: string,
  tokenizerConfig: object,
  output: InferenceSession.ReturnType,
  maxTokens: number,
) {
  const run = vi
    .fn<(feeds: InferenceSession.FeedsType) => Promise<InferenceSession.ReturnType>>()
    .mockResolvedValue(output);
  create.mockResolvedValueOnce({ run, release: vi.fn(async () => {}) });
  const model = findModel(id)!;
  vi.mocked(findModel).mockReturnValueOnce({ ...model, maxTokens });
  vi.mocked(readModelArtifact).mockImplementation(async (_root, _model, file) =>
    file.name === "tokenizer.json"
      ? Buffer.from(JSON.stringify(tokenizerConfig))
      : Buffer.from(file.name === "tokenizer_config.json" ? "{}" : "graph"),
  );
  const cache = new ModelCache({ modelDir: "/models", threads: 1, maxLoadedModels: 1 });
  onTestFinished(() => cache.close());
  return { run, adapter: await cache.get(id) };
}

const tokenizer = Buffer.from(
  JSON.stringify({
    model: {
      type: "WordLevel",
      vocab: { "[UNK]": 0, travel: 3, finance: 4, holiday: 5 },
      unk_token: "[UNK]",
    },
    added_tokens: [
      { id: 1, content: "<<LABEL>>", normalized: false, special: true },
      { id: 2, content: "<<SEP>>", normalized: false, special: true },
    ],
    decoder: null,
    normalizer: null,
    post_processor: null,
    pre_tokenizer: { type: "Whitespace" },
  }),
);
const edge = "gliclass-edge-v3.0";
const base = "gliclass-base-v3.0";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readModelArtifact).mockImplementation(async (_root, _model, file) =>
    file.name === "tokenizer.json" ? tokenizer : Buffer.from("graph"),
  );
});

describe("ONNX resident model cache", () => {
  it("releases every native session even when one release fails", async () => {
    const failure = new Error("release failed");
    const first = vi.fn(async () => {
      throw failure;
    });
    const second = vi.fn(async () => {});
    create.mockResolvedValueOnce({ release: first }).mockResolvedValueOnce({ release: second });
    const cache = new ModelCache({ modelDir: "/models", threads: 1, maxLoadedModels: 2 });
    await cache.get(edge);
    await cache.get(base);
    await expect(cache.close()).rejects.toMatchObject({ errors: [failure] });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    await cache.close();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it.each(["model-integrity", "invalid-tokenizer"] as const)(
    "keeps the warm session when the replacement has %s",
    async (failure) => {
      const release = vi.fn(async () => {});
      const run = vi.fn(async () => ({
        logits: new Tensor("float32", [2, -1], [1, 2]),
      }));
      create.mockResolvedValue({ release, run });
      const cache = new ModelCache({ modelDir: "/models", threads: 1, maxLoadedModels: 1 });
      await cache.get(edge);
      if (failure === "invalid-tokenizer") {
        vi.mocked(readModelArtifact)
          .mockResolvedValueOnce(Buffer.from("graph"))
          .mockResolvedValueOnce(Buffer.from("null"));
      } else {
        vi.mocked(readModelArtifact).mockRejectedValueOnce(new OnnxWorkerError(failure));
      }
      await expect(cache.get(base)).rejects.toThrow("model-integrity");

      const resident = await cache.get(edge);
      await expect(
        resident.classify({ text: "holiday", labels: ["travel", "finance"], task: "decision" }),
      ).resolves.toMatchObject({ logits: [2, -1] });
      expect(release).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledOnce();

      // A valid replacement still releases the resident before creating another session.
      create.mockImplementationOnce(async () => {
        expect(release).toHaveBeenCalledOnce();
        return { release: vi.fn(), run };
      });
      await cache.get(base);
      expect(create).toHaveBeenCalledTimes(2);
    },
  );
});

describe("gliclass through the resident model cache", () => {
  async function fixture(maxTokens = 512) {
    const vocabulary =
      "[UNK] [CLS] [SEP] <<LABEL>> <<SEP>> travel science Classify world astronomy <<EXAMPLE>>";
    return classificationFixture(
      "gliclass-edge-v3.0",
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
      {
        logits: new Tensor("float32", Float32Array.from([2, -1]), [1, 2]),
      },
      maxTokens,
    );
  }

  const input = { text: "world", labels: ["travel", "science"], task: "decision" };

  it("packs the documented rubric and preserves unnormalized logits in label order", async () => {
    const { adapter, run } = await fixture();
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
    const { adapter, run } = await fixture(16);
    await expect(adapter.classify(request)).rejects.toBeInstanceOf(UnsupportedInputError);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    new Tensor("float32", Float32Array.from([2]), [1, 1]),
    new Tensor("float32", Float32Array.from([2, -1]), [2, 1]),
    new Tensor("float32", Float32Array.from([2, Number.NaN]), [1, 2]),
  ])("rejects missing, misaligned, or non-finite logits", async (logits) => {
    const { adapter, run } = await fixture();
    run.mockResolvedValue({ logits });
    await expect(adapter.classify(input)).rejects.toThrow(/GLiClass returned/);
  });
});

describe("GLiNER2.5 classification adapter", () => {
  async function fixture(maxTokens = 128) {
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
    return classificationFixture(
      "gliner2.5-small-v1",
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
      {
        cls_logits: new Tensor("float32", [2, -1], [1, 2]),
      },
      maxTokens,
    );
  }

  const input = { text: "Great", labels: ["positive", "negative"], task: "sentiment" };

  it("packs trained [L] markers and word routes without encoder special tokens", async () => {
    const { run, adapter } = await fixture();
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
    const { run, adapter } = await fixture();
    await expect(adapter.classify({ ...input, instructions: "[L]" })).rejects.toBeInstanceOf(
      UnsupportedInputError,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects the whole overlength rubric instead of truncating a class or state", async () => {
    const { run, adapter } = await fixture(12);
    await expect(adapter.classify(input)).rejects.toBeInstanceOf(UnsupportedInputError);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([new Tensor("float32", [2], [1, 1]), new Tensor("float32", [Number.NaN, 1], [1, 2])])(
    "rejects malformed model output",
    async (cls_logits) => {
      const { run, adapter } = await fixture();
      run.mockResolvedValue({ cls_logits });
      await expect(adapter.classify(input)).rejects.toThrow(/classification/);
    },
  );
});
