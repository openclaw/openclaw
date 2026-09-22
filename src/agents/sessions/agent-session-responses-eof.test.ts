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
  { failure: "content_filter", recover: false },
  { failure: "unknown", recover: false },
  { failure: "completed", recover: false },
  { failure: "max_output_tokens", recover: false, retryEnabled: false },
])(
  "handles Responses $failure after settled tools (recovery: $recover)",
  async ({ failure, recover, retryEnabled }) => {
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
      if (requests.length === 2) {
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
          if (failure !== "eof") {
            yield {
              type: failure === "completed" ? "response.completed" : "response.incomplete",
              response: {
                id: "resp_incomplete",
                status: failure === "completed" ? "completed" : "incomplete",
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
        ).catch((error: unknown) => failTransportStream({ stream, output, error }));
        return stream;
      }
      return createAssistantResultStream(
        createAssistant(model, [{ type: "text", text: "Recovered using saved result." }]),
      );
    });
    const { session } = await createTestSession({
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
    expect(transportEvents).not.toContain("toolcall_end");
    expect(execute).toHaveBeenCalledOnce();
    expect(session.getLastAssistantText()).toBe(
      recover ? "Recovered using saved result." : undefined,
    );
    expect(requests).toHaveLength(recover ? 3 : 2);
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
      (model: Model, context: Context, options: SimpleStreamOptions) => {
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
