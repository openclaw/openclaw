// Requesty tests cover requesty plugin live behavior.
import OpenAI from "openai";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { REQUESTY_BASE_URL } from "./provider-catalog.js";

const REQUESTY_API_KEY = process.env.REQUESTY_API_KEY ?? "";
const LIVE_MODEL_REF =
  process.env.OPENCLAW_LIVE_REQUESTY_PLUGIN_MODEL?.trim() || "requesty/openai/gpt-4o-mini";
const LIVE_MODEL_ID = LIVE_MODEL_REF.startsWith("requesty/")
  ? LIVE_MODEL_REF
  : `requesty/${LIVE_MODEL_REF}`;
const liveEnabled = REQUESTY_API_KEY.trim().length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = liveEnabled ? describe : describe.skip;
const ModelRegistryCtor = ModelRegistry as unknown as {
  new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
};

async function registerRequestyPlugin() {
  return registerProviderPlugin({
    plugin,
    id: "requesty",
    name: "Requesty Provider",
  });
}

async function expectWeatherToolCall(client: OpenAI, model: string): Promise<void> {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Call get_weather for Paris." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "get_weather" } },
    max_tokens: 64,
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.find(
    (call) => call.type === "function",
  );
  expect(toolCall?.type).toBe("function");
  expect(toolCall?.function.name).toBe("get_weather");
  expect(JSON.parse(toolCall?.function.arguments ?? "{}")).toMatchObject({ city: "Paris" });
}

describeLive("requesty plugin live", () => {
  it("resolves a router model and completes a live tool call", async () => {
    const { providers } = await registerRequestyPlugin();
    const provider = requireRegisteredProvider(providers, "requesty");

    const resolved = provider.resolveDynamicModel?.({
      provider: "requesty",
      modelId: LIVE_MODEL_ID,
      modelRegistry: new ModelRegistryCtor(AuthStorage.inMemory()),
    });
    if (!resolved) {
      throw new Error(`requesty provider did not resolve ${LIVE_MODEL_ID}`);
    }

    expect(resolved.provider).toBe("requesty");
    expect(resolved.api).toBe("openai-completions");
    expect(resolved.baseUrl).toBe(REQUESTY_BASE_URL);

    const client = new OpenAI({
      apiKey: REQUESTY_API_KEY,
      baseURL: resolved.baseUrl,
    });
    await expectWeatherToolCall(client, LIVE_MODEL_ID.replace(/^requesty\//, ""));
  }, 30_000);
});
