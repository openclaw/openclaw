import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import {
  createResponsesAssistantOutput,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

describe("OpenAI Responses provider refusals", () => {
  it.each(
    (["http", "error", "nested-error", "response.failed"] as const).flatMap((failureShape) =>
      ["misalignment_policy_violation", "invalid_prompt"].map((code) => ({ failureShape, code })),
    ),
  )(
    "classifies API-key $code findings on $failureShape without enabling continuation",
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
        if (failureShape === "http") {
          return new Response(JSON.stringify({ error }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        const event =
          failureShape === "response.failed"
            ? {
                type: "response.failed",
                response: { id: "resp_refused", status: "failed", error },
              }
            : failureShape === "nested-error"
              ? { type: "error", error }
              : { ...error, type: "error" };
        return new Response(`data: ${JSON.stringify(event)}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });
      const client = new OpenAI({ apiKey: "test", fetch: fetchMock, maxRetries: 0 });
      const output = createResponsesAssistantOutput(nativeOpenAIModel);
      const stream = new AssistantMessageEventStream();
      await runResponsesStreamLifecycle({
        stream,
        model: nativeOpenAIModel,
        output,
        createClient: () => client,
        buildParams: () => ({ model: nativeOpenAIModel.id, input: [], stream: true }),
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(output).toMatchObject({
        api: "openai-responses",
        stopReason: "error",
        errorCode: error.code,
      });
      if (code !== "misalignment_policy_violation") {
        expect(output.diagnostics?.some((entry) => entry.type === "provider_refusal")).not.toBe(
          true,
        );
        return;
      }
      expect(output.diagnostics).toEqual([
        {
          type: "provider_refusal",
          timestamp: expect.any(Number),
          details: {
            provider: "openai",
            category: "misalignment",
            review: {
              explanation: error.misalignment.detailed_explanation,
              errorType: error.misalignment.error_type,
            },
          },
        },
      ]);
    },
  );
});
