import OpenAI from "openai";
import { expect, it, vi } from "vitest";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";
import {
  createResponsesAssistantOutput,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";

const model = makeOpenAIProviderModel("openai-responses");

it.each(
  (["http", "error", "nested-error", "response.failed"] as const).flatMap((failureShape) =>
    ["misalignment_policy_violation", "invalid_prompt"].map((code) => ({ failureShape, code })),
  ),
)(
  "classifies API-key $code on $failureShape without enabling continuation",
  async ({ failureShape, code }) => {
    const error = {
      code,
      type: "invalid_request_error",
      message: "The provider paused this request.",
      misalignment: {
        error_type: "future_category",
        detailed_explanation: "The proposed action differs from the requested task.",
        steer: { message: "Continue only the requested task." },
      },
    };
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const event =
        failureShape === "response.failed"
          ? {
              type: "response.failed",
              response: { id: "resp_refused", status: "failed", error },
            }
          : failureShape === "nested-error"
            ? { type: "error", error }
            : { ...error, type: "error" };
      const http = failureShape === "http";
      return new Response(http ? JSON.stringify({ error }) : `data: ${JSON.stringify(event)}\n\n`, {
        status: http ? 403 : 200,
        headers: { "content-type": http ? "application/json" : "text/event-stream" },
      });
    });
    const client = new OpenAI({ apiKey: "test", fetch: fetchMock, maxRetries: 0 });
    const output = createResponsesAssistantOutput(model);
    await runResponsesStreamLifecycle({
      stream: new AssistantMessageEventStream(),
      model,
      output,
      createClient: () => client,
      buildParams: () => ({ model: model.id, input: [], stream: true }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ api: "openai-responses", stopReason: "error", errorCode: code });
    if (code !== "misalignment_policy_violation") {
      expect(output.diagnostics?.some((entry) => entry.type === "provider_refusal")).not.toBe(true);
      return;
    }
    const { detailed_explanation: explanation, error_type: errorType } = error.misalignment;
    expect(output.diagnostics).toEqual([
      {
        type: "provider_refusal",
        timestamp: expect.any(Number),
        details: {
          provider: "openai",
          category: "misalignment",
          review: { explanation, errorType },
        },
      },
    ]);
  },
);
