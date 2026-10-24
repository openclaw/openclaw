import { setImmediate } from "node:timers/promises";
import { Stream } from "openai/core/streaming";
import { createAssistantMessageEventStream, type Context } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import { processResponsesStream } from "../../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { failTransportStream } from "../../../packages/ai/src/transports/transport-stream-shared.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { textStream } from "./agent-session-boundary.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import type { ToolDefinition } from "./extensions/types.js";
import type { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();
const recovered = "Recovered using saved result.";

function responseCall(callId: string, args = "", status = "in_progress") {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name: "record",
    arguments: args,
    status,
  };
}

function outputItem<T>(type: "added" | "done", item: T, output_index = 0) {
  return { type: `response.output_item.${type}`, output_index, item };
}

function terminalResponse(type: string, output: unknown[], reason?: string, status = type) {
  return {
    type: `response.${type}`,
    response: {
      id: "resp_fixture",
      status,
      output,
      ...(reason ? { incomplete_details: { reason } } : {}),
    },
  };
}

function responseMessage(id: string, content: unknown[]) {
  return { type: "message", id, content };
}

async function* malformedSse(events: AsyncIterable<{ type: string }>) {
  const frames: string[] = [];
  for await (const event of events) {
    frames.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  yield* Stream.fromSSEResponse(
    new Response(`${frames.join("")}data: {malformed\n\n`),
    new AbortController(),
  );
}

function failedMessages(manager: SessionManager) {
  return manager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error"
        ? [entry.message]
        : [],
    );
}

function createRetrySession(execute?: ToolDefinition["execute"], enabled = true) {
  return createTestSession({
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled, maxRetries: 1, baseDelayMs: 1 },
    }),
    customTools: execute
      ? [
          {
            ...createStubTool("record"),
            execute,
          },
          // Async tool calls need sessions_yield to collect their results.
          { ...createStubTool("sessions_yield"), async: false },
        ]
      : undefined,
  });
}

