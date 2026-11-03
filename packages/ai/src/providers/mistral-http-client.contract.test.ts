import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamMistral } from "./mistral.js";
import { makeProviderModel } from "./provider-model.test-support.js";
import { publishRuntimeToolInputSchema } from "./tool-schema-json-projection.js";

const sse = (data = "") =>
  new Response(`${data}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
const model = makeProviderModel("mistral-conversations", "mistral", "mistral-test", {
  baseUrl: "https://mistral.invalid",
});
let host: ReturnType<typeof getAiTransportHost>;
beforeEach(() => {
  host = getAiTransportHost();
});
afterEach(() => {
  vi.restoreAllMocks();
  configureAiTransportHost(host);
});
function captureRequest(response = sse()) {
  const requests: Request[] = [];
  configureAiTransportHost({
    ...host,
    buildModelFetch: () => async (input, init) => {
      requests.push(new Request(input, init));
      return response;
    },
  });
  return requests;
}

describe("Mistral HTTPClient contract", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])("isolates SDK schemas (published=%s, payload hook=%s)", async (published, hook) => {
    const source = Object.freeze(
      Type.Object({
        value: Object.freeze(Type.Optional(Type.String())),
        ["__proto__"]: Object.freeze(Type.String()),
      }),
    );
    Object.freeze(source.properties);
    const parameters = published ? publishRuntimeToolInputSchema(source).schema : source;
    assert(isRecord(parameters));
    const clone = vi.spyOn(globalThis, "structuredClone");
    const onResponse = vi.fn();
    const requests = captureRequest(
      sse(
        `data: ${JSON.stringify({
          id: "response-fixture",
          model: model.id,
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\n`,
      ),
    );
    const output = await streamMistral(
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [{ name: "read", description: "Read a value", parameters }],
      },
      {
        apiKey: "fixture-key",
        onResponse,
        onPayload: hook
          ? (payload) => {
              type Schema = { properties: { value: { type: string; description?: string } } };
              const request = payload as { tools: [{ function: { parameters: Schema } }] };
              request.tools[0].function.parameters.properties.value.description =
                "Hook description";
            }
          : undefined,
      },
    ).result();
    expect(output).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "ok" }] });
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ provider: "mistral" }),
    );
    expect(await requests[0]?.json()).toHaveProperty("tools.0.function.parameters", {
      type: "object",
      properties: {
        value: { type: "string", ...(hook ? { description: "Hook description" } : {}) },
        ["__proto__"]: { type: "string" },
      },
      required: ["__proto__"],
    });
    expect(parameters).not.toHaveProperty("properties.value.description");
    expect(clone.mock.calls.filter(([value]) => value === parameters)).toHaveLength(
      published && !hook ? 0 : 1,
    );
  });

  it("omits a deleted model header from the outbound request", async () => {
    const headerModel = {
      ...model,
      headers: { "X-Model-Header": "original", "x-retained": "retained" },
    };
    const requests = captureRequest();
    await streamMistral(
      headerModel,
      { messages: [] },
      {
        apiKey: "fixture-key",
        headers: { "x-model-header": null },
      },
    ).result();
    expect(requests[0]?.headers.has("x-model-header")).toBe(false);
    expect(requests[0]?.headers.get("x-retained")).toBe("retained");
    expect(headerModel.headers["X-Model-Header"]).toBe("original");
  });
});
