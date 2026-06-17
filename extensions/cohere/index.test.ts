import { readFileSync } from "node:fs";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildCohereProvider } from "./provider-catalog.js";
import { createCohereCompletionsWrapper } from "./stream.js";

function readManifest() {
  return JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8")) as {
    providerAuthChoices?: Array<{ choiceId?: string; optionKey?: string; cliFlag?: string }>;
    setup?: { providers?: Array<{ id?: string; envVars?: string[] }> };
  };
}

function requireCohereModel(): Model<"openai-completions"> {
  const model = buildCohereProvider().models?.[0];
  if (!model) {
    throw new Error("Cohere catalog did not provide a model");
  }
  return model as Model<"openai-completions">;
}

function captureCoherePayload(context: Context): Record<string, unknown> {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (model, streamContext, options) => {
    const payload = buildOpenAICompletionsParams(
      model as Model<"openai-completions">,
      streamContext,
      { maxTokens: 2048 } as never,
    );
    options?.onPayload?.(payload, model);
    return {} as ReturnType<StreamFn>;
  };

  const wrappedStreamFn = createCohereCompletionsWrapper(baseStreamFn);
  if (!wrappedStreamFn) {
    throw new Error("Cohere wrapper did not return a stream function");
  }
  void wrappedStreamFn(requireCohereModel(), context, {
    onPayload: (payload) => {
      captured = payload as Record<string, unknown>;
    },
  });
  if (!captured) {
    throw new Error("Cohere payload was not captured");
  }
  return captured;
}

describe("Cohere provider plugin", () => {
  it("registers the manifest-owned API key onboarding flow", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.auth.map((method) => method.wizard?.choiceId)).toEqual(["cohere-api-key"]);
    expect(provider).toMatchObject({
      id: "cohere",
      envVars: ["COHERE_API_KEY"],
    });
    expect(provider.auth[0]).toMatchObject({
      id: "api-key",
      kind: "api_key",
      wizard: { choiceId: "cohere-api-key" },
    });
    expect(readManifest().providerAuthChoices).toEqual([
      expect.objectContaining({
        choiceId: "cohere-api-key",
        optionKey: "cohereApiKey",
        cliFlag: "--cohere-api-key",
      }),
    ]);
    expect(readManifest().setup?.providers).toEqual([
      { id: "cohere", envVars: ["COHERE_API_KEY"] },
    ]);
  });

  it("exposes the static Cohere catalog", () => {
    expect(buildCohereProvider()).toMatchObject({
      baseUrl: "https://api.cohere.ai/compatibility/v1",
      api: "openai-completions",
      models: [
        expect.objectContaining({
          id: "command-a-03-2025",
          compat: {
            supportsStore: false,
            supportsUsageInStreaming: false,
            maxTokensField: "max_tokens",
          },
        }),
      ],
    });
  });

  it("uses Cohere's OpenAI-compatible completions payload fields", () => {
    const params = captureCoherePayload({
      systemPrompt: "system",
      messages: [],
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as Context);

    expect(params.max_tokens).toBe(2048);
    expect(params).not.toHaveProperty("max_completion_tokens");
    expect(params).not.toHaveProperty("store");
    expect(params).not.toHaveProperty("stream_options");
    expect(params).not.toHaveProperty("tool_choice");
    expect(params.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "developer", content: "system" })]),
    );
    expect(params.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system", content: "system" })]),
    );
  });
});
