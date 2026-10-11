import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import OpenAI from "openai";
import type { ResponseError, ResponseErrorEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { createResponsesStreamWithRecovery } from "./openai-responses-replay-internal.js";
import { nextResponsesServiceTier } from "./openai-responses-service-tier.js";

const model: Model<"openai-responses"> = {
  id: "fixture-model",
  name: "Fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 100,
};
const rejection = {
  type: "invalid_request_error",
  code: null,
  param: "service_tier",
  message: "Invalid service_tier argument",
};
function sse(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
const complete = {
  type: "response.completed",
  response: { id: "resp_ok", status: "completed", output: [] },
};
async function fixture(
  respond: (attempt: number) => Response,
  opts: { signal?: AbortSignal; native?: boolean; hookError?: Error; onRejected?: () => void } = {},
) {
  const bodies: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    maxRetries: 0,
    organization: null,
    project: null,
    fetch: async (_url, init) => {
      const body: unknown = await new Response(init?.body).json();
      if (!isRecord(body)) {
        throw new Error("Expected an encoded request object");
      }
      bodies.push(body);
      return respond(bodies.length);
    },
  });
  const hookError = opts.hookError;
  const stream = await createResponsesStreamWithRecovery({
    client,
    model: opts.native === false ? { ...model, baseUrl: "https://proxy.example/v1" } : model,
    request: {
      model: model.id,
      stream: true,
      service_tier: "ultrafast",
      input: [{ role: "user", content: "Hello" }],
    },
    requestOptions: { signal: opts.signal },
    canRetryStream: () => true,
    onServiceTierRejected: (tier) => {
      rejected.push(tier);
      opts.onRejected?.();
    },
    ...(hookError
      ? {
          wrapStream: () => ({
            [Symbol.asyncIterator]() {
              return { next: () => Promise.reject(hookError) };
            },
          }),
        }
      : {}),
  });
  const events: unknown[] = [];
  let error: unknown;
  try {
    for await (const event of stream.stream) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  return { bodies, rejected, events, error };
}

describe("Responses service-tier recovery", () => {
  it("recovers HTTP and streamed tier rejections without changing input", async () => {
    const result = await fixture((attempt) =>
      attempt === 1
        ? Response.json({ error: rejection }, { status: 400 })
        : attempt === 2
          ? sse([
              { type: "response.created", response: { id: "resp_rejected", output: [] } },
              { type: "response.failed", response: { error: rejection, output: [] } },
            ])
          : sse([complete]),
    );
    expect(result.error).toBeUndefined();
    expect(result.bodies.map((body) => body.service_tier)).toEqual([
      "ultrafast",
      "priority",
      "default",
    ]);
    expect(result.rejected).toEqual(["ultrafast", "priority"]);
    for (const body of result.bodies) {
      expect(body.input).toEqual([{ role: "user", content: "Hello" }]);
    }
    expect(result.events).toEqual([
      { type: "response.created", response: { id: "resp_rejected", output: [] } },
      complete,
    ]);
  });

  it.each(["failed", "flat"] as const)("recovers the SDK %s error contract", async (shape) => {
    const failed: ResponseError = { code: "invalid_prompt", message: rejection.message };
    const flat: ResponseErrorEvent = {
      type: "error",
      code: null,
      param: "service_tier",
      message: rejection.message,
      sequence_number: 1,
    };
    const result = await fixture((attempt) =>
      sse([
        attempt > 1
          ? complete
          : shape === "flat"
            ? flat
            : { type: "response.failed", response: { error: failed, output: [] } },
      ]),
    );
    expect(result.error).toBeUndefined();
    expect(result.bodies.map((body) => body.service_tier)).toEqual(["ultrafast", "priority"]);
    expect(result.rejected).toEqual(["ultrafast"]);
  });

  it("recovers a native SDK error event and stops after Standard", async () => {
    const result = await fixture(() => sse([{ type: "error", error: rejection }]));
    expect(result.error).toBeDefined();
    expect(result.bodies.map((body) => body.service_tier)).toEqual([
      "ultrafast",
      "priority",
      "default",
    ]);
    expect(result.rejected).toEqual(["ultrafast", "priority"]);
  });

  it("does not send a retry after cancellation during rejection observation", async () => {
    const controller = new AbortController();
    const result = await fixture(
      () => sse([{ type: "response.failed", response: { error: rejection, output: [] } }]),
      {
        signal: controller.signal,
        onRejected: () => controller.abort(),
      },
    );
    expect(result.bodies).toHaveLength(1);
    expect(result.error).toBeDefined();
  });

  it("leaves custom endpoint policy unchanged", async () => {
    const result = await fixture(
      () => sse([{ type: "response.failed", response: { error: rejection, output: [] } }]),
      { native: false },
    );
    expect(result.bodies).toHaveLength(1);
  });

  it.each([{ status: 503, error: rejection }])(
    "does not replay unrelated failures: %j",
    (error) => {
      expect(nextResponsesServiceTier("ultrafast", error)).toBeUndefined();
    },
  );
});
