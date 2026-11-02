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
