import { expect, it } from "vitest";
import { buildLlamaServerProviderConfig, mapLlamaServerModel } from "./models.js";

const row = (id: string) => ({ id, object: "model" });
const mapProps = (props: Parameters<typeof mapLlamaServerModel>[1]) =>
  mapLlamaServerModel(row("model"), props);

it("maps runtime context and chat-template capabilities", () => {
  const caps = { supports_tools: true, supports_tool_calls: true, supports_typed_content: true };
  expect(
    mapLlamaServerModel(
      { ...row("ggml-org/model:Q4_K_M"), status: { value: "loaded" } },
      {
        default_generation_settings: { n_ctx: 65536, params: { max_tokens: 4096 } },
        chat_template_caps: caps,
      },
    ),
  ).toMatchObject({
    status: "loaded",
    config: {
      id: "ggml-org/model:Q4_K_M",
      contextWindow: 65536,
      contextTokens: 65536,
      maxTokens: 4096,
      compat: {
        supportsTools: true,
        supportsUsageInStreaming: true,
        supportsJsonSchemaResponseFormat: true,
        requiresStringContent: false,
        maxTokensField: "max_tokens",
      },
    },
  });
});

it.each([
  [65_536, 32_768],
  [32_768, 16_384],
  [8_192, 8_192],
])("sizes the unadvertised output default to n_ctx %i", (nCtx, maxTokens) => {
  expect(mapProps({ default_generation_settings: { n_ctx: nCtx } })?.config.maxTokens).toBe(
    maxTokens,
  );
});

it("preserves image input advertised by router rows or runtime properties", () => {
  expect(
    mapLlamaServerModel({
      ...row("router-vision"),
      architecture: { input_modalities: ["text", "image"] },
    })?.config.input,
  ).toEqual(["text", "image"]);
  expect(mapProps({ modalities: { vision: true } })?.config.input).toEqual(["text", "image"]);
});

it("uses the tool-call capability for fallback tool descriptions", () => {
  const props = { chat_template_caps: { supports_tools: false, supports_tool_calls: true } };
  expect(mapProps(props)?.config.compat?.supportsTools).toBe(true);
});

it("rejects malformed and non-model rows", () => {
  expect(mapLlamaServerModel({ id: " " })).toBeNull();
  expect(mapLlamaServerModel({ id: "model", object: "collection" })).toBeNull();
});

it("keeps explicit model rows ahead of discovered rows", () => {
  const explicit = {
    id: "model",
    name: "Configured model",
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
  };
  const discovered = mapLlamaServerModel(row("model"));
  const second = mapLlamaServerModel(row("other"));
  if (!discovered || !second) {
    throw new Error("expected model fixtures to map");
  }

  const provider = buildLlamaServerProviderConfig({
    configured: { baseUrl: "http://localhost:8080/v1", models: [explicit] },
    discoveredModels: [discovered, second],
  });

  expect(provider.models).toHaveLength(2);
  expect(provider.models[0]).toMatchObject(explicit);
  expect(provider.models[1]?.id).toBe("other");
});

// One data[] row recorded from a llama-server /v1/models response (Qwen3-8B Q8_0).
const recordedQwen8bRow = {
  id: "qwen3-8b-q8_0",
  aliases: ["qwen3-8b-q8_0"],
  tags: [],
  object: "model",
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  created: 1795369134,
  owned_by: "llamacpp",
  meta: {
    vocab_type: 2,
    n_vocab: 151936,
    n_ctx: 32768,
    n_ctx_train: 40960,
    n_embd: 4096,
    n_params: 8190735360,
    size: 8703561728,
    ftype: "Q8_0",
  },
};

it("takes the total parameter count from the llama-server model metadata", () => {
  expect(mapLlamaServerModel(recordedQwen8bRow)?.config.parameterCount).toBe(8_190_735_360);
});

it.each([0, -5, 1.5, "8190735360", null, Number.MAX_SAFE_INTEGER + 2])(
  "ignores the unusable n_params value %s",
  (nParams) => {
    const mapped = mapLlamaServerModel({ ...recordedQwen8bRow, meta: { n_params: nParams } });
    expect(mapped?.config).not.toHaveProperty("parameterCount");
  },
);

it("leaves parameterCount unset when the row has no metadata", () => {
  expect(mapLlamaServerModel(row("model"))?.config).not.toHaveProperty("parameterCount");
});

it("passes the discovered count to a configured row on the same route only", () => {
  const discovered = mapLlamaServerModel(recordedQwen8bRow);
  if (!discovered) {
    throw new Error("expected the recorded row to map");
  }
  const configured = {
    id: "qwen3-8b-q8_0",
    name: "Qwen3 8B",
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 2048,
  };

  const sameRoute = buildLlamaServerProviderConfig({
    configured: { baseUrl: "http://localhost:8080/v1", models: [configured] },
    discoveredModels: [discovered],
  });
  const otherRoute = buildLlamaServerProviderConfig({
    configured: {
      baseUrl: "http://localhost:8080/v1",
      models: [{ ...configured, baseUrl: "http://localhost:9090/v1" }],
    },
    discoveredModels: [discovered],
  });

  expect(sameRoute.models[0]?.parameterCount).toBe(8_190_735_360);
  expect(otherRoute.models[0]).not.toHaveProperty("parameterCount");
});
