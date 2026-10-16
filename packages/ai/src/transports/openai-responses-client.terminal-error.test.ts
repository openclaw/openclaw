// The managed Responses transport must surface the provider's terminal error
// fact (e.g. content_filter) instead of collapsing it into a generic message;
// the generic string is classified as a transient timeout by failover and
// triggers pointless model rotation.
import type { AssistantMessageEventStreamLike } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
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
import { createModel } from "./openai-responses-prompt-observer.test-support.js";

const model = createModel({
  id: "test-responses",
  name: "Test Responses",
});

const initialHost = getAiTransportHost();
const logWarn = vi.fn();
const logDebug = vi.fn<typeof initialHost.logDebug>();
const logInfo = vi.fn<typeof initialHost.logInfo>();

function queueStream(data: AsyncIterable<unknown>) {
  sseState.outcomes.push({ data, response: new Response(null, { status: 200 }) });
}

function run(options: OpenAIResponsesOptions = {}) {
  return createOpenAIResponsesTransportStreamFn()(
    model,
    { messages: [], tools: [] },
    { apiKey: "test-key", transport: "sse", ...options },
  );
}

async function collect(stream: AssistantMessageEventStreamLike) {
  const events: string[] = [];
  for await (const event of stream) {
    events.push(event.type);
  }
  return { events, result: await stream.result() };
}

function terminalDiagnostic(details: Record<string, unknown>) {
  return { type: "openai_responses_terminal", timestamp: expect.any(Number), details };
}
beforeEach(() => {
  logWarn.mockClear();
  logDebug.mockClear();
  logInfo.mockClear();
  vi.stubEnv("OPENCLAW_DEBUG_MODEL_TRANSPORT", undefined);
  vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", undefined);
  vi.stubEnv("OPENCLAW_DEBUG_SSE", undefined);
  vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", undefined);
  configureAiTransportHost({ logWarn, logDebug, logInfo });
});
afterEach(() => {
  vi.unstubAllEnvs();
  configureAiTransportHost(initialHost);
});