it.each([
  { failure: "eof", recover: true },
  { failure: "malformed_sse", recover: true },
  { failure: "malformed_sse", recover: false, repeatFailure: true },
  { failure: "malformed_sse", recover: false, retryEnabled: false },
  { failure: "max_output_tokens", recover: true },
  { failure: "max_output_tokens", responseStatus: "completed", recover: false },
  { failure: "content_filter", recover: false },
  { failure: "unknown", recover: false },
  { failure: "completed", recover: false },
  { failure: "max_output_tokens", recover: false, retryEnabled: false },
  { failure: "identity_type", recover: true },
  { failure: "identity_call", recover: true },
  { failure: "identity_call", recover: false, retryEnabled: false },
  { failure: "identity_call", recover: false, repeatFailure: true },
  { failure: "identity_call", recover: false, beforeConflict: "text" },
  { failure: "identity_call", recover: false, beforeConflict: "erased-text" },
  { failure: "identity_call", recover: false, beforeConflict: "erased-refusal" },
  { failure: "identity_call", recover: true, beforeConflict: "empty-text" },
  { failure: "identity_call", recover: false, beforeConflict: "function" },
  { failure: "identity_call", recover: false, beforeConflict: "provider" },
  { failure: "identity_call", recover: false, unprovenRequest: true },
  { failure: "identity_content_filter", recover: false },
  { failure: "identity_early_filter", recover: false },
  { failure: "identity_early_failed", recover: false },
  { failure: "identity_terminal_refusal", recover: false },
])(
  "handles Responses $failure after settled tools (status: $responseStatus, recovery: $recover, repeated: $repeatFailure, output: $beforeConflict)",
  async ({
    failure,
    recover,
    retryEnabled,
    responseStatus,
    repeatFailure,
    beforeConflict,
    unprovenRequest,
  }) => {
    const identityFailure = failure.startsWith("identity_");
    const filteredConflict = failure === "identity_content_filter";
    const earlyConflict =
      failure === "identity_early_filter" || failure === "identity_early_failed";
    const terminalRefusal = failure === "identity_terminal_refusal";
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "saved result" }],
      details: {},
    }));
    const requests: Context["messages"][] = [];
    const transportEvents: string[] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push([...context.messages]);
      if (requests.length === 1) {
        return createAssistantResultStream(
          createAssistant(
            model,
            [{ type: "toolCall", id: "settled", name: "record", arguments: {} }],
            "toolUse",
          ),
        );
      }
      if (requests.length === 2 || (repeatFailure && requests.length > 2)) {
        const stream = createAssistantMessageEventStream();
        const output = createAssistant(model, []);
        const events = (async function* () {
          yield outputItem("added", responseCall("unfinished"));
          yield {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_unfinished",
            delta: '{"value":',
          };
          if (identityFailure) {
            if (earlyConflict) {
              yield outputItem("done", {
                ...responseCall("unfinished", "{}", "completed"),
                call_id: "different_call",
              });
              yield terminalResponse(
                failure === "identity_early_failed" ? "failed" : "incomplete",
                [],
                "content_filter",
              );
              return;
            }
            if (beforeConflict) {
              const erased =
                beforeConflict === "erased-text" || beforeConflict === "erased-refusal";
              const item =
                beforeConflict === "function"
                  ? responseCall("completed", "{}", "completed")
                  : beforeConflict === "provider"
                    ? { type: "mcp_call", id: "mcp_completed", status: "completed" }
                    : responseMessage(
                        "msg_partial",
                        erased
                          ? []
                          : [
                              {
                                type: "output_text",
                                text: beforeConflict === "text" ? "Partial answer" : "",
                              },
                            ],
                      );
              if (beforeConflict === "function" || erased) {
                yield outputItem("added", item, 1);
              }
              if (erased) {
                yield {
                  type:
                    beforeConflict === "erased-refusal"
                      ? "response.refusal.delta"
                      : "response.output_text.delta",
                  output_index: 1,
                  content_index: 0,
                  item_id: "msg_partial",
                  delta: "Partial answer",
                };
              }
              yield outputItem("done", erased ? { ...item, content: [] } : item, 1);
            }
            yield terminalResponse(
              filteredConflict ? "incomplete" : "completed",
              [
                filteredConflict
                  ? {
                      type: "reasoning",
                      id: "rs_conflicting",
                      encrypted_content: "test-encrypted-placeholder",
                      summary: [],
                    }
                  : failure === "identity_type"
                    ? responseMessage("msg_conflicting", [])
                    : {
                        ...responseCall("unfinished", "{}", "completed"),
                        call_id: "different_call",
                      },
                ...(terminalRefusal
                  ? [responseMessage("msg_refusal", [{ type: "refusal", refusal: "Declined" }])]
                  : []),
              ],
              filteredConflict ? "content_filter" : undefined,
            );
            return;
          }
          if (failure !== "eof" && failure !== "malformed_sse") {
            yield terminalResponse(
              failure === "completed" ? "completed" : "incomplete",
              [responseCall("unfinished", '{"value":', "incomplete")],
              failure,
              responseStatus,
            );
          }
        })();
        // Use the real SDK parser for malformed wire data, not a fabricated error.
        const source = failure === "malformed_sse" ? malformedSse(events) : events;
        void processResponsesStream(
          source,
          output,
          {
            push: (event) => {
              transportEvents.push(event.type);
              stream.push(event);
            },
          },
          model,
          unprovenRequest ? undefined : { canRetryIdentityConflict: () => true },
        ).catch((error: unknown) => failTransportStream({ stream, output, error }));
        return stream;
      }
      return textStream(model, recovered);
    });
    const { session, sessionManager } = await createRetrySession(execute, retryEnabled);

    await session.prompt("Record once and report the result.");

    expect(transportEvents).toContain("toolcall_start");
    if (beforeConflict === "erased-text" || beforeConflict === "erased-refusal") {
      expect(transportEvents).toContain("text_delta");
    }
    expect(transportEvents.includes("toolcall_end")).toBe(beforeConflict === "function");
    expect(execute).toHaveBeenCalledOnce();
    expect(session.getLastAssistantText()).toBe(
      recover ? recovered : beforeConflict === "text" ? "Partial answer" : undefined,
    );
    expect(requests).toHaveLength(recover || repeatFailure ? 3 : 2);
    if (identityFailure) {
      const recorded = failedMessages(sessionManager).at(-1);
      expect(recorded).toMatchObject({ errorCode: "responses_output_identity_conflict" });
      expect(JSON.parse(recorded?.errorBody ?? "{}")).toMatchObject({
        eventType: earlyConflict
          ? "response.output_item.done"
          : filteredConflict
            ? "response.incomplete"
            : "response.completed",
        outputIndex: 0,
        expectedType: "function_call",
        actualType: filteredConflict
          ? "reasoning"
          : failure === "identity_type"
            ? "message"
            : "function_call",
        mismatch: filteredConflict || failure === "identity_type" ? "type" : "call_id",
        completedToolCall: beforeConflict === "function",
        retrySafe:
          !filteredConflict &&
          !earlyConflict &&
          !terminalRefusal &&
          (!beforeConflict || beforeConflict === "empty-text") &&
          !unprovenRequest,
      });
    }
    if (!recover) {
      return;
    }
    expect(requests[2]?.filter((message) => message.role === "toolResult")).toMatchObject([
      { toolCallId: "settled", content: [{ type: "text", text: "saved result" }] },
    ]);
  },
);

