import { describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-wizard.js";
import { registerSingleProviderPlugin } from "../../test/helpers/extensions/plugin-registration.js";
import plamoPlugin from "./index.js";

type FakeWrappedStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: {
  events: unknown[];
  resultMessage: unknown;
}): FakeWrappedStream {
  return {
    async result() {
      return params.resultMessage;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (const event of params.events) {
          yield event;
        }
      })();
    },
  };
}

describe("plamo provider plugin", () => {
  it("registers PLaMo with api-key auth wizard metadata", () => {
    const provider = registerSingleProviderPlugin(plamoPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "plamo-api-key",
    });

    expect(provider.id).toBe("plamo");
    expect(provider.label).toBe("PLaMo");
    expect(provider.envVars).toEqual(["PLAMO_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("plamo");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static PLaMo model catalog", async () => {
    const provider = registerSingleProviderPlugin(plamoPlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.platform.preferredai.jp/v1");
    expect(catalog.provider.models).toMatchObject([
      {
        id: "plamo-3.0-prime-beta",
        cost: { input: 0.375, output: 1.5625, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 16_384,
      },
    ]);
  });

  it("normalizes inline PLaMo tool markup into tool calls", async () => {
    const provider = registerSingleProviderPlugin(plamoPlugin);
    const toolMarkup =
      "<|plamo:begin_tool_requests:plamo|>" +
      "<|plamo:begin_tool_request:plamo|>" +
      "<|plamo:begin_tool_name:plamo|>read<|plamo:end_tool_name:plamo|>" +
      '<|plamo:begin_tool_arguments:plamo|><|plamo:msg|>{"path":"README.md"}' +
      "<|plamo:end_tool_arguments:plamo|>" +
      "<|plamo:end_tool_request:plamo|>" +
      "<|plamo:end_tool_requests:plamo|>";
    const partialMessage = {
      role: "assistant",
      content: [{ type: "text", text: `Checking...${toolMarkup}` }],
    };
    const streamedMessage = {
      role: "assistant",
      content: [{ type: "text", text: `Reading now.${toolMarkup}` }],
    };
    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: `I will inspect the file.\n${toolMarkup}` }],
    };

    const baseFn = vi.fn(() =>
      createFakeStream({
        events: [{ partial: partialMessage, message: streamedMessage }],
        resultMessage: finalMessage,
      }),
    );

    const wrapped = provider.wrapStreamFn?.({
      provider: "plamo",
      modelId: "plamo-3.0-prime-beta",
      streamFn: baseFn as never,
      extraParams: {},
    } as never);
    if (!wrapped) {
      throw new Error("expected wrapped stream function");
    }

    const stream = await Promise.resolve(
      wrapped(
        {
          api: "openai-completions",
          provider: "plamo",
          id: "plamo-3.0-prime-beta",
        } as never,
        { messages: [] } as never,
        {} as never,
      ),
    );

    for await (const _event of stream) {
      // Drain the wrapped stream so live partial mutations run.
    }
    const result = await stream.result();

    expect(baseFn).toHaveBeenCalledTimes(1);
    expect(partialMessage.content).toMatchObject([
      { type: "text", text: "Checking..." },
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(streamedMessage.content).toMatchObject([
      { type: "text", text: "Reading now." },
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(finalMessage.content).toMatchObject([
      { type: "text", text: "I will inspect the file." },
      { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(finalMessage).toMatchObject({ stopReason: "toolUse" });
    expect(result).toBe(finalMessage);
  });
});
