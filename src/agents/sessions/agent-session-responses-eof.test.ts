import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { processResponsesStream } from "../../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { failTransportStream } from "../../../packages/ai/src/transports/transport-stream-shared.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./agent-session-loop-correctness.test-support.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

it("recovers Responses EOF after tools without replaying settled or executing unfinished calls", async () => {
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
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
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
  expect(session.getLastAssistantText()).toBe("Recovered using saved result.");
  expect(requests).toHaveLength(3);
  expect(requests[2]?.messages.filter((message) => message.role === "toolResult")).toMatchObject([
    { toolCallId: "settled", content: [{ type: "text", text: "saved result" }] },
  ]);
});
