import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { attachModelProviderRequestTransport } from "../../src/agents/provider-request-config.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plamoPlugin from "./index.js";

async function loadPlamoCatalog() {
  const provider = await registerSingleProviderPlugin(plamoPlugin);
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

  if (!catalog || !("provider" in catalog)) {
    throw new Error("expected single-provider catalog");
  }

  return { provider, catalog };
}

describe("plamo native transport request policy", () => {
  it("honors model allowPrivateNetwork overrides on the native stream path", async () => {
    const { provider, catalog } = await loadPlamoCatalog();

    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-allow-private-network",
          choices: [{ index: 0, delta: { content: "ok" } }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-allow-private-network",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected tcp server address");
    }

    const [model] = catalog.provider.models;
    const wrapped = provider.createStreamFn?.({
      config: {},
      provider: "plamo",
      modelId: model.id,
      model: {
        api: "openai-completions",
        provider: "plamo",
        id: model.id,
      } as never,
    } as never);
    if (!wrapped) {
      server.close();
      throw new Error("expected wrapped stream function");
    }

    const stream = await wrapped(
      attachModelProviderRequestTransport(
        {
          ...model,
          provider: "plamo",
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
        { allowPrivateNetwork: true },
      ) as never,
      {
        systemPrompt: "system prompt",
        messages: [{ role: "user", content: "こんにちは" }],
      } as never,
      {
        apiKey: "test-key",
      } as never,
    );

    let result: Awaited<ReturnType<typeof stream.result>> | undefined;
    try {
      for await (const _event of stream) {
        // Drain the stream so the final message is assembled.
      }
      result = await stream.result();
    } finally {
      server.close();
    }

    expect(result).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "ok" }],
    });
  });
});
