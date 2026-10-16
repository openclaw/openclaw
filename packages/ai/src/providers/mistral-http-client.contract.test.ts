import { Mistral } from "@mistralai/mistralai";
import { HTTPClient } from "@mistralai/mistralai/lib/http";
import { Chat } from "@mistralai/mistralai/sdk/chat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { Model } from "../types.js";
import { streamMistral } from "./mistral.js";

describe("Mistral HTTPClient contract", () => {
  it("serializes TypeBox tool schemas through the SDK without modifying their owner", async () => {
    const parameters = Object.freeze(
      Type.Object({
        value: Object.freeze(Type.Optional(Type.String())),
        ["__proto__"]: Object.freeze(Type.String()),
      }),
    );
    Object.freeze(parameters.properties);
    const model: Model<"mistral-conversations"> = {
      id: "mistral-test",
      name: "Mistral Test",
      api: "mistral-conversations",
      provider: "mistral",
      baseUrl: "https://mistral.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    };
    let body: unknown;
    const host = getAiTransportHost();
    configureAiTransportHost({
      ...host,
      buildModelFetch: () => async (input, init) => {
        body = await new Request(input, init).json();
        return new Response(
          `data: ${JSON.stringify({
            id: "response-fixture",
            model: model.id,
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const output = await streamMistral(
        model,
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [{ name: "read", description: "Read a value", parameters }],
        },
        {
          apiKey: "fixture-key",
          onPayload: (payload) => {
            const request = payload as {
              tools: [
                {
                  function: {
                    parameters: {
                      properties: { value: { type: string; description?: string } };
                    };
                  };
                },
              ];
            };
            request.tools[0].function.parameters.properties.value.description = "Hook description";
          },
        },
      ).result();
      expect(output).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
      expect(body).toHaveProperty("tools.0.function.parameters", {
        type: "object",
        properties: {
          value: { type: "string", description: "Hook description" },
          ["__proto__"]: { type: "string" },
        },
        required: ["__proto__"],
      });
    } finally {
      configureAiTransportHost(host);
    }
  });

  it.each([
    {
      name: "root client",
      createChat: (options: ConstructorParameters<typeof Chat>[0]) => new Mistral(options).chat,
    },
    {
      name: "chat subclient",
      createChat: (options: ConstructorParameters<typeof Chat>[0]) => new Chat(options),
    },
  ])("routes $name responses through the injected HTTPClient hooks", async ({ createChat }) => {
    const response = new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetcher = vi.fn(async () => response);
    const onResponse = vi.fn();
    const httpClient = new HTTPClient({ fetcher });
    httpClient.addHook("response", onResponse);
    const chat = createChat({
      apiKey: "test-key",
      serverURL: "https://mistral.invalid",
      httpClient,
    });

    const stream = await chat.stream({
      model: "mistral-test",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(onResponse).toHaveBeenCalledWith(response, expect.any(Request));
    await stream.cancel("test complete");
  });
});
