// The managed Responses transport must surface the provider's terminal error
// fact (e.g. content_filter) instead of collapsing it into a generic message;
// the generic string is classified as a transient timeout by failover and
// triggers pointless model rotation.
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { isResponsesOutputLimitToolCallError } from "../providers/openai-responses-terminal-usage.js";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const sseState = vi.hoisted(() => ({
  outcomes: [] as Array<Error | SdkResponse>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: () => {
        const outcome = sseState.outcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: function UnexpectedResponsesWS() {
    throw new Error("terminal error tests must not construct a WebSocket");
  },
}));

import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";

const model = {
  id: "test-responses",
  name: "Test Responses",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

describe("managed Responses transport terminal errors", () => {
  it.each(
    ["incomplete", "in_progress", "malformed", "truncated"].flatMap((rejection) =>
      ["incomplete", "completed", "filtered", "failed", "eof", "aborted", "error"].map(
        (ending) => ({ rejection, ending }),
      ),
    ),
  )(
    "fences later tool completions after $rejection output until $ending",
    async ({ rejection, ending }) => {
      const controller = new AbortController();
      const calls = [0, 1].map((index) => ({
        type: "function_call",
        id: `fc_parallel_${index}`,
        call_id: `call_parallel_${index}`,
        name: "probe",
        arguments:
          index !== 0
            ? '{"token":"complete"}'
            : rejection === "malformed"
              ? '{"token":!}'
              : '{"token":"unfinished',
        status:
          index === 0 && (rejection === "incomplete" || rejection === "in_progress")
            ? rejection
            : "completed",
        async: true,
      }));
      sseState.outcomes.push({
        data: (async function* () {
          for (const [output_index, item] of calls.entries()) {
            yield {
              type: "response.output_item.added",
              output_index,
              item: { ...item, arguments: "", status: "in_progress" },
            };
          }
          for (const [output_index, item] of calls.entries()) {
            yield { type: "response.output_item.done", output_index, item };
          }
          if (ending === "error") {
            yield { type: "error", code: "server_error", message: "provider stream error" };
            return;
          }
          if (ending === "aborted") {
            controller.abort();
          }
          if (ending === "eof" || ending === "aborted") {
            return;
          }
          const status = ending === "filtered" ? "incomplete" : ending;
          yield {
            type: `response.${status}`,
            response: {
              id: "resp_parallel_truncated",
              model: "served-model",
              status,
              incomplete_details: {
                reason: ending === "filtered" ? "content_filter" : "max_output_tokens",
              },
              error:
                ending === "failed" ? { code: "server_error", message: "provider failed" } : null,
              output: calls,
              usage: { input_tokens: 20, output_tokens: 9, total_tokens: 29 },
            },
          };
        })(),
        response: new Response(null, { status: 200 }),
      });
      const stream = await createOpenAIResponsesTransportStreamFn()(
        model,
        { messages: [], tools: [] },
        {
          apiKey: "test-key",
          transport: "sse",
          asyncToolExecution: true,
          signal: controller.signal,
        } satisfies OpenAIResponsesOptions,
      );
      const events: string[] = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      const result = await stream.result();
      expect(events).not.toContain("toolcall_end");
      expect(events.filter((type) => type === "done" || type === "error")).toEqual(["error"]);
      expect(result.stopReason).toBe(ending === "aborted" ? "aborted" : "error");
      if (ending !== "eof" && ending !== "aborted" && ending !== "error") {
        expect(result.usage).toMatchObject({ input: 20, output: 9, totalTokens: 29 });
        expect(result.responseId).toBe("resp_parallel_truncated");
        expect(result.responseModel).toBe("served-model");
      }
      if (ending === "incomplete" || ending === "completed" || ending === "eof") {
        expect(result.errorCode).toBe(
          rejection === "incomplete" || rejection === "in_progress"
            ? "incomplete_tool_call"
            : "malformed_tool_call_arguments",
        );
        expect(result.errorMessage).toBe(
          rejection === "incomplete" || rejection === "in_progress"
            ? "Responses stream completed with an incomplete terminal tool call"
            : "Responses stream completed tool call with invalid JSON arguments",
        );
        if (rejection === "malformed" || rejection === "truncated") {
          expect(JSON.parse(result.errorBody ?? "null")).toMatchObject({
            code: "malformed_tool_call_arguments",
            argumentChars: calls[0]?.arguments.length,
            repairAttempted: false,
          });
        }
      } else {
        expect(result.errorCode).not.toBe("incomplete_tool_call");
        expect(result.errorCode).not.toBe("malformed_tool_call_arguments");
      }
      if (ending === "incomplete") {
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            type: "openai_responses_terminal",
            details: expect.objectContaining({
              eventType: "response.incomplete",
              incompleteReason: "max_output_tokens",
            }),
          }),
        );
      }
      if (ending === "filtered") {
        expect(result.errorMessage).toBe("Provider incomplete_reason: content_filter");
      } else if (ending === "failed") {
        expect(result.errorMessage).toContain("provider failed");
      } else if (ending === "error") {
        expect(result.errorMessage).toContain("provider stream error");
      }
    },
  );

  it.each(
    ["incomplete", "completed", "failed", "cancelled", "in_progress", "queued", undefined].flatMap(
      (status) => [false, true].map((itemDone) => ({ status, itemDone })),
    ),
  )(
    "retains usage and only recovers coherent output limits (status: $status, item done: $itemDone)",
    async ({ status, itemDone }) => {
      const partialCall = {
        type: "function_call",
        id: "fc_truncated",
        call_id: "call_truncated",
        name: "probe",
        arguments: '{"token":"unfinished',
        status: "incomplete",
      };
      sseState.outcomes.push({
        data: (async function* () {
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...partialCall, arguments: "", status: "in_progress" },
          };
          yield {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: partialCall.id,
            delta: partialCall.arguments,
          };
          if (itemDone) {
            yield { type: "response.output_item.done", output_index: 0, item: partialCall };
          }
          yield {
            type: "response.incomplete",
            response: {
              id: "resp_truncated",
              model: "served-model",
              ...(status === undefined ? {} : { status }),
              incomplete_details: { reason: "max_output_tokens" },
              output: [partialCall],
              usage: {
                input_tokens: 20,
                output_tokens: 9,
                total_tokens: 29,
                input_tokens_details: { cached_tokens: 4 },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            },
          };
        })(),
        response: new Response(null, { status: 200 }),
      });
      const options = { apiKey: "test-key", transport: "sse" } satisfies OpenAIResponsesOptions;
      const stream = await createOpenAIResponsesTransportStreamFn()(
        model,
        { messages: [], tools: [] },
        options,
      );
      const events: string[] = [];
      for await (const event of stream) {
        events.push(event.type);
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(events.filter((type) => type === "done" || type === "error")).toEqual(["error"]);
      expect(events).not.toContain("toolcall_end");
      expect(result.usage).toMatchObject({
        input: 16,
        cacheRead: 4,
        output: 9,
        totalTokens: 29,
        reasoningTokens: 3,
      });
      expect(result.errorCode).toBe("incomplete_tool_call");
      expect(isResponsesOutputLimitToolCallError(result)).toBe(
        status === undefined || status === "incomplete",
      );
      expect(result.responseId).toBe("resp_truncated");
      expect(result.responseModel).toBe("served-model");
      expect(result.diagnostics).toContainEqual({
        type: "openai_responses_terminal",
        timestamp: expect.any(Number),
        details: {
          eventType: "response.incomplete",
          stopReason:
            status === undefined || status === "incomplete"
              ? "length"
              : status === "failed" || status === "cancelled"
                ? "error"
                : "toolUse",
          incompleteReason: "max_output_tokens",
          endTurn: "absent",
        },
      });
    },
  );

  it.each(
    [
      "max_output_tokens",
      "max_messages",
      "content_filter",
      "steered",
      "provider-private-reason",
      undefined,
    ].flatMap((reason) => [false, true].map((activeTool) => ({ reason, activeTool }))),
  )(
    "preserves bounded incomplete diagnostics for $reason (active tool: $activeTool)",
    async ({ reason, activeTool }) => {
      sseState.outcomes.push({
        data: (async function* () {
          if (activeTool) {
            yield {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_filtered",
                call_id: "call_filtered",
                name: "probe",
                arguments: "",
                status: "in_progress",
              },
            };
          }
          yield {
            type: "response.incomplete",
            response: {
              id: "resp_filtered",
              status: "incomplete",
              incomplete_details: { reason },
            },
          };
        })(),
        response: new Response(null, { status: 200 }),
      });
      const options = {
        apiKey: "test-key",
        sessionId: "session-terminal-error",
        transport: "sse",
      } satisfies OpenAIResponsesOptions;
      const stream = await createOpenAIResponsesTransportStreamFn()(
        model,
        { messages: [], tools: [] },
        options,
      );
      const result = await stream.result();
      expect(result.stopReason).toBe(
        activeTool || reason === "content_filter" ? "error" : "length",
      );
      expect(result.errorCode).toBe(
        activeTool && reason !== "content_filter" ? "incomplete_tool_call" : undefined,
      );
      if (reason === "content_filter") {
        expect(result.errorMessage).toBe("Provider incomplete_reason: content_filter");
      }
      expect(result.diagnostics).toContainEqual({
        type: "openai_responses_terminal",
        timestamp: expect.any(Number),
        details: {
          eventType: "response.incomplete",
          stopReason: reason === "content_filter" ? "error" : "length",
          incompleteReason:
            reason === undefined || reason === "provider-private-reason" ? "unknown" : reason,
          endTurn: "absent",
        },
      });
      expect(JSON.stringify(result.diagnostics)).not.toContain("provider-private-reason");
    },
  );
});
