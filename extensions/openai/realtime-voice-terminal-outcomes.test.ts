import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceResponseOutcome } from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";
const responseId = "response_1";
const send = (ws: WebSocket, event: Record<string, unknown>) => ws.send(JSON.stringify(event));
const done = (response: Record<string, unknown>, id = responseId) => ({
  type: "response.done",
  response: { id, ...response },
});
const outcome = (status: string, details: Record<string, unknown> = {}) => ({
  responseId,
  status,
  ...details,
});
const failed = (message: string, details: Record<string, unknown> = {}) =>
  outcome("failed", {
    ...details,
    message: `OpenAI realtime voice response failed: ${message}`,
  });
async function capture(
  terminalEvent: Record<string, unknown>,
  options: { completeFollowup?: boolean; queueFollowup?: boolean; throwCallback?: boolean } = {},
) {
  const clientEvents: string[] = [];
  const errors: string[] = [];
  const events: string[] = [];
  const outcomes: RealtimeVoiceResponseOutcome[] = [];
  const tools: Array<{ itemId: string; callId: string; name: string; args: unknown }> = [];
  const responseCreated = createDeferred<void>();
  const terminalProcessed = createDeferred<void>();
  const followupCreated = createDeferred<void>();
  const followupCompleted = createDeferred<void>();
  const waitFor = (promise: Promise<void>, message: string) =>
    withTimeout(promise, 2_000, { message: `timed out waiting for ${message}` });
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });
  wss.on("connection", (ws) => {
    ws.on("message", (message) => {
      const event = JSON.parse(Buffer.from(message as Buffer).toString("utf8")) as {
        type?: string;
      };
      if (!event.type) {
        return;
      }
      clientEvents.push(event.type);
      if (event.type === "session.update" && clientEvents.length === 1) {
        send(ws, { type: "session.updated" });
      }
      if (event.type === "response.create") {
        followupCreated.resolve();
        if (options.completeFollowup) {
          send(ws, { type: "response.created", response: { id: "response_2" } });
          send(ws, done({ status: "completed", output: [] }, "response_2"));
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "fixture-value", azureEndpoint: `http://127.0.0.1:${port}` },
    onAudio() {},
    onClearAudio() {},
    onError: (error) => errors.push(error.message),
    onResponseDone: (result) => {
      outcomes.push(result);
      events.push(`outcome:${result.status}`);
      if (result.responseId === "response_2") {
        followupCompleted.resolve();
      }
      if (options.throwCallback && result.responseId === "response_1") {
        throw new Error("consumer callback failed");
      }
    },
    onToolCall: (tool) => {
      tools.push(tool);
      events.push(`tool:${tool.callId}`);
    },
    onEvent: (event) => {
      events.push(`${event.direction}:${event.type}`);
      if (event.direction === "server" && event.type === "response.created") {
        responseCreated.resolve();
      }
      if (event.direction === "server" && event.type === terminalEvent.type) {
        queueMicrotask(terminalProcessed.resolve);
      }
    },
  });
  try {
    await bridge.connect();
    const socket = [...wss.clients][0];
    if (!socket) {
      throw new Error("expected a connected fixture socket");
    }
    send(socket, { type: "response.created", response: { id: responseId } });
    await waitFor(responseCreated.promise, "response.created");
    if (options.queueFollowup) {
      bridge.sendUserMessage?.("Continue after the terminal response.");
    }
    send(socket, terminalEvent);
    await waitFor(terminalProcessed.promise, "terminal response");
    if (options.queueFollowup) {
      await waitFor(followupCreated.promise, "queued response.create");
    }
    if (options.completeFollowup) {
      await waitFor(followupCompleted.promise, "completed follow-up");
    }
    return { clientEvents, errors, events, outcomes, tools, connected: bridge.isConnected() };
  } finally {
    await bridge.close();
    for (const socket of wss.clients) {
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
  status: "completed",
  call_id: "call_tool",
  name: "lookup_weather",
  arguments: JSON.stringify({ city: "Paris" }),
};
const invalidStatus = (message: string) =>
  failed(message, {
    reason: "invalid_response_status",
    error: { type: "invalid_response_status", message },
  });
const rateLimit = { type: "server_error", code: "rate_limit_exceeded" };
const cancelled = { reason: "client_cancelled" };
const incomplete = outcome("incomplete", {
  reason: "max_output_tokens",
  message: "OpenAI realtime voice response incomplete: max_output_tokens",
});
describe("OpenAI realtime terminal response ownership", () => {
  it.each([
    ["completed", undefined, outcome("completed")],
    ["cancelled", cancelled, outcome("cancelled", cancelled)],
    ["failed", { error: rateLimit }, failed("rate_limit_exceeded", { error: rateLimit })],
    ["incomplete", { reason: "max_output_tokens" }, incomplete],
    [undefined, undefined, invalidStatus("missing terminal status")],
    ["in_progress", undefined, invalidStatus("invalid status in_progress")],
  ] as const)(
    "normalizes %s without closing the reusable socket",
    async (status, status_details, expected) => {
      const { clientEvents, events, ...actual } = await capture(
        done({ status, status_details, output: status === "completed" ? [] : [completedTool] }),
        { queueFollowup: true },
      );
      expect(actual).toEqual({ errors: [], outcomes: [expected], tools: [], connected: true });
      expect(clientEvents.filter((type) => type === "response.create")).toHaveLength(1);
      expect(events.indexOf(`outcome:${expected.status}`)).toBeLessThan(
        events.indexOf("server:response.done"),
      );
    },
  );

  it("delivers completed tools before their response owner is retired", async () => {
    const captured = await capture(done({ status: "completed", output: [completedTool] }));
    expect(captured.tools).toEqual([
      {
        itemId: "item_tool",
        callId: "call_tool",
        name: "lookup_weather",
        args: { city: "Paris" },
      },
    ]);
    expect(captured.events.indexOf("tool:call_tool")).toBeLessThan(
      captured.events.indexOf("outcome:completed"),
    );
  });

  it("drains a queued follow-up when the terminal consumer throws", async () => {
    const captured = await capture(done({ status: "failed", output: [] }), {
      completeFollowup: true,
      queueFollowup: true,
      throwCallback: true,
    });
    expect(captured.errors).toEqual([]);
    expect(captured.outcomes).toEqual([
      outcome("failed", { message: "OpenAI realtime voice response failed" }),
      { responseId: "response_2", status: "completed" },
    ]);
    expect(captured.clientEvents.filter((type) => type === "response.create")).toHaveLength(1);
    expect(captured.connected).toBe(true);
  });
});
