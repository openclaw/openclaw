import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import amazonBedrockPlugin from "./index.js";

describe("amazon-bedrock provider plugin", () => {
  it("marks Claude 4.6 Bedrock models as adaptive by default", () => {
    const provider = registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(
      provider.resolveDefaultThinkingLevel?.({
        provider: "amazon-bedrock",
        modelId: "us.anthropic.claude-opus-4-6-v1",
      } as never),
    ).toBe("adaptive");
    expect(
      provider.resolveDefaultThinkingLevel?.({
        provider: "amazon-bedrock",
        modelId: "amazon.nova-micro-v1:0",
      } as never),
    ).toBeUndefined();
  });

  it("disables prompt caching for non-Anthropic Bedrock models", () => {
    const provider = registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "amazon.nova-micro-v1:0",
      streamFn: (_model: unknown, _context: unknown, options: Record<string, unknown>) => options,
    } as never);

    expect(
      wrapped?.(
        {
          api: "openai-completions",
          provider: "amazon-bedrock",
          id: "amazon.nova-micro-v1:0",
        } as never,
        { messages: [] } as never,
        {},
      ),
    ).toMatchObject({
      cacheRetention: "none",
    });
  });
});
