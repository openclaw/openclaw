import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bedrockModel, mockStream } from "./bedrock.test-support.js";
import amazonBedrockPlugin from "./index.js";

describe("registered Bedrock Converse sampling", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { id: "us.xai.grok-4.6", temperature: undefined },
    { id: "global.xai.grok-4.6", temperature: undefined },
    { id: "amazon.nova-micro-v1:0", temperature: 0.2 },
    { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", temperature: 0.2 },
    { id: "us.xai.grok-4", temperature: 0.2 },
    { id: "us.xai.grok-4.6-unconfirmed", temperature: 0.2 },
  ])("emits supported inferenceConfig for $id", async ({ id, temperature }) => {
    // Intercept the real SDK command, not a substitute stream or a live AWS call.
    const send = mockStream();
    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);
    const model = bedrockModel({ id, reasoning: false });
    const streamContext = {
      provider: model.provider,
      modelId: model.id,
      model,
      config: {},
    };
    const registeredStream = provider.createStreamFn?.(streamContext);
    if (!registeredStream) {
      throw new Error("Bedrock did not register a Converse stream");
    }
    const stream =
      provider.wrapStreamFn?.({ ...streamContext, streamFn: registeredStream }) ?? registeredStream;
    const events = await stream(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
      { temperature: 0.2, maxTokens: 123, cacheRetention: "none" },
    );
    const result = await events.result();

    expect(result.stopReason).not.toBe("error");
    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]?.[0];
    if (!(command instanceof ConverseStreamCommand)) {
      throw new Error("Bedrock did not emit a ConverseStreamCommand");
    }
    expect(command.input.modelId).toBe(id);
    expect(command.input.inferenceConfig).toStrictEqual({
      maxTokens: 123,
      ...(temperature === undefined ? {} : { temperature }),
    });
  });
});
