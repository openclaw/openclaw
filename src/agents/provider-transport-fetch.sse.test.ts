import { describe, expect, it, vi } from "vitest";
import { prepareModelRequestBody } from "../../packages/ai/src/transports/model-request-body.js";
import {
  buildGuardedModelFetch,
  fetchWithSsrFGuardMock,
  installProviderTransportFetchTestHooks,
} from "./provider-transport-fetch.test-harness.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture<"openai-completions">({
  id: "fixture-model",
  provider: "openrouter",
  api: "openai-completions",
  baseUrl: "https://openrouter.ai/api/v1",
});
const url = `${model.baseUrl}/chat/completions`;

function respond(chunks: string[], contentType?: string) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({
    response: new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      }),
      { headers: contentType ? { "content-type": contentType } : undefined },
    ),
    finalUrl: url,
    release,
  });
  return release;
}

describe("buildGuardedModelFetch SSE readability", () => {
  installProviderTransportFetchTestHooks();

  it.each(["prepared HTML", "untyped HTML"])(
    "rejects %s instead of returning a successful stream",
    async (mode) => {
      const release = respond(
        ["<html>not the API</html>"],
        mode === "prepared HTML" ? "text/html" : undefined,
      );
      const body =
        mode === "prepared HTML"
          ? (await prepareModelRequestBody(undefined)({ model: model.id, stream: true })).body
          : '{"stream":true}';
      await expect(
        buildGuardedModelFetch(model)(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      ).rejects.toMatchObject({
        name: "ProviderHttpError",
        status: 200,
        code: "invalid_provider_content_type",
        errorType: "invalid_response",
        message: expect.stringMatching(/baseUrl.*\/v1 path prefix/),
      });
      expect(release).toHaveBeenCalled();
    },
  );

  it("leaves official OpenAI event-only frames untouched", async () => {
    const body = 'event: response.created\n\ndata: {"ok": true}\n\n';
    respond([body], "text/event-stream");
    const target = { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" };
    const response = await buildGuardedModelFetch(target)(
      new Request(`${target.baseUrl}/responses`, {
        method: "POST",
      }),
    );
    await expect(response.text()).resolves.toBe(body);
  });

  it("preserves mixed chunked framing and multiline data while dropping blank keepalives", async () => {
    respond(
      [
        "event: ping\ndata\ndata:\ndata: \t\uFEFF\u00A0\n\nData: ignored\n data: ignored\ndatabase: ignored\n\n",
        'data: {"ok"',
        ": true}\n",
        "\n",
        "event: ping\r",
        "\rdata: \u0085\r",
        "\rdata: \u200B\r\r",
        'data:\r\ndata: {\r\ndata: "ok": true}\r\ndata: \t\r',
        "\n\r",
        "\n",
        "event: ping\ndata\ndata: \t\uFEFF\u00A0",
      ],
      "text/event-stream",
    );
    const response = await buildGuardedModelFetch(model)(url, { method: "POST" });
    await expect(response.text()).resolves.toBe(
      'data: {"ok": true}\n\ndata: \u0085\r\rdata: \u200B\r\r' +
        'data:\r\ndata: {\r\ndata: "ok": true}\r\ndata: \t\r\n\r\n',
    );
  });

  it("preserves a readable EOF tail ending with a blank data line", async () => {
    const body = 'data: {"ok": true}\ndata: \t';
    respond([body], "text/event-stream");
    await expect((await buildGuardedModelFetch(model)(url)).text()).resolves.toBe(body);
  });
});
