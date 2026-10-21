import { Mistral } from "@mistralai/mistralai";
import { HTTPClient } from "@mistralai/mistralai/lib/http";
import { Chat } from "@mistralai/mistralai/sdk/chat";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamMistral } from "./mistral.js";
import { makeProviderModel } from "./provider-model.test-support.js";

type ClientOptions = ConstructorParameters<typeof Chat>[0];
const sse = (data = "") =>
  new Response(`${data}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

describe("Mistral HTTPClient contract", () => {
  it("serializes TypeBox tool schemas through the SDK without modifying their owner", async () => {
    const parameters = Object.freeze(
      Type.Object({
        value: Object.freeze(Type.Optional(Type.String())),
        ["__proto__"]: Object.freeze(Type.String()),
      }),
    );
    Object.freeze(parameters.properties);
    const model = makeProviderModel("mistral-conversations", "mistral", "mistral-test", {
      baseUrl: "https://mistral.invalid",
    });
    let body: unknown;
    const host = getAiTransportHost();
    configureAiTransportHost({
      ...host,
      buildModelFetch: () => async (input, init) => {
        body = await new Request(input, init).json();
        return sse(
          `data: ${JSON.stringify({
            id: "response-fixture",
            model: model.id,
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          })}\n\n`,
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
            type Schema = { properties: { value: { type: string; description?: string } } };
            const request = payload as { tools: [{ function: { parameters: Schema } }] };
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
    ["root", (options: ClientOptions) => new Mistral(options).chat],
    ["chat", (options: ClientOptions) => new Chat(options)],
  ] as const)("routes %s client responses through HTTPClient hooks", async (_name, createChat) => {
    const response = sse();
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