it.each(["recover", "exhaust", "cancel", "cancel-retry", "terminate"])(
  "settles same-response tools before %s",
  async (mode) => {
    let started = createDeferred();
    let finish = createDeferred();
    const providerFailures = [createDeferred(), createDeferred()] as const;
    const requests: Context["messages"][] = [];
    const events: AgentSessionEvent[] = [];
    const execute = vi.fn(async (_id: string, _args: unknown, signal?: AbortSignal) => {
      started.resolve();
      await finish.promise;
      expect(signal?.aborted).toBe(
        mode === "cancel" || (mode === "cancel-retry" && requests.length === 2),
      );
      return {
        content: [{ type: "text" as const, text: "saved result" }],
        details: {},
        ...(mode === "terminate" ? { terminate: true } : {}),
      };
    });
    streamMocks.streamSimple.mockImplementation((model, context, options) => {
      requests.push([...context.messages]);
      const requestNumber = requests.length;
      if (requestNumber > (mode === "exhaust" || mode === "cancel-retry" ? 2 : 1)) {
        return textStream(model, recovered);
      }
      started = createDeferred();
      finish = createDeferred();
      const stream = createAssistantMessageEventStream();
      const output = createAssistant(model, []);
      stream.push({ type: "start", partial: output });
      const providerEvents = (async function* () {
        yield outputItem("done", {
          ...responseCall("settled", "{}", "completed"),
          call_id: `settled-${requestNumber}`,
          async: true,
        });
        await started.promise;
        yield outputItem("added", responseCall("unfinished"), 1);
        yield terminalResponse(
          "incomplete",
          [responseCall("unfinished", '{"value":', "incomplete")],
          "max_output_tokens",
        );
      })();
      void processResponsesStream(providerEvents, output, stream, model, options).catch(
        (error: unknown) => {
          failTransportStream({ stream, output, error });
          providerFailures[requestNumber === 1 ? 0 : 1].resolve();
        },
      );
      return stream;
    });
    const { session, sessionManager } = await createRetrySession(execute);
    session.subscribe((event) => events.push(event));
    const pending = session.prompt("Record once and report the result.");
    try {
      const failureCount = mode === "exhaust" || mode === "cancel-retry" ? 2 : 1;
      for (const [index, failure] of providerFailures.slice(0, failureCount).entries()) {
        await failure.promise;
        await setImmediate();
        expect(requests).toHaveLength(index + 1);
        expect(events.filter((event) => event.type === "auto_retry_start")).toHaveLength(index);
        expect(
          events.filter(
            (event) =>
              event.type === "message_end" &&
              event.message.role === "assistant" &&
              event.message.stopReason === "error",
          ),
        ).toHaveLength(index);
        if (mode === "cancel" || (mode === "cancel-retry" && index === 1)) {
          void session.abort();
        }
        finish.resolve();
      }
      await pending;
      expect(execute).toHaveBeenCalledTimes(mode === "exhaust" || mode === "cancel-retry" ? 2 : 1);
      expect(requests).toHaveLength(mode === "cancel" || mode === "terminate" ? 1 : 2);
      if (mode !== "recover") {
        expect(session.getLastAssistantText()).toBeUndefined();
        expect(events.filter((event) => event.type === "auto_retry_end")).toEqual(
          mode === "exhaust" || mode === "cancel-retry" ? [{ type: "auto_retry_end" }] : [],
        );
        return;
      }
      expect(session.getLastAssistantText()).toBe(recovered);
      expect(requests[1]?.filter((message) => message.role === "assistant")).toMatchObject([
        { stopReason: "toolUse", content: [{ type: "toolCall", id: "settled-1|fc_settled" }] },
        { stopReason: "error", content: [], errorCode: "incomplete_tool_call" },
      ]);
      expect(requests[1]?.filter((message) => message.role === "toolResult")).toMatchObject([
        { toolCallId: "settled-1|fc_settled", content: [{ type: "text", text: "saved result" }] },
      ]);
      expect(events.filter((event) => event.type === "auto_retry_end")).toEqual([
        { type: "auto_retry_end" },
      ]);
      expect(failedMessages(sessionManager)).toMatchObject([
        {
          errorCode: "incomplete_tool_call",
          diagnostics: [
            {
              type: "openai_responses_terminal",
              details: { incompleteReason: "max_output_tokens" },
            },
          ],
        },
      ]);
    } finally {
      finish.resolve();
      await session.abort();
      await pending;
    }
  },
);

it.each(["", "Partial response before the disconnect"])(
  "preserves a failed assistant through retry and transcript replay: %j",
  async (partialText) => {
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream({
        ...createAssistant(
          model,
          requests.length === 1 ? partialText : "Recovered response",
          requests.length === 1 ? "error" : "stop",
        ),
        ...(requests.length === 1 ? { errorMessage: "HTTP 503 temporary failure" } : {}),
      });
    });
    const { session, sessionManager } = await createRetrySession();
    await session.prompt("Original request");

    expect(requests).toHaveLength(2);
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: partialText }],
        stopReason: "error",
        errorMessage: "HTTP 503 temporary failure",
      }),
    );
    expect(session.messages).toEqual(sessionManager.buildSessionContext().messages);

    session.dispose();
    const reopened = await createTestSession({ sessionManager });
    await reopened.session.prompt("Next request");
    expect(requests).toHaveLength(3);
    expect(requests[2]?.slice(0, requests[1]?.length)).toEqual(requests[1]);
  },
);
