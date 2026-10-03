import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import amazonBedrockPlugin from "./index.js";

vi.mock("@aws-sdk/client-bedrock", () => {
  class GetInferenceProfileCommand {
    constructor(readonly input: unknown) {}
  }
  class BedrockClient {
    send = vi.fn(async () => ({ models: [] }));
    destroy = vi.fn();
  }
  return { BedrockClient, GetInferenceProfileCommand };
});

describe("Amazon Bedrock registration cache policy", () => {
  it("does not inject an opaque-profile fallback checkpoint after a mixed-media shipped carrier", async () => {
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const modelId =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
    const model = { api: "openai-completions", provider: "amazon-bedrock", id: modelId } as never;
    const payload = {
      system: [{ text: "Stable workspace" }],
      messages: [
        {
          role: "user",
          content: [
            { text: "OpenClaw runtime context:\nTransient context" },
            { image: { format: "png" } },
          ],
        },
      ],
    };
    const wrapped = provider.wrapStreamFn?.({
      provider: "amazon-bedrock",
      modelId,
      model,
      streamFn: (_model: unknown, _context: unknown, options: Record<string, unknown>) => options,
    } as never);
    const result = wrapped?.(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "OpenClaw runtime context:\nTransient context" },
              { type: "image", mimeType: "image/png", data: "AA==" },
            ],
            timestamp: 0,
            runtimeContextCarrier: true,
          },
        ],
      } as never,
      { cacheRetention: "short" },
    ) as unknown as { onPayload?: (value: typeof payload, model: unknown) => Promise<void> };

    expect(result.onPayload).toBeTypeOf("function");
    await result.onPayload?.(payload, model);

    expect(payload.messages[0]?.content).toHaveLength(2);
  });
});
