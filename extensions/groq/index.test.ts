import { streamSimple, resolveOpenAIRequestReasoning, type Model } from "openclaw/plugin-sdk/llm";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { assert, expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const catalog = buildManifestModelProviderConfig({
  providerId: "groq",
  catalog: manifest.modelCatalog.providers.groq,
});
const qwen = catalog.models.find((model) => model.id === "qwen/qwen3.6-27b");
if (!qwen) {
  throw new Error("Expected Groq Qwen catalog model");
}
const enabledLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const context = { messages: [] };
const makeModel = (row: (typeof catalog.models)[number]) =>
  ({
    ...row,
    input: ["text"],
    provider: "groq",
    api: "openai-completions",
    baseUrl: catalog.baseUrl,
  }) satisfies Model<"openai-completions">;
function completionStreams(model: Model<"openai-completions">) {
  const [provider] = capturePluginRegistration(plugin).providers;
  return [provider?.wrapStreamFn, provider?.wrapSimpleCompletionStreamFn].map((wrap) => {
    const stream = wrap?.({ provider: "groq", modelId: model.id, model, streamFn: streamSimple });
    if (!stream) {
      throw new Error("Expected wrapped Groq stream");
    }
    return stream;
  });
}

it("clamps GPT OSS thinking levels to Groq's low, medium, and high efforts", () => {
  const rows = catalog.models.filter((model) => model.id.includes("gpt-oss"));
  expect(rows.map((row) => row.id)).toEqual([
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-safeguard-20b",
  ]);
  for (const row of rows) {
    const model = makeModel(row);
    // Groq rejects `minimal` for GPT OSS with a 400.
    expect(
      (["minimal", "medium", "xhigh"] as const).map(
        (reasoning) => buildOpenAICompletionsParams(model, context, { reasoning }).reasoning_effort,
      ),
    ).toEqual(["low", "medium", "high"]);
  }
});

it("maps Groq reasoning to its wire contract on both completion paths", async () => {
  const gptOss = catalog.models.find((model) => model.id === "openai/gpt-oss-120b");
  assert(gptOss, "Expected Groq GPT OSS catalog model");
  expect(qwen.input).toEqual(["text"]);
  expect(qwen.compat?.supportedReasoningEfforts).toEqual(["none", "default"]);
  const qwenModel = makeModel(qwen);
  expect(
    ["none", "adaptive"].map((level) => resolveOpenAIRequestReasoning(qwenModel, level).effort),
  ).toEqual(["none", "default"]);
  expect(
    buildOpenAICompletionsParams(qwenModel, context, { reasoningEffort: "none" }).reasoning_effort,
  ).toBe("none");
  for (const [row, levels, effort, parsed] of [
    [qwen, [undefined, "off", ...enabledLevels], "default", true],
    [{ ...qwen, id: "qwen/future-reasoner" }, ["high"], "default", true],
    [{ ...qwen, id: "qwen/future-text-model", reasoning: false }, ["high"], undefined, false],
    [gptOss, ["high"], "high", false],
  ] as const) {
    const model = makeModel(row);
    for (const [streamFn, reasoning] of completionStreams(model).flatMap((stream) =>
      levels.map((level) => [stream, level] as const),
    )) {
      let payload: unknown;
      const stream = await streamFn(model, context, {
        apiKey: "synthetic-unused-key",
        reasoning,
        onPayload(value) {
          payload = value;
          throw new Error("captured before request");
        },
      });
      expect((await stream.result()).errorMessage).toBe("captured before request");
      const enabled = reasoning !== undefined && reasoning !== "off";
      if (effort === undefined) {
        expect(payload).not.toHaveProperty("reasoning_effort");
      } else {
        expect(payload).toMatchObject({ reasoning_effort: enabled ? effort : "none" });
      }
      if (enabled && parsed) {
        expect(payload).toHaveProperty("reasoning_format", "parsed");
      } else {
        expect(payload).not.toHaveProperty("reasoning_format");
      }
    }
  }
});

it("registers Groq model and media providers", () => {
  const captured = capturePluginRegistration(plugin);
  const [provider] = captured.providers;
  expect(provider).toMatchObject({
    docsPath: "/providers/groq",
    envVars: ["GROQ_API_KEY"],
    id: "groq",
    label: "Groq",
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "Groq API key",
        starterModel: `groq/${manifest.modelCatalog.providers.groq.defaultModel}`,
        wizard: { choiceId: "groq-api-key", groupId: "groq" },
      },
    ],
  });
  expect(captured.modelCatalogProviders.map((entry) => entry.kinds)).toEqual([["text"]]);
  expect(captured.mediaUnderstandingProviders).toEqual([
    {
      autoPriority: { audio: 20 },
      capabilities: ["audio"],
      defaultModels: { audio: "whisper-large-v3-turbo" },
      id: "groq",
      transcribeAudio: expect.any(Function),
    },
  ]);
});
