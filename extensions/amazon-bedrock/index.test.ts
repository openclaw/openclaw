import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/extensions/plugin-registration.js";
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

  it("enables prompt caching for Application Inference Profile ARNs with Claude model name", () => {
    const provider = registerSingleProviderPlugin(amazonBedrockPlugin);
    const baseFn = (_model: never, _context: never, options: Record<string, unknown>) => options;
    const arn =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
    const result = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: arn,
      config: {
        models: {
          providers: {
            "amazon-bedrock": {
              models: [{ id: arn, name: "Claude Sonnet 4.6 via Inference Profile" }],
            },
          },
        },
      },
      streamFn: baseFn,
    } as never);

    // Should return the original streamFn (no no-cache wrapper)
    expect(result).toBe(baseFn);
  });

  it("disables prompt caching for non-Anthropic Bedrock models", () => {
    const provider = registerSingleProviderPlugin(amazonBedrockPlugin);
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId: "amazon.nova-micro-v1:0",
      streamFn: (_model, _context, options) => options,
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
