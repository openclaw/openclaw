import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceResponseOutcome } from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type RealtimeOutcome = {
  callbackOrder: string[];
  errors: string[];
  outcomes: RealtimeVoiceResponseOutcome[];
  transcripts: Array<{ speaker: string; text: string; final: boolean }>;
  tools: Array<{ itemId: string; callId: string; name: string; args: unknown }>;
};

type CaptureRealtimeOutcomeOptions = {
  closeOnToolCall?: boolean;
  completeQueuedResponse?: boolean;
  queuedUserMessage?: string;
  onClientEvent?: (event: Record<string, unknown>) => void;
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
  };
  const serverEventHandled = createDeferred<void>();
  const responseCreatedHandled = createDeferred<void>();
  const queuedResponseCompleted = createDeferred<void>();
  const server = createServer();
  const sockets = new Set<WebSocket>();
  let queuedTurnTriggered = false;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("message", (message) => {
        const clientEvent = JSON.parse(Buffer.from(message as Buffer).toString("utf8")) as Record<
          string,
          unknown
        >;
        options.onClientEvent?.(clientEvent);
        if (clientEvent.type === "response.create" && options.queuedUserMessage) {
          if (options.completeQueuedResponse) {
            ws.send(JSON.stringify({ type: "response.created", response: { id: "response_2" } }));
            ws.send(JSON.stringify(terminal({ id: "response_2", status: "completed" })));
          }
          serverEventHandled.resolve();
          return;
        }
        if (
          clientEvent.type === "conversation.item.create" &&
          options.queuedUserMessage &&
          !queuedTurnTriggered
        ) {
          queuedTurnTriggered = true;
          for (const event of events) {
            ws.send(JSON.stringify(event));
          }
          return;
        }
        if (clientEvent.type !== "session.update") {
          return;
        }
        ws.send(JSON.stringify({ type: "session.updated" }));
        ws.send(JSON.stringify({ type: "response.created", response: { id: "response_1" } }));
        if (!options.queuedUserMessage) {
          for (const event of events) {
            ws.send(JSON.stringify(event));
          }
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const bridge = buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "fixture-value", baseUrl: `http://127.0.0.1:${port}/v1` },
    onAudio() {},
    onClearAudio() {},
    onError: (error) => outcome.errors.push(error.message),
    onResponseDone: (responseOutcome) => {
      outcome.callbackOrder.push("outcome");
      outcome.outcomes.push(responseOutcome);
      if (responseOutcome.responseId === "response_2") {
        queuedResponseCompleted.resolve();
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
      if (observed.direction === "server" && observed.type === "response.done") {
        outcome.callbackOrder.push("terminal");
      }
      if (observed.direction === "server" && observed.type === "response.created") {
        responseCreatedHandled.resolve();
      }
      if (observed.direction === "server" && observed.type === events.at(-1)?.type) {
        if (!options.queuedUserMessage) {
          serverEventHandled.resolve();
        }
      }
    },
  });

  try {
    await bridge.connect();
    if (options.queuedUserMessage) {
      await withTimeout(responseCreatedHandled.promise, 2_000, {
        message: "timed out waiting for response.created",
      });
      bridge.sendUserMessage?.(options.queuedUserMessage);
      await withTimeout(serverEventHandled.promise, 2_000, {
        message: "timed out waiting for the queued response.create",
      });
      if (options.completeQueuedResponse) {
        await withTimeout(queuedResponseCompleted.promise, 2_000, {
          message: "timed out waiting for the completed queued response",
        });
      }
    } else {
      await serverEventHandled.promise;
    }
    return outcome;
  } finally {
    await bridge.close();
    for (const socket of sockets) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
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

function terminal(response: Record<string, unknown>) {
  return { type: "response.done", response };
}

function scenario(
  name: string,
  event: Parameters<typeof captureRealtimeOutcome>[0],
  overrides: Partial<Pick<RealtimeOutcome, "errors" | "transcripts" | "tools">> = {},
) {
  return { name, event, expected: { errors: [], transcripts: [], tools: [], ...overrides } };
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

describe("xAI realtime terminal event ownership", () => {
  it("drains a queued follow-up when the terminal consumer throws", async () => {
    const outcome = await captureRealtimeOutcome(terminal({ id: "response_1", status: "failed" }), {
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

  it("flushes a queued turn after malformed terminal output over a real WebSocket", async () => {
    const clientEventTypes: string[] = [];

    const outcome = await captureRealtimeOutcome(
      terminal({ status: "completed", output: [null] }),
      {
        queuedUserMessage: "Continue after malformed terminal output.",
        onClientEvent: (event) => {
          if (typeof event.type === "string") {
            clientEventTypes.push(event.type);
          }
        },
      },
    );

    expect(outcome).toEqual({
      callbackOrder: ["outcome", "terminal"],
      errors: [],
      outcomes: [{ status: "completed" }],
      transcripts: [],
      tools: [],
    });
    expect(clientEventTypes).toEqual([
      "session.update",
      "conversation.item.create",
      "response.create",
    ]);
  });

  it("stops terminal output when a tool callback closes the bridge", async () => {
    const outcome = await captureRealtimeOutcome(
      {
        type: "response.done",
        response: {
          id: "response_1",
          status: "completed",
          output: [
            completedTool,
            { ...completedTool, id: "item_late", call_id: "call_late" },
            assistantAudio("late answer"),
          ],
        },
      },
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
      "preserves assistant transcripts carried only by terminal output",
      {
        type: "response.done",
        response: {
          status: "completed",
          output: [assistantAudio("terminal answer")],
        },
      },
      {
        transcripts: [{ speaker: "assistant", text: "terminal answer", final: true }],
      },
    ),
    scenario(
      "surfaces failed responses with provider error details",
      terminal({
        status: "failed",
        status_details: { error: { code: "rate_limit_exceeded" } },
      }),
      { errors: ["xAI realtime voice response failed: rate_limit_exceeded"] },
    ),
    scenario(
      "surfaces incomplete responses with their authoritative reason",
      terminal({ status: "incomplete", status_details: { reason: "max_output_tokens" } }),
      { errors: ["xAI realtime voice response incomplete: max_output_tokens"] },
    ),
    scenario(
      "does not mistake intentional cancellation for a provider failure",
      terminal({ status: "cancelled", status_details: { reason: "client_cancelled" } }),
    ),
    scenario("ignores output-item events and waits for canonical terminal output", {
      type: "response.output_item.done",
      item: completedTool,
    }),
    scenario(
      "buffers authoritative function-call arguments until response completion",
      toolArguments,
    ),
    scenario(
      "preserves required streamed-call timing when the response later fails",
      [toolArguments, { type: "response.done", response: { status: "failed", output: [] } }],
      { errors: ["xAI realtime voice response failed"] },
    ),
    scenario("does not dispatch incomplete replayed function-call items", {
      type: "conversation.item.created",
      item: { ...completedTool, status: "incomplete" },
    }),
    scenario(
      "recovers completed tool calls from terminal response output",
      terminal({ status: "completed", output: [completedTool] }),
      { tools: [expectedTool] },
    ),
    scenario(
      "does not recover terminal-output tool calls from a failed response",
      terminal({ status: "failed", output: [completedTool] }),
      { errors: ["xAI realtime voice response failed"] },
    ),
    scenario(
      "does not dispatch incomplete items from a completed terminal response",
      terminal({
        status: "completed",
        output: [{ ...completedTool, status: "incomplete" }],
      }),
    ),
    scenario(
      "fails closed when response status is missing",
      { type: "response.done", response: {} },
      {
        errors: ["xAI realtime voice response failed: missing terminal status"],
      },
    ),
    scenario(
      "fails closed when response status is invalid",
      { type: "response.done", response: { status: "in_progress" } },
      {
        errors: ["xAI realtime voice response failed: invalid status in_progress"],
      },
    ),
  ])("$name", async ({ event, expected }) => {
    const actual = await captureRealtimeOutcome(event);
    expect(actual.errors).toEqual([]);
    expect(actual.transcripts).toEqual(expected.transcripts);
    expect(actual.tools).toEqual(expected.tools);
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
    const rawStatus = responseDone.response?.status;
    if (
      rawStatus !== "completed" &&
      rawStatus !== "cancelled" &&
      rawStatus !== "failed" &&
      rawStatus !== "incomplete"
    ) {
      expect(actual.outcomes[0]).toMatchObject({
        status: "failed",
        reason: "invalid_response_status",
      });
    } else {
      expect(actual.outcomes[0]?.status).toBe(rawStatus);
    }
    if (expected.errors[0]) {
      expect(actual.outcomes[0]).toMatchObject({ message: expected.errors[0] });
    }
  });
});