describe("managed Responses transport terminal errors", () => {
  it("logs the actual output budget, served tier, and usage after a long incomplete stream", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_SSE", "peek");
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    queueStream(
      (async function* () {
        yield { type: "response.created", response: { id: "resp_long", service_tier: "default" } };
        yield {
          type: "response.output_text.delta",
          delta: "private-response-content",
          output_index: 0,
          content_index: 0,
          item_id: "msg_private",
        };
        now += 1_095_000;
        yield {
          type: "response.incomplete",
          response: {
            id: "resp_long",
            status: "incomplete",
            service_tier: "default",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
            usage: {
              input_tokens: 20,
              output_tokens: 4096,
              total_tokens: 4116,
              output_tokens_details: { reasoning_tokens: 4000 },
            },
          },
        };
      })(),
    );
    try {
      const stream = await run({ maxTokens: 4096, serviceTier: "priority" });
      expect((await stream.result()).stopReason).toBe("length");
      const messages = [
        ...logDebug.mock.calls.map(([, build]) => build()?.message),
        ...logInfo.mock.calls.map(([, message]) => message),
      ];
      const done = messages.find((message) => message?.startsWith("[responses] stream_done "));
      expect(done).toContain("requestedTier=priority max_output_tokens=4096");
      expect(done).toContain("responseId=resp_long servedTier=default");
      expect(done).toContain("outputTokens=4096 reasoningTokens=4000");
      expect(done).toContain("streamDurationMs=1095000 elapsedMs=1095000");
      expect(done).toContain("terminal=response.incomplete incompleteReason=max_output_tokens");
      expect(done).not.toContain("test-key");
      expect(messages.join(" ")).not.toContain("private-response-content");
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["filtered", "failed", "eof", "aborted"])(
    "fences later tool completions after truncated output until %s",
    async (ending) => {
      const controller = new AbortController();
      const calls = [0, 1].map((index) => ({
        type: "function_call",
        id: `fc_parallel_${index}`,
        call_id: `call_parallel_${index}`,
        name: "probe",
        arguments: index !== 0 ? '{"token":"complete"}' : '{"token":"unfinished',
        status: "completed",
        async: true,
      }));
      queueStream(
        (async function* () {
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
          if (ending === "aborted") {
            controller.abort(
              Object.assign(new Error("superseded"), {
                name: "AbortError",
                code: "AGENT_RUN_SUPERSEDED_ABORT",
              }),
            );
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
      );
      const { events, result } = await collect(
        await run({
          asyncToolExecution: true,
          signal: controller.signal,
        }),
      );
      expect(events).not.toContain("toolcall_end");
      expect(events.filter((type) => type === "done" || type === "error")).toEqual(["error"]);
      expect(result.stopReason).toBe(ending === "aborted" ? "aborted" : "error");
      if (ending === "aborted") {
        expect(logWarn).not.toHaveBeenCalled();
        expect(
          logDebug.mock.calls.some(
            ([subsystem, build]) =>
              subsystem === "openai-transport" &&
              build()?.message.startsWith("[responses] aborted "),
          ),
        ).toBe(true);
        expect(result.errorCode).toBe("AGENT_RUN_SUPERSEDED_ABORT");
      }
      if (ending !== "eof" && ending !== "aborted") {
        expect(result).toMatchObject({
          usage: { input: 20, output: 9, totalTokens: 29 },
          responseId: "resp_parallel_truncated",
          responseModel: "served-model",
        });
      }
      if (ending === "eof") {
        expect(result.errorCode).toBe("malformed_tool_call_arguments");
        expect(result.errorMessage).toBe(
          "Responses stream completed tool call with invalid JSON arguments",
        );
        expect(JSON.parse(result.errorBody ?? "null")).toMatchObject({
          code: "malformed_tool_call_arguments",
          argumentChars: calls[0]?.arguments.length,
          repairAttempted: false,
        });
      } else {
        expect(result.errorCode).not.toBe("incomplete_tool_call");
        expect(result.errorCode).not.toBe("malformed_tool_call_arguments");
      }
      if (ending === "filtered") {
        expect(result.errorMessage).toBe("Provider incomplete_reason: content_filter");
      } else if (ending === "failed") {
        expect(result.errorMessage).toContain("provider failed");
      }
    },
  );

  it("keeps a caller deadline at warning level when the stream throws a generic abort", async () => {
    const controller = new AbortController();
    queueStream(
      (async function* () {
        yield { type: "response.created", response: { id: "resp_timeout", status: "in_progress" } };
        controller.abort(new DOMException("run deadline", "TimeoutError"));
        throw new Error("Request was aborted");
      })(),
    );
    const stream = await run({ signal: controller.signal });

    expect((await stream.result()).stopReason).toBe("aborted");
    expect(logWarn).toHaveBeenCalledWith(
      "openai-transport",
      expect.stringContaining("[responses] error "),
      undefined,
    );
  });

  it.each([
    { status: "incomplete", itemDone: false },
    { status: "failed", itemDone: true },
    { status: "in_progress", itemDone: true },
    { status: undefined, itemDone: true },
  ])(
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
      queueStream(
        (async function* () {
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
      );
      const { events, result } = await collect(await run());
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
      expect(result).toMatchObject({ responseId: "resp_truncated", responseModel: "served-model" });
      expect(result.diagnostics).toContainEqual(
        terminalDiagnostic({
          eventType: "response.incomplete",
          stopReason:
            status === undefined || status === "incomplete"
              ? "length"
              : status === "failed"
                ? "error"
                : "toolUse",
          incompleteReason: "max_output_tokens",
          incompleteToolCallId: "call_truncated|fc_truncated",
          endTurn: "absent",
        }),
      );
    },
  );

  it.each([
    { reason: "content_filter", activeTool: false },
    { reason: "content_filter", activeTool: true },
    { reason: "provider-private-reason", activeTool: true },
    { reason: undefined, activeTool: false },
  ])(
    "preserves bounded incomplete diagnostics for $reason (active tool: $activeTool)",
    async ({ reason, activeTool }) => {
      queueStream(
        (async function* () {
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
      );
      const stream = await run({ sessionId: "session-terminal-error" });
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
      expect(result.diagnostics).toContainEqual(
        terminalDiagnostic({
          eventType: "response.incomplete",
          stopReason: reason === "content_filter" ? "error" : "length",
          incompleteReason:
            reason === undefined || reason === "provider-private-reason" ? "unknown" : reason,
          ...(activeTool ? { incompleteToolCallId: "call_filtered|fc_filtered" } : {}),
          endTurn: "absent",
        }),
      );
      expect(JSON.stringify(result.diagnostics)).not.toContain("provider-private-reason");
      if (result.stopReason === "error") {
        expect(logWarn).toHaveBeenCalledWith(
          "openai-transport",
          expect.stringContaining(
            `incompleteReason=${reason === undefined || reason === "provider-private-reason" ? "unknown" : reason}`,
          ),
          undefined,
        );
        expect(JSON.stringify(logWarn.mock.calls)).not.toContain("provider-private-reason");
      }
    },
  );
});
