import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  resolveOpenAIRequestReasoning,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-model-metadata";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { expect, it } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const catalog = buildManifestModelProviderConfig({
  providerId: "groq",
  catalog: manifest.modelCatalog.providers.groq,
});
type CatalogModel = (typeof catalog.models)[number];
const qwenEntry = catalog.models.find((model) => model.id === "qwen/qwen3.6-27b");
if (!qwenEntry) {
  throw new Error("Expected Groq Qwen catalog model");
}
const qwen = qwenEntry;
const enabledLevels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const context = { messages: [] };
function makeModel(row: Partial<CatalogModel> & { id: string }) {
  return {
    ...qwen,
    name: row.id,
    ...row,
    input: ["text"],
    provider: "groq",
    api: "openai-completions",
    baseUrl: catalog.baseUrl,
  } satisfies Model<"openai-completions">;
}
function completionStreams(model: Model<"openai-completions">, streamFn: StreamFn = streamSimple) {
  const [provider] = capturePluginRegistration(plugin).providers;
  return [provider?.wrapStreamFn, provider?.wrapSimpleCompletionStreamFn].map((wrap) => {
    const stream = wrap?.({ provider: "groq", modelId: model.id, model, streamFn });
    if (!stream) {
      throw new Error("Expected wrapped Groq stream");
    }
    return stream;
  });
}

it("requests parsed reasoning only for enabled Groq Qwen reasoning models", async () => {
  for (const [id, reasoning, effort, parsed] of [
    ["qwen/future-reasoner", true, "default", true],
    ["qwen/qwen3.6-27b", true, "none", false],
    ["qwen/future-text-model", false, "default", false],
    ["openai/gpt-oss-120b", true, "high", false],
  ] as const) {
    const model = makeModel({ id, reasoning });
    let payload = { reasoning_effort: effort };
    const streamFn: StreamFn = async (streamModel, _context, options) => {
      await options?.onPayload?.(payload, streamModel);
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    };
    for (const wrapped of completionStreams(model, streamFn)) {
      payload = { reasoning_effort: effort };
      await wrapped(model, context);
      expect(payload).toEqual({
        reasoning_effort: effort,
        ...(parsed ? { reasoning_format: "parsed" } : {}),
      });
    }
  }
});

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

it("maps every Qwen thinking level to Groq's binary wire contract on both completion paths", async () => {
  expect(qwen.input).toEqual(["text"]);
  expect(qwen.compat).toMatchObject({
    supportedReasoningEfforts: ["none", "default"],
    reasoningEffortMap: {
      off: "none",
      none: "none",
      ...Object.fromEntries(enabledLevels.map((level) => [level, "default"])),
      adaptive: "default",
    },
  });
  const model = makeModel(qwen);
  expect(
    ["none", "adaptive"].map((level) => resolveOpenAIRequestReasoning(model, level).effort),
  ).toEqual(["none", "default"]);
  expect(
    buildOpenAICompletionsParams(model, context, { reasoningEffort: "none" }).reasoning_effort,
  ).toBe("none");
  for (const streamFn of completionStreams(model)) {
    for (const reasoning of [undefined, "off", ...enabledLevels] as const) {
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
      expect(payload).toMatchObject({ reasoning_effort: enabled ? "default" : "none" });
      if (enabled) {
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
