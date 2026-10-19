import { once } from "node:events";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { startQaMockOpenAiServer } from "./server.js";

type JsonObject = Record<string, unknown>;
type Request = JsonObject | string;
const cleanups: Array<() => Promise<void>> = [];
const QA_COMPACTION_RETRY_PROMPT =
  "Compaction retry mutating tool check. Current durable context marker: QA-COMPACTION-DURABLE-MARKER. Create compaction-retry-summary.txt.";
const QA_COMPACTION_SUMMARY_INSTRUCTIONS =
  "You are a context summarization assistant. Produce a structured summary. Do not continue.";

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startServer() {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => server.stop());
  return server;
}

async function connectResponsesWebSocket(baseUrl: string) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/u, "ws")}/v1/responses`);
  cleanups.push(async () => {
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  });
  await once(socket, "open");
  return socket;
}

async function startConnection() {
  const server = await startServer();
  const socket = await connectResponsesWebSocket(server.baseUrl);
  const send = (request: Request) => collectResponseEvents(socket, request);
  return {
    send,
    read: (prompt: string, extra = {}) =>
      send({ ...streaming, tools: readTool, input: userInput(prompt), ...extra }),
    complete: async (request: Request) => readCompletedResponse(await send(request)),
    debug: (path: string) => debugJson(server.baseUrl, path),
  };
}

const userInput = (text: string) => [{ role: "user", content: [{ type: "input_text", text }] }];
const readTool = [{ type: "function", name: "read" }];
const streaming = { model: "gpt-5.6-sol", stream: true };
const debugJson = async (baseUrl: string, path: string) =>
  await fetch(`${baseUrl}/debug/${path}`).then((response) => response.json());

async function collectResponseEvents(socket: WebSocket, request: Request) {
  return await new Promise<JsonObject[]>((resolve, reject) => {
    const events: JsonObject[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the mock Responses WebSocket"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      const event = JSON.parse(rawDataToString(data)) as JsonObject;
      events.push(event);
      if (event.type === "response.completed" || event.type === "error") {
        cleanup();
        resolve(events);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.send(
      typeof request === "string"
        ? request
        : JSON.stringify({ type: "response.create", ...request }),
    );
  });
}

function readCompletedResponse(events: JsonObject[]) {
  const completion = events.find((event) => event.type === "response.completed");
  expect(completion).toBeDefined();
  return completion?.response as JsonObject;
}

function expectError(events: JsonObject[], status: number, error: JsonObject, fields = {}) {
  expect(events).toEqual([expect.objectContaining({ type: "error", status, error, ...fields })]);
}

function functionOutput(callId: unknown, output: string) {
  return [{ type: "function_call_output", call_id: callId, output }];
}

it("holds one continuation across a disconnect without holding its replacement", async () => {
  const server = await startServer();
  const controller = new AbortController();
  const hold = server.holdNextContinuation("replacement-session", controller.signal);
  const socket = await connectResponsesWebSocket(server.baseUrl);
  const request = {
    type: "response.create",
    client_metadata: { session_id: "replacement-session" },
    input: [
      { role: "user", content: "Reply exactly: REPLACED-OK" },
      { type: "function_call_output", call_id: "retained-call", output: "done" },
    ],
  };
  try {
    socket.send(JSON.stringify(request));
    expect(await hold.reached).toEqual({
      cursor: 1,
      sessionId: "replacement-session",
      toolOutputCallId: "retained-call",
    });
    const closed = once(socket, "close");
    socket.terminate();
    await closed;
    const replacement = await connectResponsesWebSocket(server.baseUrl);
    const response = readCompletedResponse(await collectResponseEvents(replacement, request));
    expect(response.output).toMatchObject([{ content: [{ text: "REPLACED-OK" }] }]);
    const recorded = await debugJson(server.baseUrl, "requests");
    expect(recorded).toMatchObject([
      { cursor: 1, sessionId: "replacement-session", toolOutputCallId: "retained-call" },
      { cursor: 2, sessionId: "replacement-session", toolOutputCallId: "retained-call" },
    ]);
  } finally {
    controller.abort();
  }
});

it("reconstructs Codex previous-response deltas on the same reusable connection", async () => {
  const { send, read, debug } = await startConnection();
  const prompt = "Read README.md for the source and docs discovery report.";
  const firstEvents = await read(prompt);
  const firstResponse = readCompletedResponse(firstEvents);
  const output = firstResponse.output as JsonObject[];
  const toolCall = output.find((item) => item.type === "function_call");
  expect(toolCall?.call_id).toEqual(expect.any(String));
  const secondEvents = await send({
    ...streaming,
    previous_response_id: firstResponse.id,
    input: functionOutput(toolCall?.call_id, "README: source and docs evidence captured"),
  });
  for (const events of [firstEvents, secondEvents]) {
    expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  }
  const requests = (await debug("requests")) as JsonObject[];
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    prompt,
    toolOutput: "README: source and docs evidence captured",
    toolOutputCallId: toolCall?.call_id,
  });
});

it("preserves empty tool-result identity without replaying a native patch", async () => {
  const { complete, debug } = await startConnection();
  const prompt =
    "tool search qa check target=apply_patch. Call apply_patch exactly once and then summarize.";
  const initial = await complete({
    tools: [{ type: "custom", name: "apply_patch" }],
    input: userInput(prompt),
  });
  const call = (initial.output as JsonObject[])[0];
  expect(call).toMatchObject({ type: "custom_tool_call", name: "apply_patch" });
  const completed = await complete({
    previous_response_id: initial.id,
    input: [{ type: "custom_tool_call_output", call_id: call?.call_id, output: "" }],
  });
  expect(completed.output).toEqual([expect.objectContaining({ type: "message" })]);
  const recorded = await debug("last-request");
  expect(recorded).toMatchObject({ toolOutput: "", toolOutputCallId: call?.call_id });
  expect(recorded).not.toHaveProperty("plannedToolName");
});

it("preserves the full warmup prompt when the first real response sends an empty delta", async () => {
  const { send, read, debug } = await startConnection();
  const prompt = "Read README.md for the source and docs discovery report.";
  const warmup = await read(prompt, { generate: false });
  const events = await send({
    stream: true,
    previous_response_id: readCompletedResponse(warmup).id,
    input: [],
  });
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["response.output_item.done", "response.completed"]),
  );
  expect(await debug("last-request")).toMatchObject({
    model: "gpt-5.6-sol",
    prompt,
    plannedToolName: "read",
  });
  expect(await debug("request-cursor")).toEqual({ cursor: 1 });
});

it("preserves the injected post-tool 503 failure on the WebSocket transport", async () => {
  const { send, read, debug } = await startConnection();
  const prompt = "Provider HTTP 503 after tool QA check: read QA_KICKOFF_TASK.md, then reply.";
  const firstEvents = await read(prompt);
  const firstResponse = readCompletedResponse(firstEvents);
  const output = firstResponse.output as JsonObject[];
  const toolCall = output.find((item) => item.type === "function_call");
  const failure = await send({
    ...streaming,
    previous_response_id: firstResponse.id,
    input: functionOutput(toolCall?.call_id, "QA mission loaded"),
  });
  expectError(failure, 503, { type: "server_error", message: "Service Unavailable" });
  expectError(
    await send({
      previous_response_id: firstResponse.id,
      input: [],
    }),
    400,
    expect.objectContaining({ code: "previous_response_not_found" }),
    { sequence_number: 0 },
  );
  const requests = (await debug("requests")) as JsonObject[];
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ prompt, toolOutput: "QA mission loaded" });
});

it("preserves the coded compaction overflow on the WebSocket transport", async () => {
  const { send, debug } = await startConnection();
  const failure = await send({
    ...streaming,
    client_metadata: { session_id: "compaction-websocket" },
    input: userInput(`${QA_COMPACTION_RETRY_PROMPT}\n${"x".repeat(300_000)}`),
  });
  expectError(failure, 400, {
    type: "invalid_request_error",
    code: "context_length_exceeded",
    message: "This model's maximum context length was exceeded.",
  });
  const requests = await debug("requests");
  expect(requests).toEqual([
    expect.objectContaining({
      requestKind: "agent-initial",
      outcome: "error",
      errorCode: "context_length_exceeded",
      rawByteLength: expect.any(Number),
    }),
  ]);
});

it.each([
  {
    faultMode: "empty-output-once",
    marker: "QA-COMPACTION-EMPTY-OUTPUT-ONCE-websocket",
    recoveredMarker: "QA-COMPACTION-EMPTY-RECOVERED-SUMMARY",
  },
  {
    faultMode: "reasoning-only-output-once",
    marker: "QA-COMPACTION-REASONING-ONLY-OUTPUT-ONCE-websocket",
    recoveredMarker: "QA-COMPACTION-REASONING-RECOVERED-SUMMARY",
  },
] as const)("preserves $faultMode compaction recovery on WebSocket", async (testCase) => {
  const { complete, debug } = await startConnection();
  const request = {
    ...streaming,
    instructions: QA_COMPACTION_SUMMARY_INSTRUCTIONS,
    input: userInput(`<conversation>${testCase.marker}</conversation>`),
  };

  const first = await complete(request);
  expect(JSON.stringify(first.output)).not.toContain(testCase.recoveredMarker);
  const recovered = await complete(request);
  expect(JSON.stringify(recovered.output)).toContain(testCase.recoveredMarker);

  const requests = (await debug("requests")) as JsonObject[];
  expect(requests.map((entry) => entry.compactionSummaryFaultMode)).toEqual([
    testCase.faultMode,
    "none",
  ]);
});

it("returns a bounded protocol error for malformed WebSocket requests", async () => {
  const { send } = await startConnection();
  expectError(await send("{invalid-json"), 400, {
    type: "invalid_request_error",
    message: "Expected a JSON response.create request.",
  });
});
