import { Buffer } from "node:buffer";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, test, vi } from "vitest";
import { createEmbeddings } from "./embeddings.js";

const { post } = vi.hoisted(() => ({
  post: vi.fn<() => Promise<{ data: Array<{ embedding: unknown }> }>>(),
}));

vi.mock("openai", () => ({
  default: class {
    post = post;
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
}));

async function embedResponse(value: unknown): Promise<number[]> {
  post.mockResolvedValue({ data: [{ embedding: value }] });
  const embeddings = createEmbeddings(createTestPluginApi());
  try {
    return await embeddings.embed("main", "embedding fixture", {
      provider: "openai",
      apiKey: "fixture-key",
      model: "test-model",
    });
  } finally {
    await embeddings.close?.();
  }
}

test("accepts float arrays and base64 float32 responses", async () => {
  await expect(embedResponse([0.1, 0.2, 0.3])).resolves.toEqual([0.1, 0.2, 0.3]);

  const bytes = Buffer.alloc(2 * Float32Array.BYTES_PER_ELEMENT);
  bytes.writeFloatLE(1.25, 0);
  bytes.writeFloatLE(-2.5, Float32Array.BYTES_PER_ELEMENT);
  await expect(embedResponse(bytes.toString("base64"))).resolves.toEqual([1.25, -2.5]);
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "rejects nonfinite %s in float and base64 embeddings",
  async (coordinate) => {
    const bytes = Buffer.alloc(Float32Array.BYTES_PER_ELEMENT);
    bytes.writeFloatLE(coordinate);
    for (const vector of [[coordinate], bytes.toString("base64")]) {
      await expect(embedResponse(vector)).rejects.toThrow(
        "Embedding response contains non-numeric values",
      );
    }
  },
);

test.each([
  ["abc", "Base64 embedding response has invalid byte length"],
  ["!!!!", "Base64 embedding response is malformed"],
  ["ZE==", "Base64 embedding response is malformed"],
  ["AQIDBE==", "Base64 embedding response is malformed"],
  [undefined, "Embedding response is missing a vector"],
])("rejects malformed embedding payload %s", async (value, error) => {
  await expect(embedResponse(value)).rejects.toThrow(error);
});
