import { readFileSync } from "node:fs";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import amazonBedrockPlugin from "./index.js";

const MODEL_ID = "amazon.nova-sonic-v1:0";
let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;

beforeAll(async () => {
  provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
});

describe("Bedrock custom provider routing", () => {
  it("declares matching metadata and runtime ownership for its stream API", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    );
    expect(provider.hookAliases).toContain("bedrock-converse-stream");
    expect(manifest.providerAuthAliases["bedrock-converse-stream"]).toBe(provider.id);
    expect(
      provider.createStreamFn?.({ model: { api: "bedrock-converse-stream" } } as never),
    ).toBeTypeOf("function");
  });

  it.each([
    { selectedProvider: "amazon-bedrock-east1", expectedRegion: "us-east-1" },
    { selectedProvider: "Amazon-Bedrock-East1", expectedRegion: "us-east-1" },
    { selectedProvider: "amazon-bedrock", expectedRegion: "us-east-2" },
    { selectedProvider: "unconfigured-bedrock", expectedRegion: "us-east-1" },
  ])(
    "uses the selected provider region for $selectedProvider",
    ({ selectedProvider, expectedRegion }) => {
      const model = {
        api: "bedrock-converse-stream",
        provider: selectedProvider,
        id: MODEL_ID,
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      };
      const wrapped = provider.wrapStreamFn?.({
        provider: selectedProvider,
        modelId: MODEL_ID,
        model,
        config: {
          models: {
            providers: {
              "amazon-bedrock": {
                api: "bedrock-converse-stream",
                baseUrl: "https://bedrock-runtime.us-east-2.amazonaws.com",
                models: [],
              },
              "amazon-bedrock-east1": {
                api: "bedrock-converse-stream",
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [],
              },
            },
          },
        },
        streamFn: (_model: unknown, _context: unknown, options: Record<string, unknown>) => options,
      } as never);
      const result = wrapped?.(model as never, { messages: [] } as never, {});
      expect(result).toMatchObject({ region: expectedRegion });
    },
  );
});
