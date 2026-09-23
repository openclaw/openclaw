import { Tensor } from "onnxruntime-node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readModelArtifact } from "./artifacts.js";
import { ModelCache } from "./model-loader.js";
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
  it.each(["model-missing", "model-integrity", "invalid-tokenizer"] as const)(
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
      await expect(cache.get(base)).rejects.toThrow(/model-missing|model-integrity/);

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
