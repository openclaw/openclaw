import { Buffer } from "node:buffer";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, test, vi } from "vitest";
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

describe("memory-lancedb embedding responses", () => {
  test("accepts float arrays and base64 float32 responses", async () => {
    await expect(embedResponse([0.1, 0.2, 0.3])).resolves.toEqual([0.1, 0.2, 0.3]);

    const bytes = Buffer.alloc(2 * Float32Array.BYTES_PER_ELEMENT);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setFloat32(0, 1.25, true);
    view.setFloat32(Float32Array.BYTES_PER_ELEMENT, -2.5, true);

    const decoded = await embedResponse(bytes.toString("base64"));
    expect(decoded[0]).toBeCloseTo(1.25);
    expect(decoded[1]).toBeCloseTo(-2.5);
  });

  test.each(["float array", "base64"])("rejects nonfinite %s embeddings", async (encoding) => {
    const bytes = Buffer.alloc(Float32Array.BYTES_PER_ELEMENT);
    bytes.writeFloatLE(Number.NaN);
    const vector = encoding === "base64" ? bytes.toString("base64") : [Number.NaN];
    await expect(embedResponse(vector)).rejects.toThrow(
      "Embedding response contains non-numeric values",
    );
  });

  test("rejects malformed embedding payloads", async () => {
    await expect(embedResponse("abc")).rejects.toThrow(
      "Base64 embedding response has invalid byte length",
    );
    await expect(embedResponse("!!!!")).rejects.toThrow("Base64 embedding response is malformed");
    await expect(embedResponse("ZE==")).rejects.toThrow("Base64 embedding response is malformed");
    await expect(embedResponse("AQIDBE==")).rejects.toThrow(
      "Base64 embedding response is malformed",
    );
    await expect(embedResponse(undefined)).rejects.toThrow(
      "Embedding response is missing a vector",
    );
  });
});
