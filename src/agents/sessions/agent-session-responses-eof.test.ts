import { setImmediate } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { processResponsesStream } from "../../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { failTransportStream } from "../../../packages/ai/src/transports/transport-stream-shared.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it.each([
  { failure: "eof", recover: true },
  { failure: "max_output_tokens", recover: true },
  { failure: "max_output_tokens", responseStatus: "absent", recover: true },
  ...["completed", "failed", "cancelled", "in_progress", "queued"].map((responseStatus) => ({
    failure: "max_output_tokens",
    responseStatus,
    recover: false,
  })),
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
    const requests: Context[] = [];
    const transportEvents: string[] = [];
    streamMocks.streamSimple.mockImplementation((model: Model, context: Context) => {
      requests.push({ ...context, messages: [...context.messages] });
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
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_unfinished",
              call_id: "unfinished",
              name: "record",
              arguments: "",
              status: "in_progress",
            },
          };
          yield {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_unfinished",
            delta: '{"value":',
          };
          if (identityFailure) {
            if (earlyConflict) {
              yield {
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "function_call",
                  id: "fc_unfinished",
                  call_id: "different_call",
                  name: "record",
                  arguments: "{}",
                  status: "completed",
                },
              };
              yield {
                type:
                  failure === "identity_early_failed" ? "response.failed" : "response.incomplete",
                response: {
                  id: "resp_rejected",
                  status: failure === "identity_early_failed" ? "failed" : "incomplete",
                  incomplete_details: { reason: "content_filter" },
                  output: [],
                },
              };
              return;
            }
            if (beforeConflict) {
              const erased =
                beforeConflict === "erased-text" || beforeConflict === "erased-refusal";
              const item =
                beforeConflict === "text" || beforeConflict === "empty-text" || erased
                  ? {
                      type: "message",
                      id: "msg_partial",
                      content: erased
                        ? []
                        : [
                            {
                              type: "output_text",
                              text: beforeConflict === "text" ? "Partial answer" : "",
                            },
                          ],
                    }
                  : beforeConflict === "function"
                    ? {
                        type: "function_call",
                        id: "fc_completed",
                        call_id: "completed",
                        name: "record",
                        arguments: "{}",
                        status: "completed",
                      }
                    : { type: "mcp_call", id: "mcp_completed", status: "completed" };
              if (beforeConflict === "function") {
                yield { type: "response.output_item.added", output_index: 1, item };
              }
              if (erased) {
                yield { type: "response.output_item.added", output_index: 1, item };
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
              yield {
                type: "response.output_item.done",
                output_index: 1,
                item: erased ? { ...item, content: [] } : item,
              };
            }
            yield {
              type: filteredConflict ? "response.incomplete" : "response.completed",
              response: {
                id: "resp_conflicting",
                status: filteredConflict ? "incomplete" : "completed",
                ...(filteredConflict ? { incomplete_details: { reason: "content_filter" } } : {}),
                output: [
                  filteredConflict
                    ? {
                        type: "reasoning",
                        id: "rs_conflicting",
                        encrypted_content: "test-encrypted-placeholder",
                        summary: [],
                      }
                    : failure === "identity_type"
                      ? { type: "message", id: "msg_conflicting", content: [] }
                      : {
                          type: "function_call",
                          id: "fc_unfinished",
                          call_id: "different_call",
                          name: "record",
                          arguments: "{}",
                          status: "completed",
                        },
                  ...(terminalRefusal
                    ? [
                        {
                          type: "message",
                          id: "msg_refusal",
                          content: [{ type: "refusal", refusal: "Declined" }],
                        },
                      ]
                    : []),
                ],
              },
            };
            return;
          }
          if (failure !== "eof") {
            yield {
              type: failure === "completed" ? "response.completed" : "response.incomplete",
              response: {
                id: "resp_incomplete",
                ...(responseStatus === "absent"
                  ? {}
                  : {
                      status:
                        responseStatus ?? (failure === "completed" ? "completed" : "incomplete"),
                    }),
                incomplete_details: { reason: failure },
                output: [
                  {
                    type: "function_call",
                    id: "fc_unfinished",
                    call_id: "unfinished",
                    name: "record",
                    arguments: '{"value":',
                    status: "incomplete",
                  },
                ],
              },
            };
          }
        })();
        void processResponsesStream(
          events,
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
      return createAssistantResultStream(
        createAssistant(model, [{ type: "text", text: "Recovered using saved result." }]),
      );
    });
    const { session, sessionManager } = await createTestSession({
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: retryEnabled ?? true, maxRetries: 1, baseDelayMs: 1 },
      }),
      customTools: [
        {
          name: "record",
          label: "Record",
          description: "Records a fixture action",
          parameters: Type.Object({}),
          execute,
        },
      ],
    });

    await session.prompt("Record once and report the result.");

    expect(transportEvents).toContain("toolcall_start");
    if (beforeConflict === "erased-text" || beforeConflict === "erased-refusal") {
      expect(transportEvents).toContain("text_delta");
    }
    expect(transportEvents.includes("toolcall_end")).toBe(beforeConflict === "function");
    expect(execute).toHaveBeenCalledOnce();
    expect(session.getLastAssistantText()).toBe(
      recover
        ? "Recovered using saved result."
        : beforeConflict === "text"
          ? "Partial answer"
          : undefined,
    );
    expect(requests).toHaveLength(recover || repeatFailure ? 3 : 2);
    if (identityFailure) {
      const recorded = sessionManager
        .getBranch()
        .findLast(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "assistant" &&
            entry.message.stopReason === "error",
        );
      expect(recorded).toMatchObject({
        message: { errorCode: "responses_output_identity_conflict" },
      });
      if (recorded?.type !== "message" || recorded.message.role !== "assistant") {
        throw new Error("Missing recorded identity conflict");
      }
      expect(JSON.parse(recorded.message.errorBody ?? "{}")).toMatchObject({
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
    expect(requests[2]?.messages.filter((message) => message.role === "toolResult")).toMatchObject([
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
    const requests: Context[] = [];
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
    streamMocks.streamSimple.mockImplementation(
      (model: Model, context: Context, options?: SimpleStreamOptions) => {
        requests.push({ ...context, messages: [...context.messages] });
        const requestNumber = requests.length;
        if (requestNumber > (mode === "exhaust" || mode === "cancel-retry" ? 2 : 1)) {
          return createAssistantResultStream(
            createAssistant(model, [{ type: "text", text: "Recovered using saved result." }]),
          );
        }
        started = createDeferred();
        finish = createDeferred();
        const stream = createAssistantMessageEventStream();
        const output = createAssistant(model, []);
        stream.push({ type: "start", partial: output });
        const providerEvents = (async function* () {
          yield {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_settled",
              call_id: `settled-${requestNumber}`,
              name: "record",
              arguments: "{}",
              status: "completed",
              async: true,
            },
          };
          await started.promise;
          yield {
            type: "response.output_item.added",
            output_index: 1,
            item: {
              type: "function_call",
              id: "fc_unfinished",
              call_id: "unfinished",
              name: "record",
              arguments: "",
              status: "in_progress",
            },
          };
          yield {
            type: "response.incomplete",
            response: {
              id: "resp_incomplete",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [
                {
                  type: "function_call",
                  id: "fc_unfinished",
                  call_id: "unfinished",
                  name: "record",
                  arguments: '{"value":',
                  status: "incomplete",
                },
              ],
            },
          };
        })();
        void processResponsesStream(providerEvents, output, stream, model, options).catch(
          (error: unknown) => {
            failTransportStream({ stream, output, error });
            providerFailures[requestNumber === 1 ? 0 : 1].resolve();
          },
        );
        return stream;
      },
    );
    const { session, sessionManager } = await createTestSession({
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      }),
      customTools: [
        {
          name: "record",
          label: "Record",
          description: "Records once",
          parameters: Type.Object({}),
          execute,
        },
      ],
    });
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
          mode === "exhaust" || mode === "cancel-retry"
            ? [expect.objectContaining({ success: false, attempt: 1 })]
            : [],
        );
        return;
      }
      expect(session.getLastAssistantText()).toBe("Recovered using saved result.");
      expect(requests[1]?.messages.filter((message) => message.role === "assistant")).toMatchObject(
        [{ stopReason: "toolUse", content: [{ type: "toolCall", id: "settled-1|fc_settled" }] }],
      );
      expect(
        requests[1]?.messages.filter((message) => message.role === "toolResult"),
      ).toMatchObject([
        { toolCallId: "settled-1|fc_settled", content: [{ type: "text", text: "saved result" }] },
      ]);
      expect(events.filter((event) => event.type === "auto_retry_end")).toMatchObject([
        { success: true, attempt: 1 },
      ]);
      const recordedFailures = sessionManager
        .getBranch()
        .flatMap((entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "error"
            ? [entry.message]
            : [],
        );
      expect(recordedFailures).toMatchObject([
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
