import OpenAI from "openai";
import type { ResponseError, ResponseErrorEvent } from "openai/resources/responses/responses.js";
import { expect, it } from "vitest";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import {
  requestBody,
  sseResponse as sse,
} from "./openai-responses-prompt-observer.test-support.js";
import { createResponsesStreamWithRecovery } from "./openai-responses-replay-internal.js";
import { nextResponsesServiceTier as nextTier } from "./openai-responses-service-tier.js";
import { completedResponse } from "./openai-stream-cases.test-support.js";

const model = makeProviderModel("openai-responses", "openai", "fixture-model", {
  baseUrl: "https://api.openai.com/v1",
});
const rejection = {
  type: "invalid_request_error",
  code: null,
  param: "service_tier",
  message: "Invalid service_tier argument",
};
const complete = completedResponse("resp_ok", []);
const created = { type: "response.created", response: { id: "resp_rejected", output: [] } };
async function fixture(
  respond: (attempt: number) => Response,
  opts: {
    signal?: AbortSignal;
    native?: boolean;
    onRejected?: () => void;
    wrapStream?: Parameters<typeof createResponsesStreamWithRecovery>[0]["wrapStream"];
  } = {},
) {
  const bodies: Record<string, unknown>[] = [];
  const rejected: string[] = [];
  const client = new OpenAI({
    apiKey: "synthetic-key",
    maxRetries: 0,
    organization: null,
    project: null,
    fetch: async (_url, init) => {
      bodies.push(await requestBody(init));
      return respond(bodies.length);
    },
  });
  const request = {
    model: model.id,
    stream: true,
    service_tier: "ultrafast",
    input: [{ role: "user", content: "Hello" }],
  } satisfies Parameters<typeof createResponsesStreamWithRecovery>[0]["request"];
  const stream = await createResponsesStreamWithRecovery({
    client,
    model: opts.native === false ? { ...model, baseUrl: "https://proxy.example/v1" } : model,
    request,
    buildFullHistoryRequest: () => request,
    requestOptions: { signal: opts.signal },
    canRetryStream: () => true,
    wrapStream: opts.wrapStream,
    onServiceTierRejected: (tier) => {
      rejected.push(tier);
      opts.onRejected?.();
    },
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
const failed = (error: unknown = rejection) => ({
  type: "response.failed",
  response: { error, output: [] },
});
function expectTiers(result: Awaited<ReturnType<typeof fixture>>, tiers: string[]) {
  expect(result.bodies.map((body) => body.service_tier)).toEqual(tiers);
  expect(result.rejected).toEqual(tiers.slice(0, -1));
}

it("recovers HTTP and streamed tier rejections without changing input", async () => {
  const result = await fixture((attempt) => {
    if (attempt === 1) {
      return Response.json({ error: rejection }, { status: 400 });
    }
    return sse(attempt === 2 ? [created, failed()] : [complete]);
  });
  expect(result.error).toBeUndefined();
  expectTiers(result, ["ultrafast", "priority", "default"]);
  for (const body of result.bodies) {
    expect(body.input).toEqual([{ role: "user", content: "Hello" }]);
  }
  expect(result.events).toEqual([created, complete]);
});

it.each([
  failed({ code: "invalid_prompt", message: rejection.message } satisfies ResponseError),
  {
    type: "error",
    code: null,
    param: "service_tier",
    message: rejection.message,
    sequence_number: 1,
  } satisfies ResponseErrorEvent,
])("recovers the SDK $type error contract", async (event) => {
  const result = await fixture((attempt) => sse([attempt > 1 ? complete : event]));
  expect(result.error).toBeUndefined();
  expectTiers(result, ["ultrafast", "priority"]);
});

it("recovers a native SDK error event and stops after Standard", async () => {
  const result = await fixture(() => sse([{ type: "error", error: rejection }]));
  expect(result.error).toBeDefined();
  expectTiers(result, ["ultrafast", "priority", "default"]);
});

it("does not classify a hook rejection as a provider tier rejection", async () => {
  const error = new OpenAI.APIError(400, rejection, rejection.message, new Headers());
  const result = await fixture(() => sse([complete]), {
    wrapStream: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
    }),
  });
  expect(result.error).toBe(error);
  expectTiers(result, ["ultrafast"]);
});

it("does not send a retry after cancellation during rejection observation", async () => {
  const controller = new AbortController();
  const result = await fixture(() => sse([failed()]), {
    signal: controller.signal,
    onRejected: () => controller.abort(),
  });
  expect(result.bodies).toHaveLength(1);
  expect(result.error).toBeDefined();
});

it("leaves custom endpoint policy unchanged", async () => {
  const result = await fixture(() => sse([failed()]), { native: false });
  expect(result.bodies).toHaveLength(1);
});

it("does not replay unrelated failures", () => {
  expect(nextTier("ultrafast", { status: 503, error: rejection })).toBeUndefined();
});
