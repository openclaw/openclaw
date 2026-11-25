import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceResponseOutcome,
} from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type CaptureRealtimeOutcomeOptions = {
  closeOnToolCall?: boolean;
  completeQueuedResponse?: boolean;
  queuedUserMessage?: string;
  throwOnResponseDone?: boolean;
};

async function captureRealtimeOutcome(
  eventInput: Record<string, unknown> | Record<string, unknown>[],
  options: CaptureRealtimeOutcomeOptions = {},
) {
  const events = Array.isArray(eventInput) ? eventInput : [eventInput];
  const callbackOrder: string[] = [];
  const errors: string[] = [];
  const outcomes: RealtimeVoiceResponseOutcome[] = [];
  const transcripts: Array<{ speaker: string; text: string; final: boolean }> = [];
  const tools: Parameters<NonNullable<RealtimeVoiceBridgeCreateRequest["onToolCall"]>>[0][] = [];
  const clientEvents: string[] = [];
  const finished = createDeferred<void>();
  const responseCreatedHandled = createDeferred<void>();
  const waitFor = (promise: Promise<void>, phase: string) =>
    withTimeout(promise, 2_000, { message: `timed out waiting for ${phase}` });
  let socket: WebSocket;
  const send = (...batch: Record<string, unknown>[]) =>
    batch.forEach((event) => socket.send(JSON.stringify(event)));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 * 1024 });
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (message) => {
      const { type } = JSON.parse(rawDataToString(message, "utf8")) as { type: string };
      clientEvents.push(type);
      if (type === "response.create" && options.queuedUserMessage) {
        if (options.completeQueuedResponse) {
          send(
            { type: "response.created", response: { id: "response_2" } },
            terminal("completed", { id: "response_2" }),
          );
        } else {
          finished.resolve();
        }
      } else if (type === "session.update") {
        send({ type: "session.updated" });
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
    onError: (error) => errors.push(error.message),
    onResponseDone: (responseOutcome) => {
      callbackOrder.push("outcome");
      outcomes.push(responseOutcome);
      if (responseOutcome.responseId === "response_2") {
        finished.resolve();
      }
      if (options.throwOnResponseDone && responseOutcome.responseId === "response_1") {
        throw new Error("consumer callback failed");
      }
    },
    onTranscript: (speaker, text, final) => {
      callbackOrder.push("transcript");
      transcripts.push({ speaker, text, final });
    },
    onToolCall: (tool) => {
      callbackOrder.push("tool");
      tools.push(tool);
      if (options.closeOnToolCall) {
        void bridge.close();
      }
    },
    onEvent: (observed) => {
      if (observed.direction !== "server") {
        return;
      }
      if (observed.type === "response.done") {
        callbackOrder.push("terminal");
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
    send({ type: "response.created", response: { id: "response_1" } });
    await waitFor(responseCreatedHandled.promise, "response.created");
    if (options.queuedUserMessage) {
      bridge.sendUserMessage?.(options.queuedUserMessage);
    }
    send(...events);
    await (options.queuedUserMessage
      ? waitFor(finished.promise, "queued response completion")
      : finished.promise);
    return { callbackOrder, errors, outcomes, transcripts, tools, clientEvents };
  } finally {
    await bridge.close();
    for (const client of wss.clients) {
      client.terminate();
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
  status?: "failed" | "completed",
  message?: string,
) {
  return { name, event, outcomes: status ? [{ status, ...(message ? { message } : {}) }] : [] };
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
    "failed",
    "xAI realtime voice response failed: rate_limit_exceeded",
  ),
  scenario("ignores nonterminal output items", {
    type: "response.output_item.done",
    item: completedTool,
  }),
  scenario(
    "discards buffered and terminal calls after failure",
    [toolArguments, terminal("failed", { output: [completedTool] })],
    "failed",
    "xAI realtime voice response failed",
  ),
  scenario("ignores incomplete replayed calls", {
    type: "conversation.item.created",
    item: { ...completedTool, status: "incomplete" },
  }),
  scenario(
    "ignores incomplete terminal calls",
    terminal("completed", { output: [{ ...completedTool, status: "incomplete" }] }),
    "completed",
  ),
])("$name", async ({ event, outcomes }) => {
  const actual = await captureRealtimeOutcome(event);
  expect(actual).toMatchObject({ errors: [], transcripts: [], tools: [], outcomes });
  if (outcomes.length) {
    expect(actual.callbackOrder.slice(-2)).toEqual(["outcome", "terminal"]);
  }
});
