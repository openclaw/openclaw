import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceResponseOutcome } from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type RealtimeOutcome = {
  callbackOrder: string[];
  errors: string[];
  outcomes: RealtimeVoiceResponseOutcome[];
  transcripts: Array<{ speaker: string; text: string; final: boolean }>;
  tools: Array<{ itemId: string; callId: string; name: string; args: unknown }>;
  clientEvents: string[];
};

type CaptureRealtimeOutcomeOptions = {
  closeOnToolCall?: boolean;
  completeQueuedResponse?: boolean;
  queuedUserMessage?: string;
  throwOnResponseDone?: boolean;
};

async function captureRealtimeOutcome(
  eventInput: Record<string, unknown> | Record<string, unknown>[],
  options: CaptureRealtimeOutcomeOptions = {},
): Promise<RealtimeOutcome> {
  const events = Array.isArray(eventInput) ? eventInput : [eventInput];
  const outcome: RealtimeOutcome = {
    callbackOrder: [],
    errors: [],
    outcomes: [],
    transcripts: [],
    tools: [],
    clientEvents: [],
  };
  const finished = createDeferred<void>();
  const responseCreatedHandled = createDeferred<void>();
  const waitFor = (promise: Promise<void>, phase: string) =>
    withTimeout(promise, 2_000, { message: `timed out waiting for ${phase}` });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 * 1024 });
  wss.on("connection", (ws) => {
    const send = (...batch: Record<string, unknown>[]) =>
      batch.forEach((event) => ws.send(JSON.stringify(event)));
    let queuedTurnTriggered = false;
    ws.on("message", (message) => {
      const { type } = JSON.parse(message.toString()) as { type: string };
      outcome.clientEvents.push(type);
      if (type === "response.create" && options.queuedUserMessage) {
        if (options.completeQueuedResponse) {
          send(
            { type: "response.created", response: { id: "response_2" } },
            terminal("completed", { id: "response_2" }),
          );
        } else {
          finished.resolve();
        }
      } else if (
        type === "conversation.item.create" &&
        options.queuedUserMessage &&
        !queuedTurnTriggered
      ) {
        queuedTurnTriggered = true;
        send(...events);
      } else if (type === "session.update") {
        send(
          { type: "session.updated" },
          { type: "response.created", response: { id: "response_1" } },
          ...(options.queuedUserMessage ? [] : events),
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  const port = (wss.address() as AddressInfo).port;
  const bridge = buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "fixture-value", baseUrl: `http://127.0.0.1:${port}/v1` },
    onAudio() {},
    onClearAudio() {},
    onError: (error) => outcome.errors.push(error.message),
    onResponseDone: (responseOutcome) => {
      outcome.callbackOrder.push("outcome");
      outcome.outcomes.push(responseOutcome);
      if (responseOutcome.responseId === "response_2") {
        finished.resolve();
      }
      if (options.throwOnResponseDone && responseOutcome.responseId === "response_1") {
        throw new Error("consumer callback failed");
      }
    },
    onTranscript: (speaker, text, final) => {
      outcome.callbackOrder.push("transcript");
      outcome.transcripts.push({ speaker, text, final });
    },
    onToolCall: (tool) => {
      outcome.callbackOrder.push("tool");
      outcome.tools.push(tool);
      if (options.closeOnToolCall) {
        void bridge.close();
      }
    },
    onEvent: (observed) => {
      if (observed.direction !== "server") {
        return;
      }
      if (observed.type === "response.done") {
        outcome.callbackOrder.push("terminal");
      }
      if (observed.type === "response.created") {
        responseCreatedHandled.resolve();
      }
      if (observed.type === events.at(-1)?.type && !options.queuedUserMessage) {
        finished.resolve();
      }
    },
  });

  try {
    await bridge.connect();
    if (options.queuedUserMessage) {
      await waitFor(responseCreatedHandled.promise, "response.created");
      bridge.sendUserMessage?.(options.queuedUserMessage);
    }
    await (options.queuedUserMessage
      ? waitFor(finished.promise, "queued response completion")
      : finished.promise);
    return outcome;
  } finally {
    await bridge.close();
    for (const socket of wss.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  }
}

const completedTool = {
  id: "item_tool",
  type: "function_call",
  call_id: "call_tool",
  name: "lookup_weather",
  arguments: JSON.stringify({ city: "Paris" }),
};
const expectedTool = {
  itemId: "item_tool",
  callId: "call_tool",
  name: "lookup_weather",
  args: { city: "Paris" },
};

function terminal(status?: string, response: Record<string, unknown> = {}) {
  return {
    type: "response.done",
    response: status === undefined ? response : { status, ...response },
  };
}

function scenario(
  name: string,
  event: Parameters<typeof captureRealtimeOutcome>[0],
  expected: Partial<Pick<RealtimeOutcome, "errors" | "transcripts" | "tools">> = {},
) {
  return { name, event, expected };
}

function assistantAudio(transcript: string) {
  return { type: "message", role: "assistant", content: [{ type: "output_audio", transcript }] };
}

const toolArguments = {
  type: "response.function_call_arguments.done",
  item_id: completedTool.id,
  call_id: completedTool.call_id,
  name: completedTool.name,
  arguments: completedTool.arguments,
};

it("drains a queued follow-up when the terminal consumer throws", async () => {
  const outcome = await captureRealtimeOutcome(terminal("failed", { id: "response_1" }), {
    completeQueuedResponse: true,
    queuedUserMessage: "Continue after the terminal callback fails.",
    throwOnResponseDone: true,
  });

  expect(outcome.errors).toEqual([]);
  expect(outcome.outcomes).toEqual([
    {
      responseId: "response_1",
      status: "failed",
      message: "xAI realtime voice response failed",
    },
    { responseId: "response_2", status: "completed" },
  ]);
});

it("keeps valid terminal transcripts beside malformed output and flushes the queued turn", async () => {
  const outcome = await captureRealtimeOutcome(
    terminal("completed", {
      output: [
        null,
        {
          type: "message",
          role: "assistant",
          content: [
            null,
            { type: "output_text", text: "Valid text " },
            { type: "output_audio", transcript: "and audio" },
          ],
        },
      ],
    }),
    {
      queuedUserMessage: "Continue after malformed terminal output.",
    },
  );

  expect(outcome).toEqual({
    callbackOrder: ["transcript", "outcome", "terminal"],
    errors: [],
    outcomes: [{ status: "completed" }],
    transcripts: [{ speaker: "assistant", text: "Valid text and audio", final: true }],
    tools: [],
    clientEvents: ["session.update", "conversation.item.create", "response.create"],
  });
});

it("stops terminal output when a tool callback closes the bridge", async () => {
  const outcome = await captureRealtimeOutcome(
    terminal("completed", {
      id: "response_1",
      output: [
        completedTool,
        { ...completedTool, id: "item_late", call_id: "call_late" },
        assistantAudio("late answer"),
      ],
    }),
    { closeOnToolCall: true },
  );

  expect(outcome.errors).toEqual([]);
  expect(outcome.tools).toEqual([expectedTool]);
  expect(outcome.transcripts).toEqual([]);
  expect(outcome.outcomes).toEqual([{ responseId: "response_1", status: "completed" }]);
  expect(outcome.callbackOrder).toEqual(["tool", "outcome", "terminal"]);
});

it.each([
  scenario(
    "surfaces provider failure details",
    terminal("failed", { status_details: { error: { code: "rate_limit_exceeded" } } }),
    { errors: ["xAI realtime voice response failed: rate_limit_exceeded"] },
  ),
  scenario("ignores nonterminal output items", {
    type: "response.output_item.done",
    item: completedTool,
  }),
  scenario(
    "discards buffered and terminal calls after failure",
    [toolArguments, terminal("failed", { output: [completedTool] })],
    { errors: ["xAI realtime voice response failed"] },
  ),
  scenario("ignores incomplete replayed calls", {
    type: "conversation.item.created",
    item: { ...completedTool, status: "incomplete" },
  }),
  scenario(
    "ignores incomplete terminal calls",
    terminal("completed", { output: [{ ...completedTool, status: "incomplete" }] }),
  ),
])("$name", async ({ event, expected }) => {
  const actual = await captureRealtimeOutcome(event);
  expect(actual.errors).toEqual([]);
  expect(actual.transcripts).toEqual(expected.transcripts ?? []);
  expect(actual.tools).toEqual(expected.tools ?? []);
  const events = Array.isArray(event) ? event : [event];
  const responseDone = events.findLast((candidate) => candidate.type === "response.done") as
    | { response?: { status?: string } }
    | undefined;
  if (!responseDone) {
    expect(actual.outcomes).toEqual([]);
    return;
  }
  expect(actual.outcomes).toHaveLength(1);
  expect(actual.callbackOrder.slice(-2)).toEqual(["outcome", "terminal"]);
  expect(actual.outcomes[0]?.status).toBe(responseDone.response?.status);
  if (expected.errors?.[0]) {
    expect(actual.outcomes[0]).toMatchObject({ message: expected.errors[0] });
  }
});
